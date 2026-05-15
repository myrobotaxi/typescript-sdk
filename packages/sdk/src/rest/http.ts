// Core REST request engine (MYR-80). One place for: token injection,
// the 401 retry / reauth_required carve-out (FR-6.2 / rest-api.md
// §4.1.1), 429+500 backoff with a 3-attempt cap (§4.1.2), AbortSignal,
// and CoreError mapping (MYR-52). Feature modules are thin wrappers.

import { computeBackoffMs } from '../client/backoff.js';
import { restErrorToCoreError } from '../errors/core-error.js';
import type { CoreError, CoreErrorCode, CoreErrorSubCode } from '../errors/core-error.js';
import type { Logger } from '../observability/logger.js';
import { ConsoleLogger } from '../observability/logger.js';
import { RedactingLogger } from '../observability/redacting-logger.js';
import type { MetricsRecorder } from '../observability/metrics.js';
import { Metric } from '../observability/metrics.js';
import type { GetToken, RequestOpts, RestClientOptions, RestResult } from './types.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const ACCEPT_VERSION = '1';

const NOOP_METRICS: MetricsRecorder = {
  counter() {
    /* no-op */
  },
  histogram() {
    /* no-op */
  },
  gauge() {
    /* no-op */
  },
};

interface ErrorEnvelope {
  error?: { code?: string; message?: string; subCode?: string | null };
}

export class HttpCore {
  private readonly baseUrl: string;
  private readonly getToken: GetToken;
  private readonly logger: Logger;
  private readonly metrics: MetricsRecorder;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;

  constructor(opts: RestClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.getToken = opts.getToken;
    this.logger = new RedactingLogger(opts.logger ?? new ConsoleLogger());
    this.metrics = opts.metrics ?? NOOP_METRICS;
    const f = opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) {
      throw new Error('No fetch implementation: pass `fetchImpl` (Node < 18 or custom).');
    }
    this.fetchImpl = f;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  }

  async request<T>(
    method: string,
    path: string,
    opts: RequestOpts & { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<RestResult<T>> {
    const url = this.buildUrl(path, opts.query);
    let attempt = 0;
    let didAuthRetry = false;

    for (;;) {
      attempt += 1;
      const started = Date.now();
      let token: string;
      try {
        token = await this.getToken({ forceRefresh: didAuthRetry });
      } catch (err) {
        this.logger.error('rest: getToken rejected', {
          err: err instanceof Error ? err.message : String(err),
        });
        return {
          ok: false,
          error: restErrorToCoreError('auth_failed', 401, { message: 'getToken failed' }),
        };
      }

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Accept-Version': ACCEPT_VERSION,
            Accept: 'application/json',
            ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: opts.signal,
        });
      } catch (err) {
        if (isAbortError(err)) {
          return {
            ok: false,
            error: restErrorToCoreError('internal_error', 0, { message: 'aborted' }),
          };
        }
        // Network failure — treated like a transient internal_error.
        if (attempt < this.maxAttempts) {
          await this.delay(computeBackoffMs(attempt), opts.signal);
          continue;
        }
        return {
          ok: false,
          error: restErrorToCoreError('internal_error', 0, {
            message: err instanceof Error ? err.message : 'network error',
          }),
        };
      } finally {
        this.metrics.histogram(Metric.REST_REQUEST_DURATION_MS, Date.now() - started, {
          endpoint: path,
          status: 'pending',
        });
      }

      if (res.ok) {
        const data = (await safeJson(res)) as T;
        return { ok: true, data };
      }

      const env = (await safeJson(res)) as ErrorEnvelope;
      const code = (env.error?.code ?? statusToCode(res.status)) as CoreErrorCode;
      const subCode = (env.error?.subCode ?? undefined) as CoreErrorSubCode | undefined;
      const retryAfterSec = parseRetryAfter(res.headers.get('Retry-After'));
      const core = restErrorToCoreError(code, res.status, {
        message: env.error?.message,
        subCode,
        retryAfterSec,
      });

      // 401 auth_failed: one forced-refresh retry — UNLESS reauth_required
      // (rest-api.md §4.1.1: a silent getToken() can't satisfy auth_time;
      // surface to the consumer's auth layer instead — MYR-79/82 carve-out).
      if (
        res.status === 401 &&
        core.code === 'auth_failed' &&
        subCode !== 'reauth_required' &&
        !didAuthRetry
      ) {
        didAuthRetry = true;
        attempt -= 1; // the forced-refresh retry doesn't consume a backoff slot
        continue;
      }

      // 429 / 500: bounded exponential backoff (§4.1.2 — cap 3).
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxAttempts) {
        const waitMs =
          retryAfterSec !== undefined ? retryAfterSec * 1000 : computeBackoffMs(attempt);
        this.metrics.counter(Metric.REST_REQUEST_DURATION_MS, {
          endpoint: path,
          status: String(res.status),
        });
        await this.delay(waitMs, opts.signal);
        continue;
      }

      return { ok: false, error: core };
    }
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const u = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }
}

export type { RestResult, CoreError };

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const n = Number(h);
  return Number.isFinite(n) ? n : undefined;
}

function statusToCode(status: number): CoreErrorCode {
  switch (status) {
    case 401:
      return 'auth_failed';
    case 403:
      return 'permission_denied';
    case 404:
      return 'not_found';
    case 400:
      return 'invalid_request';
    case 429:
      return 'rate_limited';
    case 503:
      return 'service_unavailable';
    default:
      return 'internal_error';
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}
