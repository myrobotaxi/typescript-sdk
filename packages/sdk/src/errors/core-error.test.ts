import { describe, expect, it } from 'vitest';
import type { ErrorPayload } from '@myrobotaxi/contracts/types';

import {
  isReauthRequired,
  isRetryable,
  isTerminal,
  restErrorToCoreError,
  wsErrorToCoreError,
  type CoreError,
  type CoreErrorCode,
  type ReauthRequiredError,
} from './core-error';

// Every code in the union, with its expected catalog classification.
const EXPECTATIONS: Record<CoreErrorCode, { retryable: boolean; terminal: boolean }> = {
  auth_failed: { retryable: false, terminal: true },
  auth_timeout: { retryable: true, terminal: false },
  permission_denied: { retryable: false, terminal: true },
  vehicle_not_owned: { retryable: false, terminal: true },
  rate_limited: { retryable: true, terminal: false },
  internal_error: { retryable: true, terminal: false },
  snapshot_required: { retryable: true, terminal: false },
  not_found: { retryable: false, terminal: true },
  invalid_request: { retryable: false, terminal: true },
  service_unavailable: { retryable: true, terminal: false },
};

// The shared wire enum (everything except the SDK-declared REST-only
// service_unavailable).
const WIRE_CODES: ErrorPayload['code'][] = [
  'auth_failed',
  'auth_timeout',
  'permission_denied',
  'vehicle_not_owned',
  'rate_limited',
  'internal_error',
  'snapshot_required',
  'not_found',
  'invalid_request',
];

describe('wsErrorToCoreError — every shared code round-trips', () => {
  it.each(WIRE_CODES)('maps ws code %s with catalog classification', (code) => {
    const e = wsErrorToCoreError({ code, message: 'x' } as ErrorPayload);
    expect(e.code).toBe(code);
    expect(e.transport).toBe('ws');
    expect(e.retryable).toBe(EXPECTATIONS[code].retryable);
    expect(e.terminal).toBe(EXPECTATIONS[code].terminal);
    expect(isTerminal(e)).toBe(EXPECTATIONS[code].terminal);
    expect(isRetryable(e)).toBe(EXPECTATIONS[code].retryable);
  });
});

describe('restErrorToCoreError — shared + REST-only codes', () => {
  it.each(WIRE_CODES)('maps rest code %s', (code) => {
    const e = restErrorToCoreError(code, 400, { message: 'x' });
    expect(e.code).toBe(code);
    expect(e.transport).toBe('rest');
    expect(e.httpStatus).toBe(400);
    expect(e.retryable).toBe(EXPECTATIONS[code].retryable);
  });

  it('maps the SDK-declared REST-only service_unavailable (HTTP 503)', () => {
    const e = restErrorToCoreError('service_unavailable', 503, { retryAfterSec: 30 });
    expect(e.code).toBe('service_unavailable');
    expect(e.retryable).toBe(true);
    expect(e.terminal).toBe(false);
    if (e.code === 'service_unavailable') expect(e.retryAfterSec).toBe(30);
  });
});

describe('subCode overrides', () => {
  it('auth_failed + reauth_required → terminal, NOT retryable (MYR-82 carve-out)', () => {
    const e = restErrorToCoreError('auth_failed', 401, { subCode: 'reauth_required' });
    expect(e.code).toBe('auth_failed');
    expect(e.terminal).toBe(true);
    expect(e.retryable).toBe(false);
    if (e.code === 'auth_failed') expect(e.subCode).toBe('reauth_required');
  });

  it('plain auth_failed (no subCode) is terminal but carries no subCode', () => {
    const e = wsErrorToCoreError({ code: 'auth_failed', message: 'bad token' } as ErrorPayload);
    if (e.code === 'auth_failed') expect(e.subCode).toBeUndefined();
  });

  it('rate_limited + device_cap → terminal, NOT retryable (surface "too many devices")', () => {
    const e = wsErrorToCoreError({
      code: 'rate_limited',
      message: 'cap',
      subCode: 'device_cap',
    } as ErrorPayload);
    expect(e.terminal).toBe(true);
    expect(e.retryable).toBe(false);
    if (e.code === 'rate_limited') expect(e.subCode).toBe('device_cap');
  });

  it('plain rate_limited (no subCode) → retryable with extended backoff', () => {
    const e = restErrorToCoreError('rate_limited', 429, { retryAfterSec: 12 });
    expect(e.retryable).toBe(true);
    expect(e.terminal).toBe(false);
    if (e.code === 'rate_limited') expect(e.retryAfterSec).toBe(12);
  });
});

describe('cross-transport equivalence (single union)', () => {
  it('same code → same classification regardless of carrier', () => {
    for (const code of WIRE_CODES) {
      const ws = wsErrorToCoreError({ code, message: 'm' } as ErrorPayload);
      const rest = restErrorToCoreError(code, 500, { message: 'm' });
      expect(ws.code).toBe(rest.code);
      expect(ws.retryable).toBe(rest.retryable);
      expect(ws.terminal).toBe(rest.terminal);
    }
  });
});

describe('message is never used for branching (FR-7.1)', () => {
  it('defaults message to the code when absent; consumers branch on code', () => {
    const e = wsErrorToCoreError({ code: 'internal_error' } as ErrorPayload);
    expect(e.message).toBe('internal_error');
    // Discriminated-union narrowing works on `code`:
    const handled: CoreError = e;
    if (handled.code === 'internal_error') expect(handled.retryable).toBe(true);
  });
});

describe('isReauthRequired guard (MYR-82)', () => {
  it('true only for auth_failed + subCode reauth_required', () => {
    const reauth = restErrorToCoreError('auth_failed', 401, {
      subCode: 'reauth_required',
    });
    expect(isReauthRequired(reauth)).toBe(true);
  });

  it('false for plain auth_failed (no subCode) — the retryable carve-in', () => {
    const plain = restErrorToCoreError('auth_failed', 401, {});
    expect(isReauthRequired(plain)).toBe(false);
  });

  it('false for unrelated codes incl. the other subCode override', () => {
    expect(isReauthRequired(restErrorToCoreError('not_found', 404, {}))).toBe(false);
    expect(isReauthRequired(restErrorToCoreError('internal_error', 500, {}))).toBe(false);
    expect(
      isReauthRequired(restErrorToCoreError('rate_limited', 429, { subCode: 'device_cap' })),
    ).toBe(false);
  });

  it('narrows the type so consumers route without re-checking the union', () => {
    const e: CoreError = wsErrorToCoreError({
      code: 'auth_failed',
      message: 'stale auth_time',
      subCode: 'reauth_required',
    } as ErrorPayload);
    if (isReauthRequired(e)) {
      const narrowed: ReauthRequiredError = e; // compile-time narrowing proof
      expect(narrowed.code).toBe('auth_failed');
      expect(narrowed.subCode).toBe('reauth_required');
      expect(narrowed.terminal).toBe(true);
      expect(narrowed.retryable).toBe(false);
    } else {
      throw new Error('guard should have matched');
    }
  });
});
