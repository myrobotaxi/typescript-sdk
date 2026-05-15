import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReconnectOrchestrator } from './orchestrator';
import type { OrchestratorEvent } from './types';
import type { ClientEvent } from '../../client/types';
import type { MyRoboTaxiClient } from '../../client/ws-client';
import type { RestClient } from '../../rest/rest-client';
import type { RestResult } from '../../rest/types';

const VALID_SNAPSHOT = {
  vehicleId: 'v1',
  status: 'parked' as const,
  gearPosition: 'P' as const,
  chargeLevel: 75,
  estimatedRange: 240,
  latitude: 37.7749,
  longitude: -122.4194,
  heading: 90,
  destinationName: null,
  destinationAddress: null,
  destinationLatitude: null,
  destinationLongitude: null,
  originLatitude: null,
  originLongitude: null,
  etaMinutes: null,
  tripDistanceRemaining: null,
  navRouteCoordinates: null,
};

/** Controllable MyRoboTaxiClient stand-in. */
class FakeClient {
  private listener: ((e: ClientEvent) => void) | null = null;
  connectionState = 'initializing';
  connectCalls = 0;
  subscribed = new Set<string>();
  onEvent(l: (e: ClientEvent) => void): () => void {
    this.listener = l;
    return () => {
      this.listener = null;
    };
  }
  connect(): void {
    this.connectCalls += 1;
  }
  getSubscribedVehicles(): ReadonlySet<string> {
    return new Set(this.subscribed);
  }
  fire(e: ClientEvent): void {
    if (e.kind === 'connectionState') this.connectionState = e.to;
    this.listener?.(e);
  }
  cs(to: string): ClientEvent {
    return { kind: 'connectionState', from: 'initializing', to } as ClientEvent;
  }
}

interface Deferred {
  promise: Promise<RestResult<unknown>>;
  resolve: (r: RestResult<unknown>) => void;
  signal: AbortSignal | undefined;
}

/** Controllable RestClient stand-in — one deferred per snapshot.get call. */
class FakeRest {
  calls: { vehicleId: string }[] = [];
  deferreds: Deferred[] = [];
  snapshot = {
    get: (vehicleId: string, o: { signal?: AbortSignal } = {}): Promise<RestResult<unknown>> => {
      this.calls.push({ vehicleId });
      let resolve!: (r: RestResult<unknown>) => void;
      const promise = new Promise<RestResult<unknown>>((res) => {
        resolve = res;
      });
      this.deferreds.push({ promise, resolve, signal: o.signal });
      return promise;
    },
  };
}

function make(subscribed: string[] = ['v1']) {
  const client = new FakeClient();
  subscribed.forEach((v) => client.subscribed.add(v));
  const rest = new FakeRest();
  const events: OrchestratorEvent[] = [];
  const orch = new ReconnectOrchestrator({
    client: client as unknown as MyRoboTaxiClient,
    rest: rest as unknown as RestClient,
  });
  orch.onEvent((e) => events.push(e));
  return { client, rest, orch, events };
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('ReconnectOrchestrator (MYR-84)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('cold connect: snapshot applied BEFORE queued live frames (CG-SM-4)', async () => {
    const { client, rest, orch } = make(['v1']);
    orch.start();
    expect(client.connectCalls).toBe(1);

    client.fire(client.cs('connecting')); // arms reconciler (awaitingSnapshot)
    client.fire(client.cs('connected')); // triggers snapshot fetch
    expect(rest.calls).toEqual([{ vehicleId: 'v1' }]);

    // A live frame arrives BEFORE the snapshot resolves → must be queued,
    // not applied on top of a stale/empty baseline.
    client.fire({ kind: 'frame', type: 'vehicle_update', payload: { vehicleId: 'v1', chargeLevel: 42 } });
    expect(orch.getView('v1')?.vehicle).toBeNull(); // nothing applied yet

    rest.deferreds[0]!.resolve({ ok: true, data: VALID_SNAPSHOT });
    await flush();

    const v = orch.getView('v1')!;
    expect(v.dataState.gps).toBe('ready');
    // Snapshot baseline (75) then the queued delta (42) replayed on top.
    expect(v.vehicle?.chargeLevel).toBe(42);
  });

  it('disconnect → groups go stale (NFR-3.8b), cached retained', async () => {
    const { client, rest, orch } = make(['v1']);
    orch.start();
    client.fire(client.cs('connecting'));
    client.fire(client.cs('connected'));
    rest.deferreds[0]!.resolve({ ok: true, data: VALID_SNAPSHOT });
    await flush();
    expect(orch.getView('v1')?.dataState.charge).toBe('ready');

    client.fire(client.cs('disconnected'));
    const v = orch.getView('v1')!;
    expect(v.dataState.charge).toBe('stale');
    expect(v.vehicle?.chargeLevel).toBe(75); // cached value retained
  });

  it('reconnect re-fetches the snapshot before resuming', async () => {
    const { client, rest, orch } = make(['v1']);
    orch.start();
    client.fire(client.cs('connecting'));
    client.fire(client.cs('connected'));
    rest.deferreds[0]!.resolve({ ok: true, data: VALID_SNAPSHOT });
    await flush();

    client.fire(client.cs('disconnected'));
    client.fire(client.cs('connecting'));
    client.fire(client.cs('connected'));
    expect(rest.calls).toHaveLength(2); // exactly one re-fetch
  });

  it('snapshot failure → snapshotUnavailable event + dataState error', async () => {
    const { client, rest, orch, events } = make(['v1']);
    orch.start();
    client.fire(client.cs('connecting'));
    client.fire(client.cs('connected'));
    rest.deferreds[0]!.resolve({
      ok: false,
      error: { code: 'service_unavailable', message: 'down', transport: 'rest', retryable: true, terminal: false },
    } as RestResult<unknown>);
    await flush();

    expect(events).toEqual([
      {
        kind: 'snapshotUnavailable',
        vehicleId: 'v1',
        error: expect.objectContaining({ code: 'service_unavailable' }),
      },
    ]);
    expect(orch.getView('v1')?.dataState.gps).toBe('error');
  });

  it('rapid reconnect supersedes a stale in-flight snapshot (chaos)', async () => {
    const { client, rest, orch } = make(['v1']);
    orch.start();
    client.fire(client.cs('connecting'));
    client.fire(client.cs('connected')); // fetch #0 (generation 1)

    // Reconnect again before #0 resolves → generation bumps, #0 superseded.
    client.fire(client.cs('disconnected'));
    client.fire(client.cs('connecting'));
    client.fire(client.cs('connected')); // fetch #1 (generation 2)

    // Late resolution of the superseded fetch must be discarded.
    rest.deferreds[0]!.resolve({ ok: true, data: { ...VALID_SNAPSHOT, chargeLevel: 11 } });
    await flush();
    expect(orch.getView('v1')?.vehicle).toBeNull(); // stale result NOT applied

    rest.deferreds[1]!.resolve({ ok: true, data: { ...VALID_SNAPSHOT, chargeLevel: 99 } });
    await flush();
    expect(orch.getView('v1')?.vehicle?.chargeLevel).toBe(99); // only the fresh one
  });

  it('destroy() aborts the in-flight snapshot and ignores late results', async () => {
    const { client, rest, orch } = make(['v1']);
    orch.start();
    client.fire(client.cs('connecting'));
    client.fire(client.cs('connected'));
    const d = rest.deferreds[0]!;
    expect(d.signal?.aborted).toBe(false);

    orch.destroy();
    expect(d.signal?.aborted).toBe(true);

    d.resolve({ ok: true, data: VALID_SNAPSHOT });
    await flush();
    expect(orch.getView('v1')?.vehicle).toBeNull(); // not applied post-destroy
  });

  it('routes frames by vehicleId; untracked vehicle is ignored', async () => {
    const { client, rest, orch } = make(['v1']);
    orch.start();
    client.fire(client.cs('connecting'));
    client.fire(client.cs('connected'));
    rest.deferreds[0]!.resolve({ ok: true, data: VALID_SNAPSHOT });
    await flush();

    client.fire({ kind: 'frame', type: 'vehicle_update', payload: { vehicleId: 'vX', chargeLevel: 1 } });
    expect(orch.getView('vX')).toBeNull(); // never tracked
    expect(orch.getView('v1')?.vehicle?.chargeLevel).toBe(75); // unaffected
  });
});
