// Reconciler public-internal types. Not part of the SDK's public API —
// consumed by the React hooks (MYR-53) and the WS client (MYR-50).

import type { VehicleState } from '@myrobotaxi/contracts/types';

/** The four atomic groups (state-machine.md §2, vehicle-state-schema.md §2). */
export type GroupName = 'navigation' | 'charge' | 'gps' | 'gear';

/** Per-group freshness (state-machine.md §2.2). */
export type DataState = 'loading' | 'ready' | 'stale' | 'cleared' | 'error';

/** Drive lifecycle (state-machine.md §3.2). */
export type DriveLifecycle = 'idle' | 'driving' | 'ended';

export type DataStateMap = Record<GroupName, DataState>;

/** Summary stats from a `drive_ended` frame (websocket-protocol §4 / DriveEndedPayload). */
export interface DriveSummary {
  readonly driveId: string;
  readonly distance?: number;
  readonly duration?: number;
  readonly avgSpeed?: number;
  readonly maxSpeed?: number;
  readonly timestamp?: string;
}

/** Immutable view the consumer renders. */
export interface ReconcilerView {
  /** Merged vehicle state. `null` until the first snapshot lands. */
  readonly vehicle: Readonly<Partial<VehicleState>> | null;
  readonly dataState: Readonly<DataStateMap>;
  readonly drive: DriveLifecycle;
  /** Active drive id while `drive === 'driving'`/`'ended'`, else null
   *  (state-machine.md §3.3 DR-1: "Store drive ID"). */
  readonly activeDriveId: string | null;
  /** Present only while `drive === 'ended'`. */
  readonly driveSummary: DriveSummary | null;
}

export type ChangeEvent =
  | { readonly kind: 'state'; readonly vehicle: Readonly<Partial<VehicleState>> }
  | {
      readonly kind: 'dataState';
      readonly group: GroupName;
      readonly from: DataState;
      readonly to: DataState;
      readonly reason?: string;
    }
  | {
      readonly kind: 'drive';
      readonly from: DriveLifecycle;
      readonly to: DriveLifecycle;
      readonly summary?: DriveSummary;
    };

export type Listener = (event: ChangeEvent) => void;
