import { describe, expect, it } from 'vitest';

import { InMemoryMetricsRecorder, Metric } from './metrics';

describe('InMemoryMetricsRecorder — counter', () => {
  it('accumulates counter samples per series', () => {
    const r = new InMemoryMetricsRecorder();
    r.counter(Metric.WS_RECONNECT);
    r.counter(Metric.WS_RECONNECT);
    r.counter(Metric.WS_RECONNECT);
    const snap = r.getSnapshot();
    expect(snap.counters[Metric.WS_RECONNECT]).toHaveLength(3);
    expect(snap.counters[Metric.WS_RECONNECT]?.[0]?.value).toBe(1);
  });

  it('differentiates series by tags', () => {
    const r = new InMemoryMetricsRecorder();
    r.counter(Metric.WS_MESSAGE_RECEIVED, { type: 'vehicle_update' });
    r.counter(Metric.WS_MESSAGE_RECEIVED, { type: 'vehicle_update' });
    r.counter(Metric.WS_MESSAGE_RECEIVED, { type: 'drive_started' });
    const snap = r.getSnapshot();
    // Same metric name; both series aggregated under it.
    expect(snap.counters[Metric.WS_MESSAGE_RECEIVED]).toHaveLength(3);
    // Series-level differentiation: tag is preserved on each sample.
    const tagged = snap.counters[Metric.WS_MESSAGE_RECEIVED] ?? [];
    expect(tagged.filter((s) => s.tags?.type === 'vehicle_update')).toHaveLength(2);
    expect(tagged.filter((s) => s.tags?.type === 'drive_started')).toHaveLength(1);
  });

  it('tag-key order does not create duplicate series', () => {
    const r = new InMemoryMetricsRecorder();
    r.counter('m', { a: '1', b: '2' });
    r.counter('m', { b: '2', a: '1' });
    expect(r.getSnapshot().counters.m).toHaveLength(2);
  });
});

describe('InMemoryMetricsRecorder — histogram', () => {
  it('records each value', () => {
    const r = new InMemoryMetricsRecorder();
    r.histogram(Metric.WS_MESSAGE_LATENCY_MS, 12);
    r.histogram(Metric.WS_MESSAGE_LATENCY_MS, 45);
    r.histogram(Metric.WS_MESSAGE_LATENCY_MS, 8);
    const samples = r.getSnapshot().histograms[Metric.WS_MESSAGE_LATENCY_MS] ?? [];
    expect(samples.map((s) => s.value)).toEqual([12, 45, 8]);
  });
});

describe('InMemoryMetricsRecorder — gauge', () => {
  it('records each set', () => {
    const r = new InMemoryMetricsRecorder();
    r.gauge('connection_open', 1);
    r.gauge('connection_open', 0);
    r.gauge('connection_open', 1);
    const samples = r.getSnapshot().gauges.connection_open ?? [];
    expect(samples.map((s) => s.value)).toEqual([1, 0, 1]);
  });
});

describe('InMemoryMetricsRecorder — capacity / ring buffer', () => {
  it('drops oldest sample when capacity is exceeded', () => {
    const r = new InMemoryMetricsRecorder({ capacity: 3 });
    r.histogram('m', 1);
    r.histogram('m', 2);
    r.histogram('m', 3);
    r.histogram('m', 4);
    r.histogram('m', 5);
    const samples = r.getSnapshot().histograms.m ?? [];
    expect(samples.map((s) => s.value)).toEqual([3, 4, 5]);
  });

  it('clamps non-positive capacity to 1', () => {
    const r = new InMemoryMetricsRecorder({ capacity: 0 });
    r.histogram('m', 1);
    r.histogram('m', 2);
    const samples = r.getSnapshot().histograms.m ?? [];
    expect(samples).toHaveLength(1);
    expect(samples[0]?.value).toBe(2);
  });
});

describe('InMemoryMetricsRecorder — snapshot immutability', () => {
  it('returns frozen counters / histograms / gauges containers', () => {
    const r = new InMemoryMetricsRecorder();
    r.counter('c');
    const snap = r.getSnapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.counters)).toBe(true);
  });

  it('snapshot does not reflect later writes', () => {
    const r = new InMemoryMetricsRecorder();
    r.counter('c');
    const snap = r.getSnapshot();
    r.counter('c');
    expect(snap.counters.c).toHaveLength(1);
    expect(r.getSnapshot().counters.c).toHaveLength(2);
  });
});

describe('InMemoryMetricsRecorder — clear()', () => {
  it('resets every series', () => {
    const r = new InMemoryMetricsRecorder();
    r.counter('a');
    r.histogram('b', 1);
    r.gauge('c', 1);
    r.clear();
    const snap = r.getSnapshot();
    expect(snap.counters).toEqual({});
    expect(snap.histograms).toEqual({});
    expect(snap.gauges).toEqual({});
  });
});

describe('Metric constants', () => {
  it('exports the canonical metric names', () => {
    expect(Metric.WS_CONNECT_ATTEMPTS).toBe('ws_connect_attempts_total');
    expect(Metric.WS_RECONNECT).toBe('ws_reconnect_total');
    expect(Metric.WS_MESSAGE_RECEIVED).toBe('ws_message_received_total');
    expect(Metric.WS_MESSAGE_LATENCY_MS).toBe('ws_message_latency_ms');
    expect(Metric.REST_REQUEST_DURATION_MS).toBe('rest_request_duration_ms');
    expect(Metric.DATA_STALENESS_EVENTS).toBe('data_staleness_events_total');
    expect(Metric.AUTH_FAILED).toBe('auth_failed_total');
  });
});
