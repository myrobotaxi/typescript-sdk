import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpCore } from './http';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('HttpCore — auth + retry (FR-6.2 / rest-api §4.1.1)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends Bearer token + Accept-Version, returns ok on 200', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { hello: 'world' }));
    const http = new HttpCore({
      baseUrl: 'https://t.example',
      getToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await http.request<{ hello: string }>('GET', '/api/x');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.hello).toBe('world');
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect((init.headers as Record<string, string>)['Accept-Version']).toBe('1');
  });

  it('401 auth_failed (no subCode) → one forced-refresh retry, then succeeds', async () => {
    let calls = 0;
    const tokens: string[] = [];
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(401, { error: { code: 'auth_failed', message: 'expired' } })
        : jsonResponse(200, { ok: 1 });
    });
    const http = new HttpCore({
      baseUrl: 'https://t.example',
      getToken: async (o) => {
        tokens.push(o?.forceRefresh ? 'fresh' : 'cached');
        return 't';
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await http.request('GET', '/api/x');
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect(tokens).toEqual(['cached', 'fresh']); // 2nd call forced refresh
  });

  it('reauth_required → NO getToken retry, terminal CoreError (MYR-79/82 carve-out)', async () => {
    let tokenCalls = 0;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, {
        error: { code: 'auth_failed', message: 'reauth', subCode: 'reauth_required' },
      }),
    );
    const http = new HttpCore({
      baseUrl: 'https://t.example',
      getToken: async () => {
        tokenCalls += 1;
        return 't';
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await http.request('GET', '/api/x');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('auth_failed');
      expect(r.error.terminal).toBe(true);
      expect(r.error.retryable).toBe(false);
    }
    expect(tokenCalls).toBe(1); // only the initial token; NO refresh retry
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('second 401 (after refresh) is terminal', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { error: { code: 'auth_failed', message: 'still bad' } }),
    );
    const http = new HttpCore({
      baseUrl: 'https://t.example',
      getToken: async () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await http.request('GET', '/api/x');
    expect(r.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // initial + 1 forced-refresh retry
  });
});

describe('HttpCore — backoff (rest-api §4.1.2, cap 3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('429 retries with backoff, caps at maxAttempts', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, { error: { code: 'rate_limited', message: 'slow down' } }),
    );
    const http = new HttpCore({
      baseUrl: 'https://t.example',
      getToken: async () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAttempts: 3,
    });
    const p = http.request('GET', '/api/x');
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('honors Retry-After header', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls < 2
        ? jsonResponse(429, { error: { code: 'rate_limited', message: 'x' } }, { 'Retry-After': '5' })
        : jsonResponse(200, { ok: 1 });
    });
    const http = new HttpCore({
      baseUrl: 'https://t.example',
      getToken: async () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const p = http.request('GET', '/api/x');
    await vi.advanceTimersByTimeAsync(5000);
    const r = await p;
    expect(r.ok).toBe(true);
  });

  it('500 retries with exponential backoff, caps at 3', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(500, { error: { code: 'internal_error', message: 'boom' } }),
    );
    const http = new HttpCore({
      baseUrl: 'https://t.example',
      getToken: async () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const p = http.request('GET', '/api/x');
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('internal_error');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('HttpCore — AbortSignal', () => {
  it('aborted fetch returns a CoreError, does not throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError');
    });
    const http = new HttpCore({
      baseUrl: 'https://t.example',
      getToken: async () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await http.request('GET', '/api/x', { signal: AbortSignal.abort() });
    expect(r.ok).toBe(false);
  });

  it('abort DURING backoff returns a CoreError, never throws (W1/FR-7.1)', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, { error: { code: 'rate_limited', message: 'slow' } }),
    );
    const ctrl = new AbortController();
    const http = new HttpCore({
      baseUrl: 'https://t.example',
      getToken: async () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const p = http.request('GET', '/api/x', { signal: ctrl.signal });
    await vi.advanceTimersByTimeAsync(10); // first 429 received, now in backoff
    ctrl.abort(); // fire mid-backoff
    const r = await p; // MUST resolve, not reject
    expect(r.ok).toBe(false);
    vi.useRealTimers();
  });
});

describe('HttpCore — getToken + network failure paths', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('getToken() rejection → terminal auth_failed CoreError (no throw)', async () => {
    const http = new HttpCore({
      baseUrl: 'https://t.example',
      getToken: async () => {
        throw new Error('idp down');
      },
      fetchImpl: (async () => jsonResponse(200, {})) as unknown as typeof fetch,
    });
    const r = await http.request('GET', '/api/x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('auth_failed');
  });

  it('network error retries with backoff, caps at maxAttempts', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const http = new HttpCore({
      baseUrl: 'https://t.example',
      getToken: async () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAttempts: 3,
    });
    const p = http.request('GET', '/api/x');
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('internal_error');
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 + 2 backoff retries
  });
});
