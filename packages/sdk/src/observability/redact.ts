// P1 redaction at the log boundary (FR-11.2 — non-negotiable, security-critical).
//
// Source of truth: myrobotaxi/telemetry/docs/contracts/data-classification.md
// §1.1–§1.7 (P1 catalog) and §2.1 (VIN special case).
//
// Why this exists: P1 values (GPS, addresses, names, emails, tokens, route
// polylines) MUST NOT appear in any logged metadata. This module is the
// SDK-wide boundary that consumers cannot bypass — every log path runs
// through RedactingLogger, which delegates to redactP1 below.

/** Sentinel string substituted in place of any P1 value. */
export const REDACTED = '[REDACTED]' as const;

/**
 * Keys (in normalized form — lowercased, underscores stripped) that ALWAYS
 * redact to `[REDACTED]`. Per data-classification.md §1.1–§1.7. The
 * normalization at lookup time means both `access_token` and `accessToken`
 * are caught by the single entry `accesstoken`.
 */
const P1_KEYS: ReadonlySet<string> = new Set([
  // GPS coordinates (vehicle-state-schema §1.3 + drive route points §1.5).
  'latitude',
  'longitude',
  'lat',
  'lng',
  'destinationlatitude',
  'destinationlongitude',
  'originlatitude',
  'originlongitude',

  // Addresses and named locations (Vehicle §1.3, Drive §1.4, TripStop §1.7).
  'locationname',
  'locationaddress',
  'destinationname',
  'destinationaddress',
  'startlocation',
  'startaddress',
  'endlocation',
  'endaddress',

  // Route polylines (Vehicle.navRouteCoordinates §1.3, Drive.routePoints §1.4,
  // plus the `routeCoordinates` variant some call sites use). These are
  // arrays-of-objects; the whole container is redacted via the containment
  // rule below — but we also catch them by key name in case a consumer
  // pulls one out into a sibling field.
  'navroutecoordinates',
  'routepoints',
  'routecoordinates',

  // License plate (Vehicle §1.3).
  'licenseplate',

  // User PII (User §1.1 + Invite §1.6). `image` is a user avatar URL.
  'email',
  'useremail',
  'name',
  'username',
  'image',

  // OAuth tokens (Account §1.2). Cover camelCase + snake_case via key
  // normalization at lookup time, so both `accessToken` and `access_token`
  // hit the same entry.
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
]);

/**
 * VIN is classified P0 but has a special-case redaction rule per
 * data-classification.md §2.1: "VINs MUST be redacted to `***XXXX`
 * (last 4 characters) in all log output and error messages." Handled
 * separately from the P1 set so we can produce the truncated form
 * rather than `[REDACTED]`.
 */
const VIN_KEYS: ReadonlySet<string> = new Set(['vin']);

/** Normalize a key for lookup: lowercase + strip underscores. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/_/g, '');
}

function isP1Key(key: string): boolean {
  return P1_KEYS.has(normalizeKey(key));
}

function isVinKey(key: string): boolean {
  return VIN_KEYS.has(normalizeKey(key));
}

/** Tail-4 truncation for VIN values; falls back to [REDACTED] for non-strings. */
function redactVin(value: unknown): string {
  if (typeof value !== 'string' || value.length < 4) return REDACTED;
  return `***${value.slice(-4)}`;
}

/**
 * Returns true if `value` (when walked recursively) contains any P1 key.
 * Used to implement the §1.5 containment rule: a container with a P1
 * descendant is itself P1, so we redact the entire container rather
 * than leak the P1 child by way of its sibling P0 fields.
 */
function containsP1(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some(containsP1);
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isP1Key(k) || isVinKey(k)) return true;
    if (containsP1(v)) return true;
  }
  return false;
}

/**
 * Walks `input` recursively and produces a NEW value with every P1 key/value
 * pair replaced by `[REDACTED]` (or `***XXXX` for VIN), and any container
 * (object/array) holding P1 descendants replaced by `[REDACTED]` per the
 * containment rule.
 *
 * Idempotent: running `redactP1` on already-redacted output is a no-op.
 *
 * Never mutates the input.
 */
export function redactP1<T>(input: T): T {
  return redactValue(input) as T;
}

function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    // Containment rule: an array with any P1 descendant is itself P1.
    if (containsP1(value)) return REDACTED;
    return value.map(redactValue);
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isVinKey(k)) {
      result[k] = redactVin(v);
      continue;
    }
    if (isP1Key(k)) {
      result[k] = REDACTED;
      continue;
    }
    // Non-P1 key: descend. If the descendant contains P1, the recursive
    // call returns REDACTED (containment rule) and the leak is closed.
    if (v !== null && typeof v === 'object' && containsP1(v)) {
      result[k] = REDACTED;
      continue;
    }
    result[k] = redactValue(v);
  }
  return result;
}
