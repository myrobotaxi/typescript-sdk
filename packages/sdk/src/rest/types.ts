// REST client types (MYR-80). Every caller returns a discriminated
// result — protocol errors never throw (FR-7.1).

import type { Logger } from '../observability/logger.js';
import type { MetricsRecorder } from '../observability/metrics.js';
import type { CoreError } from '../errors/core-error.js';

export type RestResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: CoreError };

/** Cursor-paginated list envelope (rest-api.md §4.2.1). */
export interface Paginated<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** `getToken` may be asked to force a fresh token (one-shot 401 retry,
 *  FR-6.2). Consumers whose callback ignores the arg still satisfy this. */
export type GetToken = (opts?: { forceRefresh?: boolean }) => Promise<string>;

export interface RestClientOptions {
  /** Base origin, e.g. `https://telemetry.example.com`. Endpoint paths
   *  are derived from this single config — no hardcoded paths in feature
   *  modules. */
  readonly baseUrl: string;
  readonly getToken: GetToken;
  readonly logger?: Logger;
  readonly metrics?: MetricsRecorder;
  /** Injected for tests; defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Max attempts for retryable statuses (429/500). rest-api.md §4.1.2
   *  caps REST at 3. */
  readonly maxAttempts?: number;
}

export interface RequestOpts {
  readonly signal?: AbortSignal;
}
