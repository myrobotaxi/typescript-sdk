// In-memory performance metrics (FR-11.3).
//
// Pluggable MetricsRecorder interface — consumers wire it to their preferred
// backend (e.g., @vercel/analytics, @vercel/otel, statsd). The SDK ships an
// InMemoryMetricsRecorder for local development, tests, and any consumer
// that doesn't need vendor-specific aggregation.
//
// Metric tags MUST be P0 only (opaque cuids, enum-shaped strings). Passing
// P1 values (email, GPS, address) as tags is a security violation. The SDK
// itself NEVER passes P1 as a tag; consumers wiring their own MetricsRecorder
// implementations are on the honor system here — see observability.md.

export type MetricTags = Record<string, string>;

export interface MetricsRecorder {
  /** Increment a counter by 1. Tags differentiate series (P0 only). */
  counter(name: string, tags?: MetricTags): void;
  /** Record a histogram sample. Tags differentiate series (P0 only). */
  histogram(name: string, value: number, tags?: MetricTags): void;
  /** Set a gauge to a value. Tags differentiate series (P0 only). */
  gauge(name: string, value: number, tags?: MetricTags): void;
}

/** Canonical metric names emitted by the SDK. Future ticket implementations
 *  reference these constants rather than string literals. */
export const Metric = {
  WS_CONNECT_ATTEMPTS: 'ws_connect_attempts_total',
  WS_RECONNECT: 'ws_reconnect_total',
  WS_MESSAGE_RECEIVED: 'ws_message_received_total',
  WS_MESSAGE_LATENCY_MS: 'ws_message_latency_ms',
  REST_REQUEST_DURATION_MS: 'rest_request_duration_ms',
  DATA_STALENESS_EVENTS: 'data_staleness_events_total',
  AUTH_FAILED: 'auth_failed_total',
} as const;

export type MetricName = (typeof Metric)[keyof typeof Metric];

export interface MetricSample {
  readonly value: number;
  readonly ts: number;
  readonly tags?: Readonly<MetricTags>;
}

export interface MetricsSnapshot {
  readonly counters: Readonly<Record<string, readonly MetricSample[]>>;
  readonly histograms: Readonly<Record<string, readonly MetricSample[]>>;
  readonly gauges: Readonly<Record<string, readonly MetricSample[]>>;
}

interface Series {
  samples: MetricSample[];
}

/**
 * Default MetricsRecorder. Holds samples in bounded ring buffers per series
 * (defined by `${name}|${sortedTags}`). Consumers drain via getSnapshot()
 * and reset via clear().
 *
 * Drop policy when capacity is full: drop oldest sample (FIFO).
 */
export class InMemoryMetricsRecorder implements MetricsRecorder {
  private readonly capacity: number;
  private readonly counters = new Map<string, Series>();
  private readonly histograms = new Map<string, Series>();
  private readonly gauges = new Map<string, Series>();

  constructor(opts?: { capacity?: number }) {
    this.capacity = Math.max(1, opts?.capacity ?? 1000);
  }

  counter(name: string, tags?: MetricTags): void {
    const series = this.getOrCreateSeries(this.counters, name, tags);
    this.appendSample(series, { value: 1, ts: Date.now(), tags: freezeTags(tags) });
  }

  histogram(name: string, value: number, tags?: MetricTags): void {
    const series = this.getOrCreateSeries(this.histograms, name, tags);
    this.appendSample(series, { value, ts: Date.now(), tags: freezeTags(tags) });
  }

  gauge(name: string, value: number, tags?: MetricTags): void {
    const series = this.getOrCreateSeries(this.gauges, name, tags);
    this.appendSample(series, { value, ts: Date.now(), tags: freezeTags(tags) });
  }

  /** Returns a frozen, immutable snapshot organized by metric name. */
  getSnapshot(): MetricsSnapshot {
    return Object.freeze({
      counters: snapshotByName(this.counters),
      histograms: snapshotByName(this.histograms),
      gauges: snapshotByName(this.gauges),
    });
  }

  /** Drop all samples across every series. */
  clear(): void {
    this.counters.clear();
    this.histograms.clear();
    this.gauges.clear();
  }

  private getOrCreateSeries(
    bucket: Map<string, Series>,
    name: string,
    tags: MetricTags | undefined,
  ): Series {
    const key = seriesKey(name, tags);
    let series = bucket.get(key);
    if (!series) {
      series = { samples: [] };
      bucket.set(key, series);
    }
    return series;
  }

  private appendSample(series: Series, sample: MetricSample): void {
    series.samples.push(sample);
    if (series.samples.length > this.capacity) series.samples.shift();
  }
}

function seriesKey(name: string, tags: MetricTags | undefined): string {
  if (!tags) return `${name}|`;
  const sorted = Object.keys(tags)
    .sort()
    .map((k) => `${k}=${tags[k]}`)
    .join(',');
  return `${name}|${sorted}`;
}

function freezeTags(tags: MetricTags | undefined): Readonly<MetricTags> | undefined {
  return tags ? Object.freeze({ ...tags }) : undefined;
}

function snapshotByName(bucket: Map<string, Series>): Record<string, readonly MetricSample[]> {
  const out: Record<string, MetricSample[]> = {};
  for (const [seriesKeyValue, series] of bucket) {
    const sep = seriesKeyValue.indexOf('|');
    const name = sep >= 0 ? seriesKeyValue.slice(0, sep) : seriesKeyValue;
    const samples = series.samples.map((s) => Object.freeze({ ...s }));
    if (!out[name]) out[name] = [];
    for (const sample of samples) out[name].push(sample);
  }
  const frozen: Record<string, readonly MetricSample[]> = {};
  for (const [name, samples] of Object.entries(out)) frozen[name] = Object.freeze(samples);
  return Object.freeze(frozen);
}
