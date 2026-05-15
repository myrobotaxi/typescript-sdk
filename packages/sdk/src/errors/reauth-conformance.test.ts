// Cross-transport conformance for the reauth_required carve-out (MYR-82).
//
// The thesis: `auth_failed` + `subCode: 'reauth_required'` behaves
// IDENTICALLY whether it arrives over REST or WebSocket — terminal,
// never silently retried, surfaced as a typed error the consumer routes
// to an interactive sign-in. This file pins that equivalence end-to-end
// (not just the mapper unit, which core-error.test.ts covers) plus the
// auth_failed_total{subCode} metric parity across carriers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpCore } from '../rest/http';
import { MyRoboTaxiClient } from '../client/ws-client';
import type { ClientEvent, MyRoboTaxiClientOptions, WebSocketLike } from '../client/types';
import type { MetricsRecorder } from '../observability/metrics';
import { Metric } from '../observability/metrics';
import { isReauthRequired } from './core-error';

interface CounterCall {
  name: string;
  tags?: Record<string, string>;
}
function spyMetrics(): { rec: MetricsRecorder; counters: CounterCall[] } {
  const counters: CounterCall[] = [];
  const rec: MetricsRecorder = {
    counter: (name, tags) => counters.push({ name, tags }),
    histogram() {
      /* no-op */
    },
    gauge() {
      /* no-op */
    },
  };
  return { rec, counters };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('reauth_required conformance — REST carrier (MYR-82)', () => {
  it('terminal, no second getToken, typed via isReauthRequired, transport=rest', async () => {
    let tokenCalls = 0;
    const { rec, counters } = spyMetrics();
    const http = new HttpCore({
      baseUrl: 'https://t.example',
      getToken: async () => {
        tokenCalls += 1;
        return 't';
      },
      metrics: rec,
      fetchImpl: (async () =>
        jsonResponse(401, {
          error: { code: 'auth_failed', message: 'stale auth_time', subCode: 'reauth_required' },
        })) as unknown as typeof fetch,
    });

    const r = await http.request('GET', '/api/x');

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(isReauthRequired(r.error)).toBe(true);
      expect(r.error.transport).toBe('rest');
      expect(r.error.terminal).toBe(true);
      expect(r.error.retryable).toBe(false);
    }
    expect(tokenCalls).toBe(1); // NO silent forced-refresh retry
    const authFailed = counters.filter((c) => c.name === Metric.AUTH_FAILED);
    expect(authFailed).toEqual([{ name: Metric.AUTH_FAILED, tags: { subCode: 'reauth_required' } }]);
  });

  it('CONTROL: plain auth_failed IS retried once, is NOT reauth-required', async () => {
    let tokenCalls = 0;
    let fetchCalls = 0;
    const { rec, counters } = spyMetrics();
    const http = new HttpCore({
      baseUrl: 'https://t.example',
      getToken: async () => {
        tokenCalls += 1;
        return 't';
      },
      metrics: rec,
      fetchImpl: (async () => {
        fetchCalls += 1;
        return jsonResponse(401, { error: { code: 'auth_failed', message: 'expired' } });
      }) as unknown as typeof fetch,
    });

    const r = await http.request('GET', '/api/x');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(isReauthRequired(r.error)).toBe(false);
    expect(fetchCalls).toBe(2); // initial + exactly one forced-refresh retry
    expect(tokenCalls).toBe(2);
    // Surfaced once (the retried-away first 401 does not emit), subCode 'null'.
    const authFailed = counters.filter((c) => c.name === Metric.AUTH_FAILED);
    expect(authFailed).toEqual([{ name: Metric.AUTH_FAILED, tags: { subCode: 'null' } }]);
  });
});

// Minimal controllable socket — local copy (the ws-client test's MockWS
// is not exported). Records close(code, reason) so we can assert 1008.
class MockWS implements WebSocketLike {
  static instances: MockWS[] = [];
  readyState = 0;
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    MockWS.instances.push(this);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.onclose?.({ code });
  }
  fireOpen(): void {
    this.readyState = 1;
    this.onopen?.(null);
  }
  fireMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('reauth_required conformance — WS carrier (MYR-82)', () => {
  beforeEach(() => {
    MockWS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('error frame → typed reauth error, socket closed 1008, metric parity', async () => {
    const { rec, counters } = spyMetrics();
    const events: ClientEvent[] = [];
    const opts: MyRoboTaxiClientOptions = {
      url: 'wss://t.example/api/ws',
      getToken: async () => 'tok',
      webSocketFactory: (u) => new MockWS(u),
      heartbeatIntervalMs: 1000,
      metrics: rec,
    };
    const client = new MyRoboTaxiClient(opts);
    client.subscribe((e) => events.push(e));

    client.connect();
    await flush(); // getToken resolves, socket created
    const ws = MockWS.instances[0]!;
    ws.fireOpen();
    ws.fireMessage({
      type: 'error',
      payload: { code: 'auth_failed', message: 'stale auth_time', subCode: 'reauth_required' },
    });

    const errEvt = events.find((e) => e.kind === 'error');
    expect(errEvt).toBeDefined();
    if (errEvt && errEvt.kind === 'error') {
      expect(isReauthRequired(errEvt.error)).toBe(true);
      expect(errEvt.error.transport).toBe('ws'); // defensive contract-drift carrier
      expect(errEvt.error.terminal).toBe(true);
      expect(errEvt.error.retryable).toBe(false);
    }
    // Terminal auth rejection closes with policy-violation 1008 (C-8).
    expect(ws.closedWith?.code).toBe(1008);
    expect(client.connectionState).toBe('error');
    const authFailed = counters.filter((c) => c.name === Metric.AUTH_FAILED);
    expect(authFailed).toEqual([{ name: Metric.AUTH_FAILED, tags: { subCode: 'reauth_required' } }]);
  });

  it('CONTROL: plain auth_failed over WS is NOT reauth-required', async () => {
    const { rec } = spyMetrics();
    const events: ClientEvent[] = [];
    const client = new MyRoboTaxiClient({
      url: 'wss://t.example/api/ws',
      getToken: async () => 'tok',
      webSocketFactory: (u) => new MockWS(u),
      heartbeatIntervalMs: 1000,
      metrics: rec,
    });
    client.subscribe((e) => events.push(e));

    client.connect();
    await flush();
    const ws = MockWS.instances[0]!;
    ws.fireOpen();
    ws.fireMessage({
      type: 'error',
      payload: { code: 'auth_failed', message: 'expired token' }, // no subCode
    });

    const errEvt = events.find((e) => e.kind === 'error');
    expect(errEvt).toBeDefined();
    if (errEvt && errEvt.kind === 'error') {
      expect(isReauthRequired(errEvt.error)).toBe(false); // symmetry with REST control
      expect(errEvt.error.code).toBe('auth_failed');
    }
  });
});
