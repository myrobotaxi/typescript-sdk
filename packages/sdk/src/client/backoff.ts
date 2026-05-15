// Reconnect backoff (NFR-3.10 / websocket-protocol.md §7.1, state-machine
// §1.4). Pure + deterministic given the rng — unit-testable in isolation.
//
//   delay          = min(initialDelay * 2^(attempt-1), maxDelay)
//   jitter         = delay * random(-0.25, +0.25)
//   effectiveDelay = delay + jitter

export const BACKOFF = {
  initialDelayMs: 1000,
  multiplier: 2,
  maxDelayMs: 30_000,
  jitterFraction: 0.25,
} as const;

/**
 * Effective reconnect delay for a 1-based attempt number.
 * `rng` returns a value in [0, 1); injectable for deterministic tests.
 */
export function computeBackoffMs(attempt: number, rng: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const base = Math.min(
    BACKOFF.initialDelayMs * BACKOFF.multiplier ** (n - 1),
    BACKOFF.maxDelayMs,
  );
  // random(-0.25, +0.25)
  const jitter = base * BACKOFF.jitterFraction * (rng() * 2 - 1);
  const effective = base + jitter;
  return Math.max(0, Math.round(effective));
}
