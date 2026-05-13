// Decorator that wraps any Logger and runs the `meta` argument through
// redactP1 before forwarding to the inner Logger.
//
// The SDK MUST wrap every consumer-supplied Logger with this decorator
// inside the client constructor. Consumers cannot bypass redaction even
// if they inject a raw Logger. The wrapping is a non-negotiable security
// boundary per FR-11.2.

import type { Logger } from './logger.js';
import { redactP1 } from './redact.js';

export class RedactingLogger implements Logger {
  constructor(private readonly inner: Logger) {}

  debug(message: string, meta?: Record<string, unknown>): void {
    this.inner.debug(message, meta && redactP1(meta));
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.inner.info(message, meta && redactP1(meta));
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.inner.warn(message, meta && redactP1(meta));
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.inner.error(message, meta && redactP1(meta));
  }
}
