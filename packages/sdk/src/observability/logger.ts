// Pluggable Logger interface (FR-11.1).
//
// Consumers inject their own Logger into the SDK to route logs to their
// preferred sink (Pino, Winston, @vercel/otel, console, etc.). The SDK
// auto-wraps any user-supplied Logger with RedactingLogger so P1 redaction
// (FR-11.2) cannot be bypassed.

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/**
 * Default Logger. Silent in production (`NODE_ENV === 'production'`),
 * debug-level otherwise. Consumers wanting a different default should
 * inject their own Logger.
 *
 * Browser-safe: the `globalThis.process?.env?.NODE_ENV` chain handles
 * browser bundles where `process` is undefined.
 */
export class ConsoleLogger implements Logger {
  private readonly threshold: number;

  constructor(opts?: { level?: LogLevel }) {
    const level = opts?.level ?? defaultLevel();
    this.threshold = LEVEL_ORDER[level];
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.threshold >= LEVEL_ORDER.debug) console.debug(message, meta ?? '');
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.threshold >= LEVEL_ORDER.info) console.info(message, meta ?? '');
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.threshold >= LEVEL_ORDER.warn) console.warn(message, meta ?? '');
  }

  error(message: string, meta?: Record<string, unknown>): void {
    if (this.threshold >= LEVEL_ORDER.error) console.error(message, meta ?? '');
  }
}

function defaultLevel(): LogLevel {
  // `globalThis.process` is undefined in browser bundles; cast keeps the
  // type checker honest without forcing `@types/node` into the type chain
  // of the browser build.
  const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process
    ?.env?.NODE_ENV;
  return env === 'production' ? 'silent' : 'debug';
}
