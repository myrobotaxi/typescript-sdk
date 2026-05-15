// Reconnect orchestration (MYR-84): REST /snapshot baseline BEFORE the
// WS live stream resumes, on cold connect AND every reconnect (NFR-3.11,
// websocket-protocol.md §7.2, state-machine.md §5.1/§5.2).
//
// This is a pure COMPOSITION layer over three existing pieces — it does
// not modify the WS client:
//
//   - MyRoboTaxiClient (MYR-50/83) owns connect/reconnect + the
//     subscribed set + emits connectionState/frame events.
//   - RestClient (MYR-80) owns `/snapshot` AND its own 3-attempt
//     transport backoff. We do NOT add a second retry layer (that would
//     be 9 effective attempts); the REST client's terminal `ok:false`
//     IS the ticket's "after 3 failed attempts".
//   - Reconciler (MYR-51) already owns the snapshot-before-frame
//     ordering: `onReconnectRequested()` sets `awaitingSnapshot` so
//     `applyVehicleUpdate()` queues; `applySnapshot()` replays the queue
//     (CG-SM-4). We only sequence the calls.
//
// Per-vehicle: the Reconciler is single-vehicle, so we hold one per
// subscribed vehicleId. Snapshotting is driven by
// `client.getSubscribedVehicles()` (MYR-83) — the ticket's "for every
// subscribed vehicleId". Generation counters make rapid reconnects
// idempotent (chaos AC: exactly one effective snapshot per reconnect, no
// stale apply).

import type { CoreError } from '../../errors/core-error.js';
import { ConsoleLogger } from '../../observability/logger.js';
import { RedactingLogger } from '../../observability/redacting-logger.js';
import type { Logger } from '../../observability/logger.js';
import type { MetricsRecorder } from '../../observability/metrics.js';
import { Metric } from '../../observability/metrics.js';
import { Reconciler } from '../reconciler/index.js';
import type { ReconcilerView } from '../reconciler/index.js';
import type { ClientEvent, ConnectionState } from '../../client/types.js';
import type {
  OrchestratorEvent,
  OrchestratorListener,
  OrchestratorOptions,
} from './types.js';

const NOOP_METRICS: MetricsRecorder = {
  counter() {
    /* no-op */
  },
  histogram() {
    /* no-op */
  },
  gauge() {
    /* no-op */
  },
};

interface VehicleSlot {
  readonly reconciler: Reconciler;
  /** Bumped on every reconnect cycle. A snapshot fetch captures this at
   *  start and discards its result if it changed (supersession). */
  generation: number;
  controller: AbortController | null;
}

export class ReconnectOrchestrator {
  private readonly client: OrchestratorOptions['client'];
  private readonly rest: OrchestratorOptions['rest'];
  private readonly logger: Logger;
  private readonly metrics: MetricsRecorder;

  private readonly slots = new Map<string, VehicleSlot>();
  private readonly listeners = new Set<OrchestratorListener>();
  private offClient: (() => void) | null = null;
  private destroyed = false;

  constructor(opts: OrchestratorOptions) {
    this.client = opts.client;
    this.rest = opts.rest;
    this.logger = new RedactingLogger(opts.logger ?? new ConsoleLogger());
    this.metrics = opts.metrics ?? NOOP_METRICS;
  }

  /** Attach to the WS event stream and open the connection. Idempotent. */
  start(): void {
    if (this.destroyed || this.offClient) return;
    this.offClient = this.client.onEvent((e) => this.onClientEvent(e));
    this.client.connect();
  }

  /** Frozen reconciler view for a vehicle, or null if not tracked. */
  getView(vehicleId: string): ReconcilerView | null {
    return this.slots.get(vehicleId)?.reconciler.getView() ?? null;
  }

  /** Observe a vehicle's reconciler change-event stream. Creates the
   *  slot if needed (so a hook can subscribe before the first connect). */
  observe(vehicleId: string, listener: (e: unknown) => void): () => void {
    return this.ensureSlot(vehicleId).reconciler.subscribe(listener);
  }

  /** Orchestrator-level events (snapshotUnavailable). */
  onEvent(listener: OrchestratorListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Force a fresh snapshot for one vehicle (or all tracked) — used for a
   *  late subscribe or a server `snapshot_required`. No-op if not
   *  currently connected (the next reconnect will snapshot anyway). */
  refresh(vehicleId?: string): void {
    if (this.destroyed || this.client.connectionState !== 'connected') return;
    const ids = vehicleId ? [vehicleId] : [...this.slots.keys()];
    for (const id of ids) {
      const slot = this.ensureSlot(id);
      slot.reconciler.onReconnectRequested();
      void this.fetchSnapshot(id, slot);
    }
  }

  /** C-12 terminal: abort in-flight fetches, detach, release. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const slot of this.slots.values()) {
      slot.controller?.abort();
      slot.controller = null;
    }
    this.offClient?.();
    this.offClient = null;
    this.listeners.clear();
  }

  // ---- internals ---------------------------------------------------------

  private subscribedIds(): string[] {
    return [...this.client.getSubscribedVehicles()];
  }

  private ensureSlot(vehicleId: string): VehicleSlot {
    let slot = this.slots.get(vehicleId);
    if (!slot) {
      slot = {
        reconciler: new Reconciler({ logger: this.logger, metrics: this.metrics }),
        generation: 0,
        controller: null,
      };
      this.slots.set(vehicleId, slot);
    }
    return slot;
  }

  private onClientEvent(e: ClientEvent): void {
    if (this.destroyed) return;
    if (e.kind === 'connectionState') {
      this.onConnectionState(e.to);
      return;
    }
    if (e.kind === 'frame') {
      this.routeFrame(e.type, e.payload);
    }
    // kind === 'error': WS-level errors flow through the client's own
    // event stream; the orchestrator only owns snapshot orchestration.
  }

  private onConnectionState(to: ConnectionState): void {
    switch (to) {
      case 'connecting': {
        // Cold connect AND reconnect both pass through here. Bump
        // generation + arm the reconciler so live frames queue until the
        // fresh snapshot lands (state-machine §5.2 rule 4/5). Snapshot
        // the union of currently-subscribed ids and any already-tracked
        // slot (a vehicle may have been unsubscribed but still healing).
        for (const id of new Set([...this.subscribedIds(), ...this.slots.keys()])) {
          const slot = this.ensureSlot(id);
          slot.generation += 1;
          slot.controller?.abort();
          slot.controller = null;
          slot.reconciler.onReconnectRequested();
        }
        break;
      }
      case 'connected': {
        // Live stream is up but we must NOT let frames apply on top of a
        // stale baseline — fetch the REST snapshot first. Frames arriving
        // now are queued by the reconciler (awaitingSnapshot was set on
        // 'connecting') and replayed by applySnapshot().
        for (const id of this.subscribedIds()) {
          const slot = this.ensureSlot(id);
          void this.fetchSnapshot(id, slot);
        }
        break;
      }
      case 'disconnected':
      case 'error': {
        // NFR-3.8b: ready → stale, cached values retained. (A following
        // 'connecting' will move non-error groups to loading.)
        for (const slot of this.slots.values()) {
          slot.controller?.abort();
          slot.controller = null;
          slot.reconciler.onDisconnected();
        }
        break;
      }
      // 'initializing': nothing to do.
    }
  }

  private async fetchSnapshot(vehicleId: string, slot: VehicleSlot): Promise<void> {
    const gen = slot.generation;
    const controller = new AbortController();
    slot.controller = controller;

    const result = await this.rest.snapshot.get(vehicleId, { signal: controller.signal });

    // Supersession / teardown guards: a newer reconnect bumped the
    // generation, or destroy() fired — discard this (now stale) result so
    // no late snapshot is applied on top of a fresher baseline (chaos AC).
    if (this.destroyed || slot.generation !== gen) {
      this.logger.debug('orchestrator: discarding superseded snapshot', { vehicleId });
      return;
    }
    slot.controller = null;

    if (result.ok) {
      slot.reconciler.applySnapshot(result.data);
      return;
    }

    // REST client already exhausted its 3-attempt backoff — terminal.
    this.metrics.counter(Metric.DATA_STALENESS_EVENTS, { reason: 'snapshot_unavailable' });
    slot.reconciler.snapshotFailed(result.error.code);
    this.emit({ kind: 'snapshotUnavailable', vehicleId, error: result.error as CoreError });
  }

  private routeFrame(type: string, payload: unknown): void {
    const vehicleId = (payload as { vehicleId?: string } | undefined)?.vehicleId;
    if (!vehicleId) return;
    const slot = this.slots.get(vehicleId);
    if (!slot) return; // not a tracked/subscribed vehicle
    switch (type) {
      case 'vehicle_update':
        slot.reconciler.applyVehicleUpdate(payload as Record<string, unknown>);
        break;
      case 'drive_started':
        slot.reconciler.applyDriveStarted(payload as { driveId: string });
        break;
      case 'drive_ended':
        slot.reconciler.applyDriveEnded(payload as never);
        break;
      // heartbeat / connectivity carry no reconciler state.
    }
  }

  private emit(event: OrchestratorEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        this.logger.error('orchestrator: listener threw', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
