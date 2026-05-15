import { describe, expect, it } from 'vitest';

import { BACKOFF, computeBackoffMs } from './backoff';

describe('computeBackoffMs (NFR-3.10 / ws-protocol §7.1)', () => {
  it('doubles per attempt with no jitter (rng=0.5 → zero jitter)', () => {
    const rng = (): number => 0.5; // 0.5*2-1 = 0 → no jitter
    expect(computeBackoffMs(1, rng)).toBe(1000);
    expect(computeBackoffMs(2, rng)).toBe(2000);
    expect(computeBackoffMs(3, rng)).toBe(4000);
    expect(computeBackoffMs(4, rng)).toBe(8000);
  });

  it('caps at maxDelay (30 s)', () => {
    const rng = (): number => 0.5;
    expect(computeBackoffMs(10, rng)).toBe(BACKOFF.maxDelayMs);
    expect(computeBackoffMs(50, rng)).toBe(BACKOFF.maxDelayMs);
  });

  it('applies ±25% jitter bounds', () => {
    expect(computeBackoffMs(1, () => 0)).toBe(750); // -25%
    expect(computeBackoffMs(1, () => 1)).toBe(1250); // +25% (rng→1)
  });

  it('clamps attempt to >= 1 and never returns negative', () => {
    expect(computeBackoffMs(0, () => 0.5)).toBe(1000);
    expect(computeBackoffMs(-5, () => 0)).toBeGreaterThanOrEqual(0);
  });
});
