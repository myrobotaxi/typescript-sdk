// Pure-logic snapshot + delta reconciler (MYR-51).
//
// Merges the REST /snapshot baseline with live `vehicle_update` deltas
// while preserving atomic-group integrity (NFR-3.1, NFR-3.4) and
// event-driven freshness (NFR-3.7..3.9). No WebSocket, no React, no I/O,
// NO timers (NFR-3.7). Drives the per-group `dataState` machine
// (state-machine.md §2), the drive lifecycle (§3), and the
// snapshot-before-stream ordering invariant (§5.2 rule 4 / CG-SM-4).

import type { VehicleState } from '@myrobotaxi/contracts/types';
import type { Logger } from '../../observability/logger.js';
import type { MetricsRecorder } from '../../observability/metrics.js';
import { Metric } from '../../observability/metrics.js';
import { checkGroup, GROUP_FIELDS, GROUP_NAMES, groupsTouched } from './atomic-groups.js';
import type {
  ChangeEvent,
  DataState,
  DataStateMap,
  DriveLifecycle,
  DriveSummary,
  GroupName,
  Listener,
  ReconcilerView,
} from './types.js';

const STALENESS_GROUP_TAG: Record<GroupName, string> = {
  navigation: 'nav',
  charge: 'charge',
  gps: 'gps',
  gear: 'gear',
};

export interface ReconcilerOptions {
  /** Optional structured logger. Defaults to a no-op (the WS client
   *  injects its redaction-wrapped logger in production). */
  readonly logger?: Logger;
  /** Optional metrics sink. Defaults to a no-op. */
  readonly metrics?: MetricsRecorder;
}

/* eslint-disable @typescript-eslint/no-empty-function -- intentional no-op
   default sinks; the WS client injects real (redaction-wrapped) ones. */
const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
const NOOP_METRICS: MetricsRecorder = {
  counter() {},
  histogram() {},
  gauge() {},
};
/* eslint-enable @typescript-eslint/no-empty-function */

export class Reconciler {
  private vehicle: Partial<VehicleState> | null = null;
  private readonly dataState: DataStateMap = {
    navigation: 'loading',
    charge: 'loading',
    gps: 'loading',
    gear: 'loading',
  };
  private drive: DriveLifecycle = 'idle';
  private activeDriveId: string | null = null;
  private driveSummary: DriveSummary | null = null;

  // Snapshot-before-stream ordering (state-machine §5.2 rule 4). While a
  // group is `loading` after a reconnect, live frames for it are queued
  // and replayed once the snapshot lands.
  private awaitingSnapshot = false;
  private queued: Partial<VehicleState>[] = [];

  private readonly listeners = new Set<Listener>();
  private readonly logger: Logger;
  private readonly metrics: MetricsRecorder;

  constructor(opts: ReconcilerOptions = {}) {
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.metrics = opts.metrics ?? NOOP_METRICS;
  }

  // ---- subscription ------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getView(): ReconcilerView {
    return Object.freeze({
      vehicle: this.vehicle ? Object.freeze({ ...this.vehicle }) : null,
      dataState: Object.freeze({ ...this.dataState }),
      drive: this.drive,
      activeDriveId: this.activeDriveId,
      driveSummary: this.driveSummary ? Object.freeze({ ...this.driveSummary }) : null,
    });
  }

  // ---- snapshot ----------------------------------------------------------

  /** Apply a REST /snapshot baseline. Per-group: loading → ready (D-1)
   *  or loading → error (D-2) if a group fails its consistency predicates.
   *  Drains any queued live frames afterward (state-machine §5.2 rule 4). */
  applySnapshot(snapshot: Readonly<Partial<VehicleState>>): void {
    const next: Partial<VehicleState> = { ...(this.vehicle ?? {}), ...snapshot };
    for (const group of GROUP_NAMES) {
      const check = checkGroup(group, next, true);
      if (!check.ok) {
        this.transitionGroup(group, 'error', check.reason); // D-2
        continue;
      }
      this.transitionGroup(group, check.clear ? 'cleared' : 'ready'); // D-1
    }
    this.vehicle = next;
    this.emitState();

    // Replay queued live frames in arrival order, now that the baseline
    // is consistent (CG-SM-4: never apply a live frame before the snapshot).
    this.awaitingSnapshot = false;
    const replay = this.queued;
    this.queued = [];
    for (const fields of replay) this.applyVehicleUpdate(fields);
  }

  /** Snapshot fetch failed (D-2). Optionally scope to one group. */
  snapshotFailed(reason: string, group?: GroupName): void {
    const groups = group ? [group] : GROUP_NAMES;
    for (const g of groups) this.transitionGroup(g, 'error', reason);
    this.awaitingSnapshot = false;
    this.queued = [];
  }

  // ---- live deltas -------------------------------------------------------

  /** Apply a live `vehicle_update`. Routes fields to atomic groups and
   *  applies each group all-or-nothing (NFR-3.1/3.4): D-3 ready→ready,
   *  D-5 ready→cleared (atomic clear), D-6 ready→error (bad data),
   *  D-9 cleared→ready, D-12 error→ready. */
  applyVehicleUpdate(fields: Readonly<Partial<VehicleState>>): void {
    if (this.awaitingSnapshot) {
      // Queue until the snapshot lands (state-machine §5.2 rule 4).
      this.queued.push({ ...fields });
      return;
    }

    const touched = groupsTouched(fields as Record<string, unknown>);
    const accepted: Partial<VehicleState> = {};

    // Ungrouped fields (state-machine §4.3) update individually, no
    // dataState dimension. Freshness is implied by connectionState.
    for (const [k, v] of Object.entries(fields)) {
      if (!groupsTouchedHas(touched, k)) {
        (accepted as Record<string, unknown>)[k] = v;
      }
    }

    for (const group of touched) {
      const merged: Partial<VehicleState> = { ...(this.vehicle ?? {}) };
      for (const f of GROUP_FIELDS[group]) {
        if (f in fields) (merged as Record<string, unknown>)[f] = (fields as Record<string, unknown>)[f];
      }
      const check = checkGroup(group, merged, false);
      if (!check.ok) {
        // D-6 / D-10: invalid data — log + error state, retain
        // last-known-good (do NOT merge the bad fields).
        this.logger.error('reconciler: invalid group data', {
          group,
          reason: check.reason,
        });
        this.transitionGroup(group, 'error', check.reason);
        continue;
      }
      if (check.clear) {
        // D-5: atomic clear — null every field in the group together
        // (NFR-3.9). cleared state.
        for (const f of GROUP_FIELDS[group]) {
          (accepted as Record<string, unknown>)[f] = null;
        }
        this.transitionGroup(group, 'cleared');
        continue;
      }
      // D-3 / D-9 / D-12: apply the group's provided fields atomically.
      for (const f of GROUP_FIELDS[group]) {
        if (f in fields) (accepted as Record<string, unknown>)[f] = (fields as Record<string, unknown>)[f];
      }
      this.transitionGroup(group, 'ready');
    }

    this.vehicle = { ...(this.vehicle ?? {}), ...accepted };
    this.emitState();

    // While driving, a vehicle_update carrying a GPS route point is a
    // logical `drive_updated` (state-machine §3.3 DR-2; the wire carries
    // vehicle_update, not a distinct message).
    if (this.drive === 'driving' && touched.has('gps')) {
      this.emit({ kind: 'drive', from: 'driving', to: 'driving' });
    }
  }

  // ---- drive lifecycle ---------------------------------------------------

  applyDriveStarted(payload: { driveId: string }): void {
    const from = this.drive;
    // DR-1 idle→driving or DR-6 ended→driving (new drive pre-ack).
    this.drive = 'driving';
    this.activeDriveId = payload.driveId;
    this.driveSummary = null;
    this.emit({ kind: 'drive', from, to: 'driving' });
  }

  applyDriveEnded(summary: DriveSummary): void {
    if (this.drive !== 'driving') return; // only DR-3 from driving
    this.drive = 'ended';
    this.activeDriveId = summary.driveId;
    this.driveSummary = summary;
    this.emit({ kind: 'drive', from: 'driving', to: 'ended', summary });
  }

  /** Consumer processed the drive summary (DR-5 ended→idle). */
  acknowledgeDrive(): void {
    if (this.drive !== 'ended') return;
    this.drive = 'idle';
    this.activeDriveId = null;
    this.driveSummary = null;
    this.emit({ kind: 'drive', from: 'ended', to: 'idle' });
  }

  // ---- connection lifecycle ---------------------------------------------

  /** WebSocket disconnected. ALL groups ready→stale (D-4); cached values
   *  retained (NFR-3.12/3.13). If driving, driving→idle (DR-4). */
  onDisconnected(): void {
    for (const group of GROUP_NAMES) {
      if (this.dataState[group] === 'ready') {
        this.transitionGroup(group, 'stale');
        this.metrics.counter(Metric.DATA_STALENESS_EVENTS, {
          group: STALENESS_GROUP_TAG[group],
        });
      }
    }
    if (this.drive === 'driving') {
      this.drive = 'idle';
      this.activeDriveId = null;
      this.emit({ kind: 'drive', from: 'driving', to: 'idle' });
    }
  }

  /** Reconnect started — re-fetch snapshot. ALL non-error groups → loading
   *  (D-7/D-8/D-11); cached data stays visible during the fetch
   *  (NFR-3.12). Live frames are queued until the snapshot lands. */
  onReconnectRequested(): void {
    this.awaitingSnapshot = true;
    this.queued = []; // idempotent: a fresh reconnect supersedes (§5.2 rule 5)
    for (const group of GROUP_NAMES) {
      this.transitionGroup(group, 'loading');
    }
  }

  // ---- internals ---------------------------------------------------------

  private transitionGroup(group: GroupName, to: DataState, reason?: string): void {
    const from = this.dataState[group];
    if (from === to && to !== 'ready') return; // ready→ready still emits (D-3)
    this.dataState[group] = to;
    this.emit({ kind: 'dataState', group, from, to, reason });
  }

  private emitState(): void {
    if (this.vehicle) this.emit({ kind: 'state', vehicle: { ...this.vehicle } });
  }

  private emit(event: ChangeEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        this.logger.error('reconciler: listener threw', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

function groupsTouchedHas(groups: Set<GroupName>, field: string): boolean {
  for (const g of groups) {
    if ((GROUP_FIELDS[g] as readonly string[]).includes(field)) return true;
  }
  return false;
}
