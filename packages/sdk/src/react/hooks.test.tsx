// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import type { ReactNode } from 'react';

import { MyRoboTaxiProvider } from './context';
import { useConnectionState } from './useConnectionState';
import { useDriveLifecycle } from './useDriveLifecycle';
import { useDrives } from './useDrives';
import { useVehicleState } from './useVehicleState';
import type { ClientEvent } from '../client/types';
import type { MyRoboTaxiClient } from '../client/ws-client';
import type { RestClient } from '../rest/rest-client';

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

class FakeClient {
  private listeners = new Set<(e: ClientEvent) => void>();
  connectionState = 'initializing';
  subscribed = new Set<string>();
  unsubscribed: string[] = [];
  onEvent(l: (e: ClientEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  connect(): void {
    /* no-op */
  }
  getSubscribedVehicles(): ReadonlySet<string> {
    return new Set(this.subscribed);
  }
  subscribe(vehicleId: string) {
    this.subscribed.add(vehicleId);
    return {
      vehicleId,
      unsubscribe: () => {
        this.subscribed.delete(vehicleId);
        this.unsubscribed.push(vehicleId);
      },
    };
  }
  fire(e: ClientEvent): void {
    if (e.kind === 'connectionState') this.connectionState = e.to;
    this.listeners.forEach((l) => l(e));
  }
  cs(to: string): ClientEvent {
    return { kind: 'connectionState', from: 'initializing', to } as ClientEvent;
  }
}

class FakeRest {
  snapResolvers: ((v: unknown) => void)[] = [];
  drivesPages: { items: { driveId: string }[]; nextCursor: string | null; hasMore: boolean }[] = [];
  drivesCalls: { cursor?: string }[] = [];
  snapshot = {
    get: (_vehicleId: string): Promise<unknown> =>
      new Promise((resolve) => this.snapResolvers.push(resolve)),
  };
  drives = {
    list: (
      _vehicleId: string,
      page: { cursor?: string; limit?: number } = {},
    ): Promise<unknown> => {
      this.drivesCalls.push({ cursor: page.cursor });
      const next = this.drivesPages.shift() ?? { items: [], nextCursor: null, hasMore: false };
      return Promise.resolve({ ok: true, data: next });
    },
  };
}

function wrapper(client: FakeClient, rest: FakeRest) {
  return ({ children }: { children: ReactNode }) =>
    createElement(
      MyRoboTaxiProvider,
      {
        client: client as unknown as MyRoboTaxiClient,
        rest: rest as unknown as RestClient,
        children,
      } as never,
    );
}

afterEach(() => vi.restoreAllMocks());

describe('@myrobotaxi/sdk/react (MYR-53)', () => {
  it('useConnectionState reflects + re-renders on transitions', () => {
    const client = new FakeClient();
    const rest = new FakeRest();
    const { result } = renderHook(() => useConnectionState(), {
      wrapper: wrapper(client, rest),
    });
    expect(result.current).toBe('initializing');
    act(() => client.fire(client.cs('connecting')));
    expect(result.current).toBe('connecting');
    act(() => client.fire(client.cs('connected')));
    expect(result.current).toBe('connected');
  });

  it('useDriveLifecycle invokes the handler on drive frames only', () => {
    const client = new FakeClient();
    const rest = new FakeRest();
    const handler = vi.fn();
    renderHook(() => useDriveLifecycle(handler), { wrapper: wrapper(client, rest) });

    act(() =>
      client.fire({ kind: 'frame', type: 'vehicle_update', payload: { vehicleId: 'v1' } }),
    );
    expect(handler).not.toHaveBeenCalled();
    act(() =>
      client.fire({ kind: 'frame', type: 'drive_started', payload: { driveId: 'd1' } }),
    );
    expect(handler).toHaveBeenCalledWith({ type: 'drive_started', payload: { driveId: 'd1' } });
  });

  it('useVehicleState: snapshot before live frame, then re-renders', async () => {
    const client = new FakeClient();
    client.subscribed.add('v1');
    const rest = new FakeRest();
    const { result } = renderHook(() => useVehicleState('v1'), {
      wrapper: wrapper(client, rest),
    });
    expect(result.current.state).toBeNull();
    expect(result.current.dataState.gps).toBe('loading');

    act(() => client.fire(client.cs('connecting')));
    act(() => client.fire(client.cs('connected'))); // orchestrator fetches snapshot
    await act(async () => {
      client.fire({ kind: 'frame', type: 'vehicle_update', payload: { vehicleId: 'v1', chargeLevel: 40 } });
      rest.snapResolvers[0]!({ ok: true, data: VALID_SNAPSHOT });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.dataState.gps).toBe('ready'));
    // snapshot (75) then queued live delta (40) replayed after it
    expect(result.current.state?.chargeLevel).toBe(40);
  });

  it('useDrives paginates and appends via loadMore()', async () => {
    const client = new FakeClient();
    const rest = new FakeRest();
    rest.drivesPages = [
      { items: [{ driveId: 'd1' }], nextCursor: 'c1', hasMore: true },
      { items: [{ driveId: 'd2' }], nextCursor: null, hasMore: false },
    ];
    const { result } = renderHook(() => useDrives('v1', { limit: 1 }), {
      wrapper: wrapper(client, rest),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.drives.map((d) => d.driveId)).toEqual(['d1']);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      result.current.loadMore();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.drives).toHaveLength(2));
    expect(result.current.drives.map((d) => d.driveId)).toEqual(['d1', 'd2']);
    expect(result.current.hasMore).toBe(false);
  });

  it('a hook outside the provider throws a clear error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* silence React's dev-mode render-error log for this expected throw */
    });
    expect(() => render(createElement(HookProbe))).toThrow(/MyRoboTaxiProvider/);
  });
});

function HookProbe(): ReactNode {
  useConnectionState();
  return null;
}
