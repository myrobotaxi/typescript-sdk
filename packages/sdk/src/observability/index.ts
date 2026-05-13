// Observability primitives — pluggable Logger + MetricsRecorder, plus the
// P1-redaction layer that decorates every Logger inside the SDK client.
//
// See packages/sdk/docs/observability.md for the API tour, the canonical
// metric catalog, and Vercel wiring examples.

export type { Logger, LogLevel } from './logger.js';
export { ConsoleLogger } from './logger.js';

export { REDACTED, redactP1 } from './redact.js';
export { RedactingLogger } from './redacting-logger.js';

export type { MetricName, MetricSample, MetricTags, MetricsRecorder, MetricsSnapshot } from './metrics.js';
export { InMemoryMetricsRecorder, Metric } from './metrics.js';
