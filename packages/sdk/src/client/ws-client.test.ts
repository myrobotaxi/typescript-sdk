import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MyRoboTaxiClient } from './ws-client';
import type { ClientEvent, WebSocketLike } from './types';

// Controllable mock satisfying WebSocketLike. The test drives the
// lifecycle deterministically (open → auth_ok → frames → close).
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
  // test helpers
  fireOpen(): void {
    this.readyState = 1;
    this.onopen?.(null);
  }
  fireMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  fireClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  fireError(): void {
    this.onerror?.(null);
  }
}

function makeClient(overrides: Partial<Parameters<typeof MyRoboTaxiClient.prototype.constructor>[0]> = {}) {
  const events: ClientEvent[] = [];
  const client = new MyRoboTaxiClient({
    url: 'wss://t.example/api/ws',
    getToken: async () => 'tok',
    webSocketFactory: (u) => new MockWS(u),
    heartbeatIntervalMs: 1000, // watchdog = 2000
    ...overrides,
  });
  client.subscribe((e) => events.push(e));
  return { client, events };
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('MyRoboTaxiClient — handshake (happy path)', () => {
  beforeEach(() => {
    MockWS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('connects, sends auth frame first, transitions to connected on auth_ok', async () => {
    const { client, events } = makeClient();
    client.connect();
    expect(client.connectionState).toBe('connecting');
    await flush(); // getToken resolves
    const ws = MockWS.instances[0]!;
    ws.fireOpen();
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: 'auth', payload: { token: 'tok' } });
    ws.fireMessage({ type: 'auth_ok', payload: { userId: 'u', vehicleCount: 1 } });
    expect(client.connectionState).toBe('connected');
    expect(events.some((e) => e.kind === 'connectionState' && e.to === 'connected')).toBe(true);
  });

  it('emits data frames after auth_ok', async () => {
    const { client, events } = makeClient();
    client.connect();
    await flush();
    const ws = MockWS.instances[0]!;
    ws.fireOpen();
    ws.fireMessage({ type: 'auth_ok', payload: {} });
    ws.fireMessage({ type: 'vehicle_update', payload: { vehicleId: 'v', timestamp: '' } });
    expect(events.some((e) => e.kind === 'frame' && e.type === 'vehicle_update')).toBe(true);
  });
});

describe('MyRoboTaxiClient — reconnect', () => {
  beforeEach(() => {
    MockWS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('reconnects on close while connected (C-6 → C-9)', async () => {
    const { client, events } = makeClient();
    client.connect();
    await flush();
    MockWS.instances[0]!.fireOpen();
    MockWS.instances[0]!.fireMessage({ type: 'auth_ok', payload: {} });
    MockWS.instances[0]!.fireClose(1006);
    expect(client.connectionState).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(2000); // backoff + getToken
    await flush();
    expect(MockWS.instances.length).toBe(2); // reconnected
    expect(events.some((e) => e.kind === 'connectionState' && e.to === 'disconnected')).toBe(true);
  });

  it('reconnects on transport error', async () => {
    const { client } = makeClient();
    client.connect();
    await flush();
    MockWS.instances[0]!.fireOpen();
    MockWS.instances[0]!.fireMessage({ type: 'auth_ok', payload: {} });
    MockWS.instances[0]!.fireError();
    expect(client.connectionState).toBe('disconnected');
  });

  it('pre-auth_ok 6 s timeout → disconnected + reconnect (§2.3 rule 4)', async () => {
    const { client, events } = makeClient();
    client.connect();
    await flush();
    MockWS.instances[0]!.fireOpen(); // auth sent, pre-auth timer armed
    // auth_ok never arrives
    await vi.advanceTimersByTimeAsync(6000);
    expect(client.connectionState).toBe('disconnected');
    expect(
      events.some((e) => e.kind === 'connectionState' && e.reason === 'auth_timeout'),
    ).toBe(true);
  });

  it('liveness watchdog fires after 2× heartbeat of silence (§7.4.1)', async () => {
    const { client } = makeClient();
    client.connect();
    await flush();
    MockWS.instances[0]!.fireOpen();
    MockWS.instances[0]!.fireMessage({ type: 'auth_ok', payload: {} });
    expect(client.connectionState).toBe('connected');
    await vi.advanceTimersByTimeAsync(2000); // 2× 1000 ms heartbeat
    expect(client.connectionState).toBe('disconnected');
  });

  it('a heartbeat resets the watchdog', async () => {
    const { client } = makeClient();
    client.connect();
    await flush();
    const ws = MockWS.instances[0]!;
    ws.fireOpen();
    ws.fireMessage({ type: 'auth_ok', payload: {} });
    await vi.advanceTimersByTimeAsync(1500);
    ws.fireMessage({ type: 'heartbeat' }); // resets
    await vi.advanceTimersByTimeAsync(1500); // 1500 < 2000 since reset
    expect(client.connectionState).toBe('connected');
  });
});

describe('MyRoboTaxiClient — terminal errors', () => {
  beforeEach(() => {
    MockWS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('auth_failed → error (terminal, no reconnect)', async () => {
    const { client, events } = makeClient();
    client.connect();
    await flush();
    const ws = MockWS.instances[0]!;
    ws.fireOpen();
    ws.fireMessage({ type: 'error', payload: { code: 'auth_failed', message: 'bad' } });
    expect(client.connectionState).toBe('error');
    await vi.advanceTimersByTimeAsync(5000);
    expect(MockWS.instances.length).toBe(1); // no reconnect
    expect(events.some((e) => e.kind === 'error' && e.error.code === 'auth_failed')).toBe(true);
  });

  it('max retries exhausted → error (C-5)', async () => {
    const { client } = makeClient({ maxRetries: 1 });
    client.connect();
    await flush();
    MockWS.instances[0]!.fireOpen();
    MockWS.instances[0]!.fireClose(1006); // attempt 1 was used; >= maxRetries
    expect(client.connectionState).toBe('error');
  });
});

describe('MyRoboTaxiClient — lifecycle idempotence', () => {
  beforeEach(() => {
    MockWS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('destroy() is idempotent and terminal (C-12)', async () => {
    const { client } = makeClient();
    client.connect();
    await flush();
    MockWS.instances[0]!.fireOpen();
    MockWS.instances[0]!.fireMessage({ type: 'auth_ok', payload: {} });
    client.destroy();
    client.destroy(); // no throw
    client.connect(); // no-op after destroy
    await vi.advanceTimersByTimeAsync(5000);
    expect(MockWS.instances.length).toBe(1);
  });

  it('disconnect() stops reconnect (C-10)', async () => {
    const { client } = makeClient();
    client.connect();
    await flush();
    MockWS.instances[0]!.fireOpen();
    MockWS.instances[0]!.fireMessage({ type: 'auth_ok', payload: {} });
    client.disconnect();
    expect(client.connectionState).toBe('error');
    await vi.advanceTimersByTimeAsync(5000);
    expect(MockWS.instances.length).toBe(1); // no reconnect after user stop
  });

  it('retry() from error restarts (C-11)', async () => {
    const { client } = makeClient();
    client.connect();
    await flush();
    MockWS.instances[0]!.fireOpen();
    MockWS.instances[0]!.fireMessage({ type: 'error', payload: { code: 'auth_failed', message: 'x' } });
    expect(client.connectionState).toBe('error');
    client.retry();
    expect(client.connectionState).toBe('connecting');
  });
});
