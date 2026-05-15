import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MyRoboTaxiClient } from './ws-client';
import type { ClientEvent, MyRoboTaxiClientOptions, WebSocketLike } from './types';

class MockWS implements WebSocketLike {
  static instances: MockWS[] = [];
  readyState = 0;
  sent: string[] = [];
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
  close(): void {
    this.readyState = 3;
  }
  fireOpen(): void {
    this.readyState = 1;
    this.onopen?.(null);
  }
  fireMessage(o: unknown): void {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
  fireClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  frames(): { type: string; payload?: { vehicleId?: string } }[] {
    return this.sent.map((s) => JSON.parse(s) as { type: string; payload?: { vehicleId?: string } });
  }
  subscribeFrames(): string[] {
    return this.frames()
      .filter((f) => f.type === 'subscribe')
      .map((f) => f.payload?.vehicleId ?? '');
  }
}

function make(overrides: Partial<MyRoboTaxiClientOptions> = {}) {
  const events: ClientEvent[] = [];
  const client = new MyRoboTaxiClient({
    url: 'wss://t/api/ws',
    getToken: async () => 'tok',
    webSocketFactory: (u) => new MockWS(u),
    heartbeatIntervalMs: 1000,
    ...overrides,
  });
  client.onEvent((e) => events.push(e));
  return { client, events };
}
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};
const authOk = (ws: MockWS): void => ws.fireMessage({ type: 'auth_ok', payload: {} });

describe('MyRoboTaxiClient — per-vehicle subscribe (MYR-83)', () => {
  beforeEach(() => {
    MockWS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('subscribe() returns a handle and sends a frame after auth_ok', async () => {
    const { client } = make();
    client.connect();
    await flush();
    const ws = MockWS.instances[0]!;
    ws.fireOpen();
    authOk(ws);
    const sub = client.subscribe('v1');
    expect(sub.vehicleId).toBe('v1');
    expect(ws.subscribeFrames()).toEqual(['v1']);
    expect([...client.getSubscribedVehicles()]).toEqual(['v1']);
  });

  it('queues subscribe before auth_ok, flushes on auth_ok', async () => {
    const { client } = make();
    client.connect();
    await flush();
    const ws = MockWS.instances[0]!;
    ws.fireOpen();
    client.subscribe('v1'); // pre-auth_ok → queued
    expect(ws.subscribeFrames()).toEqual([]);
    authOk(ws);
    expect(ws.subscribeFrames()).toEqual(['v1']);
  });

  it('is idempotent per vehicleId (strict-mode double-mount safe)', async () => {
    const { client } = make();
    client.connect();
    await flush();
    const ws = MockWS.instances[0]!;
    ws.fireOpen();
    authOk(ws);
    client.subscribe('v1');
    client.subscribe('v1'); // double-mount
    expect(ws.subscribeFrames()).toEqual(['v1']); // wire emits once
  });

  it('re-subscribes the whole set after a reconnect', async () => {
    const { client } = make();
    client.connect();
    await flush();
    let ws = MockWS.instances[0]!;
    ws.fireOpen();
    authOk(ws);
    client.subscribe('v1');
    client.subscribe('v2');
    ws.fireClose(1006); // drop
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    ws = MockWS.instances[1]!; // reconnected socket
    ws.fireOpen();
    authOk(ws);
    expect(new Set(ws.subscribeFrames())).toEqual(new Set(['v1', 'v2']));
    expect([...client.getSubscribedVehicles()].sort()).toEqual(['v1', 'v2']);
  });

  it('unsubscribe() sends a frame and drops the vehicle from the set', async () => {
    const { client } = make();
    client.connect();
    await flush();
    const ws = MockWS.instances[0]!;
    ws.fireOpen();
    authOk(ws);
    const sub = client.subscribe('v1');
    sub.unsubscribe();
    expect(client.getSubscribedVehicles().has('v1')).toBe(false);
    expect(ws.frames().some((f) => f.type === 'unsubscribe' && f.payload?.vehicleId === 'v1')).toBe(
      true,
    );
    sub.unsubscribe(); // idempotent — no throw, no duplicate
  });
});

describe('MyRoboTaxiClient — defensive drop + rejections (MYR-83)', () => {
  beforeEach(() => {
    MockWS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('drops vehicle_update for an unsubscribed vehicle in selective mode', async () => {
    const { client, events } = make();
    client.connect();
    await flush();
    const ws = MockWS.instances[0]!;
    ws.fireOpen();
    authOk(ws);
    client.subscribe('v1'); // selective mode
    ws.fireMessage({ type: 'vehicle_update', payload: { vehicleId: 'v1', timestamp: '' } });
    ws.fireMessage({ type: 'vehicle_update', payload: { vehicleId: 'vX', timestamp: '' } });
    const frameEvents = events.filter((e) => e.kind === 'frame');
    expect(frameEvents).toHaveLength(1); // vX dropped
  });

  it('subscribeAll() = legacy fan-out: no client-side drop', async () => {
    const { client, events } = make();
    client.connect();
    await flush();
    const ws = MockWS.instances[0]!;
    ws.fireOpen();
    authOk(ws);
    client.subscribe('v1'); // selective
    client.subscribeAll(); // back to fan-out
    ws.fireMessage({ type: 'vehicle_update', payload: { vehicleId: 'anything', timestamp: '' } });
    expect(events.some((e) => e.kind === 'frame')).toBe(true);
    expect([...client.getSubscribedVehicles()]).toEqual([]); // server-driven
  });

  // The wire ErrorPayload has no vehicleId/requestId (verified against
  // @myrobotaxi/contracts), so a permission_denied / vehicle_not_owned
  // is NOT attributed to a specific subscribe. It surfaces as the
  // generic `error` event and does NOT silently mutate the subscribed
  // set — guessing the offending vehicle from a FIFO was provably wrong
  // after the 2nd subscribe (review Critical). Without correlation data
  // these codes also revert to MYR-50's C-8 terminal handling (catalog:
  // permission_denied is terminal): a connection-scoped error closes the
  // connection. That is the honest behaviour — we cannot know it was
  // subscribe-scoped, so we must not pretend the connection is fine.
  it('permission_denied surfaces as a generic error; subscribed set NOT mis-mutated', async () => {
    const { client, events } = make();
    client.connect();
    await flush();
    const ws = MockWS.instances[0]!;
    ws.fireOpen();
    authOk(ws);
    client.subscribe('v1');
    client.subscribe('v2'); // 2+ subscribes — the old FIFO mis-blamed v1
    ws.fireMessage({ type: 'error', payload: { code: 'permission_denied', message: 'no' } });
    const errEvt = events.find((e) => e.kind === 'error');
    expect(errEvt).toBeDefined();
    if (errEvt && errEvt.kind === 'error') expect(errEvt.error.code).toBe('permission_denied');
    // Critical regression guard: no vehicle is silently dropped via a
    // false FIFO guess — the set is exactly what was subscribed.
    expect([...client.getSubscribedVehicles()].sort()).toEqual(['v1', 'v2']);
    // C-8: a terminal connection-scoped error closes the connection
    // (MYR-50 contract, restored now the unsound carve-out is gone).
    expect(client.connectionState).toBe('error');
  });

  it('getSubscribedVehicles() returns a defensive copy', async () => {
    const { client } = make();
    client.connect();
    await flush();
    const ws = MockWS.instances[0]!;
    ws.fireOpen();
    authOk(ws);
    client.subscribe('v1');
    const snapshot = client.getSubscribedVehicles() as Set<string>;
    snapshot.add('vHACK'); // mutate the returned set
    expect(client.getSubscribedVehicles().has('vHACK')).toBe(false); // internal set unaffected
  });

  it('subscribe()/subscribeAll() are inert after destroy()', async () => {
    const { client } = make();
    client.connect();
    await flush();
    const ws = MockWS.instances[0]!;
    ws.fireOpen();
    authOk(ws);
    client.destroy();
    const sub = client.subscribe('v1'); // no state mutation, no send
    expect(sub.vehicleId).toBe('v1');
    expect(() => sub.unsubscribe()).not.toThrow();
    client.subscribeAll(); // no-op
    expect([...client.getSubscribedVehicles()]).toEqual([]);
    expect(ws.subscribeFrames()).toEqual([]);
  });
});
