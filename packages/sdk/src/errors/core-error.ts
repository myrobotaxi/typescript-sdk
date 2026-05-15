// Typed CoreError union (MYR-52).
//
// Consumers branch on `error.code` (a stable enum) and NEVER string-match
// on `error.message` (FR-7.1). The union spans both transports: the same
// code maps to the same variant whether it arrived over WebSocket or REST,
// so consumer code is a single switch (rest-api.md §4.1.1, websocket-
// protocol.md §6.1.1).
//
// `retryable` (FR-7.2) and `terminal` (FR-7.3) are derived from the
// catalog, not hand-set per call site.

import type { ErrorPayload } from '@myrobotaxi/contracts/types';

/** The shared wire enum, plus the one SDK-declared REST-only code that is
 *  intentionally NOT in the shared schema enum (rest-api.md:258 — the WS
 *  503 analogue is a close code, not a typed frame). */
export type CoreErrorCode = ErrorPayload['code'] | 'service_unavailable';

export type CoreErrorSubCode = NonNullable<ErrorPayload['subCode']>;

export type Transport = 'ws' | 'rest';

interface CoreErrorBase {
  /** Stable typed code — the only thing consumers should branch on. */
  readonly code: CoreErrorCode;
  /** Dev-facing description. NEVER branch on this (FR-7.1); never P1. */
  readonly message: string;
  /** Which carrier delivered it. Diagnostic only — behaviour MUST NOT
   *  differ by transport for a shared code (websocket-protocol §6.1.1). */
  readonly transport: Transport;
  /** Auto-retry eligible (FR-7.2). Transient → true; the SDK retries
   *  with backoff. Terminal → false; surfaces to the consumer. */
  readonly retryable: boolean;
  /** Surfaces to the UI as a terminal condition (FR-7.3). */
  readonly terminal: boolean;
  /** HTTP status when delivered over REST. */
  readonly httpStatus?: number;
}

export type CoreError =
  | (CoreErrorBase & { code: 'auth_failed'; subCode?: 'reauth_required' })
  | (CoreErrorBase & { code: 'auth_timeout' })
  | (CoreErrorBase & { code: 'permission_denied' })
  | (CoreErrorBase & { code: 'vehicle_not_owned' })
  | (CoreErrorBase & { code: 'rate_limited'; subCode?: 'device_cap'; retryAfterSec?: number })
  | (CoreErrorBase & { code: 'internal_error' })
  | (CoreErrorBase & { code: 'snapshot_required' })
  | (CoreErrorBase & { code: 'not_found' })
  | (CoreErrorBase & { code: 'invalid_request' })
  | (CoreErrorBase & { code: 'service_unavailable'; retryAfterSec?: number });

// ---- compile-time exhaustiveness (MYR-52 AC) ---------------------------
// If a code is added to the shared schema enum (regenerated ErrorPayload)
// without a matching CoreError variant here, `_exhaustive` fails to
// compile — `Exclude` becomes non-`never`. This is the AC's "adding a new
// code to the catalog without updating the union is a TypeScript error".
type _MissingVariant = Exclude<CoreErrorCode, CoreError['code']>;
type _ExtraVariant = Exclude<CoreError['code'], CoreErrorCode>;
type _Exhaustive = [_MissingVariant, _ExtraVariant] extends [never, never]
  ? true
  : ['CoreError union out of sync with ErrorPayload enum', _MissingVariant, _ExtraVariant];
// Force evaluation: this line is a type error if the union drifts.
const _assertExhaustive: _Exhaustive = true;
void _assertExhaustive;

// ---- catalog classification (FR-7.2 / FR-7.3) --------------------------
// Sources: rest-api.md §4.1.1 catalog + websocket-protocol.md §6.1.1.

interface Classification {
  readonly retryable: boolean;
  readonly terminal: boolean;
}

const CATALOG: Record<CoreErrorCode, Classification> = {
  // Surface to UI; consumer must re-auth (one getToken() retry is the
  // transport layer's concern, not an auto-retry of the error itself).
  auth_failed: { retryable: false, terminal: true },
  // Transient: client missed the auth deadline → auto-retry w/ backoff.
  auth_timeout: { retryable: true, terminal: false },
  // Authn ok, authz denied → surface, do not auto-retry.
  permission_denied: { retryable: false, terminal: true },
  vehicle_not_owned: { retryable: false, terminal: true },
  // Extended backoff (rest-api §4.1.2 / ws §6.1.1). device_cap subCode
  // overrides to terminal (handled in the mappers below).
  rate_limited: { retryable: true, terminal: false },
  internal_error: { retryable: true, terminal: false },
  // Re-run the reconnect sequence (re-fetch snapshot) — retryable.
  snapshot_required: { retryable: true, terminal: false },
  // REST-only: unknown/filtered resource — surface, do not retry.
  not_found: { retryable: false, terminal: true },
  // REST-only: malformed request (developer error) — surface, no retry.
  invalid_request: { retryable: false, terminal: true },
  // REST-only: maintenance/shutdown — retry with backoff, honor Retry-After.
  service_unavailable: { retryable: true, terminal: false },
};

/** Terminal errors surface to the consumer UI (FR-7.3). */
export function isTerminal(error: CoreError): boolean {
  return error.terminal;
}

/** Retryable errors are auto-retried by the SDK with backoff (FR-7.2). */
export function isRetryable(error: CoreError): boolean {
  return error.retryable;
}

interface MapInput {
  readonly message?: string;
  readonly subCode?: CoreErrorSubCode;
  readonly httpStatus?: number;
  readonly retryAfterSec?: number;
}

function build(code: CoreErrorCode, transport: Transport, input: MapInput): CoreError {
  const cls = CATALOG[code];
  const base: CoreErrorBase = {
    code,
    message: input.message ?? code,
    transport,
    retryable: cls.retryable,
    terminal: cls.terminal,
    httpStatus: input.httpStatus,
  };

  switch (code) {
    case 'auth_failed': {
      // reauth_required is NEVER eligible for the silent getToken() retry
      // path — surface it so the consumer's auth layer triggers a fresh
      // interactive sign-in (rest-api.md §4.1.1 / §7.6-§7.7, MYR-82).
      const reauth = input.subCode === 'reauth_required';
      return reauth
        ? { ...base, code, subCode: 'reauth_required', retryable: false, terminal: true }
        : { ...base, code };
    }
    case 'rate_limited': {
      // device_cap (per-user concurrent-session cap) is terminal-ish: do
      // NOT auto-retry; surface an actionable "too many devices" signal.
      const deviceCap = input.subCode === 'device_cap';
      return deviceCap
        ? { ...base, code, subCode: 'device_cap', retryable: false, terminal: true }
        : { ...base, code, retryAfterSec: input.retryAfterSec };
    }
    case 'service_unavailable':
      return { ...base, code, retryAfterSec: input.retryAfterSec };
    case 'auth_timeout':
    case 'permission_denied':
    case 'vehicle_not_owned':
    case 'internal_error':
    case 'snapshot_required':
    case 'not_found':
    case 'invalid_request':
      return { ...base, code };
  }
}

/** Map a WebSocket `error` frame payload to a typed CoreError. */
export function wsErrorToCoreError(payload: ErrorPayload): CoreError {
  return build(payload.code, 'ws', {
    message: payload.message,
    subCode: payload.subCode,
  });
}

/**
 * Map a REST error envelope to a typed CoreError. `service_unavailable`
 * has no shared-schema enum member (rest-api.md:258) so it is accepted
 * here as an SDK-declared REST-only code keyed off HTTP 503.
 */
export function restErrorToCoreError(
  code: CoreErrorCode,
  httpStatus: number,
  opts: { message?: string; subCode?: CoreErrorSubCode; retryAfterSec?: number } = {},
): CoreError {
  return build(code, 'rest', {
    message: opts.message,
    subCode: opts.subCode,
    httpStatus,
    retryAfterSec: opts.retryAfterSec,
  });
}
