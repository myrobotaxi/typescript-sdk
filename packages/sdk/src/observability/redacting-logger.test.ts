import { describe, expect, it, vi } from 'vitest';

import type { Logger } from './logger';
import { REDACTED } from './redact';
import { RedactingLogger } from './redacting-logger';

function makeSpyLogger(): Logger & { calls: { level: string; message: string; meta?: unknown }[] } {
  const calls: { level: string; message: string; meta?: unknown }[] = [];
  return {
    debug: vi.fn((message: string, meta?: Record<string, unknown>) => {
      calls.push({ level: 'debug', message, meta });
    }),
    info: vi.fn((message: string, meta?: Record<string, unknown>) => {
      calls.push({ level: 'info', message, meta });
    }),
    warn: vi.fn((message: string, meta?: Record<string, unknown>) => {
      calls.push({ level: 'warn', message, meta });
    }),
    error: vi.fn((message: string, meta?: Record<string, unknown>) => {
      calls.push({ level: 'error', message, meta });
    }),
    calls,
  };
}

describe('RedactingLogger', () => {
  it('redacts P1 meta before forwarding', () => {
    const inner = makeSpyLogger();
    const logger = new RedactingLogger(inner);
    logger.info('connected', { vehicleId: 'clxyz', latitude: 37.7749 });
    expect(inner.calls[0]?.meta).toEqual({ vehicleId: 'clxyz', latitude: REDACTED });
  });

  it('all four levels go through redaction', () => {
    const inner = makeSpyLogger();
    const logger = new RedactingLogger(inner);
    const meta = { email: 'user@example.com' };
    logger.debug('d', meta);
    logger.info('i', meta);
    logger.warn('w', meta);
    logger.error('e', meta);
    for (const call of inner.calls) {
      expect(call.meta).toEqual({ email: REDACTED });
    }
  });

  it('forwards undefined meta as undefined (does not allocate an empty object)', () => {
    const inner = makeSpyLogger();
    const logger = new RedactingLogger(inner);
    logger.info('hello');
    expect(inner.calls[0]?.meta).toBeUndefined();
  });

  it('does not mutate the caller meta', () => {
    const inner = makeSpyLogger();
    const logger = new RedactingLogger(inner);
    const meta = { latitude: 37.7749 };
    const metaCopy = { ...meta };
    logger.info('x', meta);
    expect(meta).toEqual(metaCopy);
  });

  it('preserves the message string verbatim (only meta is redacted)', () => {
    // Documented contract: only `meta` is structurally redacted. Consumers
    // must not embed P1 values in the free-text `message` string.
    const inner = makeSpyLogger();
    const logger = new RedactingLogger(inner);
    logger.info('connected to vehicle at latitude=37.7749', { vehicleId: 'clxyz' });
    expect(inner.calls[0]?.message).toBe('connected to vehicle at latitude=37.7749');
  });
});
