// useVehicleState(vehicleId) — live `{ state, dataState }` for one
// vehicle (MYR-53). `useSyncExternalStore` is the React 18 tear-free
// primitive: no double-subscribe, no torn reads under concurrent /
// strict mode. The orchestrator (MYR-84) drives the per-vehicle
// reconciler (snapshot before live frames); this hook just projects it.

import { useCallback, useEffect, useRef } from 'react';
import { useSyncExternalStore } from 'react';

import { GROUP_NAMES } from '../internal/reconciler/index.js';
import type { DataStateMap, ReconcilerView } from '../internal/reconciler/index.js';
import type { VehicleState } from '../types.js';
import { useSdk } from './context.js';

export interface VehicleStateResult {
  /** Merged vehicle state; `null` until the first snapshot lands. */
  readonly state: Readonly<Partial<VehicleState>> | null;
  /** Per-atomic-group freshness (loading/ready/stale/cleared/error). */
  readonly dataState: Readonly<DataStateMap>;
}

const LOADING: DataStateMap = Object.freeze(
  Object.fromEntries(GROUP_NAMES.map((g) => [g, 'loading'])) as DataStateMap,
);

export function useVehicleState(vehicleId: string): VehicleStateResult {
  const { client, orchestrator } = useSdk();

  // Register interest so the WS client is in selective mode for this
  // vehicle (MYR-83) and the orchestrator snapshots it on (re)connect.
  useEffect(() => {
    const sub = client.subscribe(vehicleId);
    return () => sub.unsubscribe();
  }, [client, vehicleId]);

  // getSnapshot MUST return a stable reference between events, else
  // useSyncExternalStore re-renders forever (getView() returns a fresh
  // frozen object each call). Cache it; refresh only when an event fires
  // or the vehicleId changes.
  const cache = useRef<{ id: string; view: ReconcilerView | null }>({
    id: vehicleId,
    view: orchestrator.getView(vehicleId),
  });
  if (cache.current.id !== vehicleId) {
    cache.current = { id: vehicleId, view: orchestrator.getView(vehicleId) };
  }

  const subscribe = useCallback(
    (onChange: () => void) =>
      orchestrator.observe(vehicleId, () => {
        cache.current = { id: vehicleId, view: orchestrator.getView(vehicleId) };
        onChange();
      }),
    [orchestrator, vehicleId],
  );
  const getSnapshot = useCallback(() => cache.current.view, []);

  const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return {
    state: view?.vehicle ?? null,
    dataState: view?.dataState ?? LOADING,
  };
}
