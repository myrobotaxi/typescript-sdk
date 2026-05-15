// Reconnect-orchestration types (MYR-84). Internal — not part of the
// public SDK surface; consumed by the React hooks (MYR-53) via relative
// import, mirroring the reconciler module convention.

import type { CoreError } from '../../errors/core-error.js';
import type { Logger } from '../../observability/logger.js';
import type { MetricsRecorder } from '../../observability/metrics.js';
import type { ReconcilerView } from '../reconciler/index.js';
import type { MyRoboTaxiClient } from '../../client/ws-client.js';
import type { RestClient } from '../../rest/rest-client.js';

export interface OrchestratorOptions {
  /** The WS client (MYR-50/83) — owns connect/reconnect + subscribed set. */
  readonly client: MyRoboTaxiClient;
  /** The REST client (MYR-80) — owns `/snapshot` + its own transport
   *  backoff (3 attempts). The orchestrator does NOT add a second retry
   *  layer; it reacts to the REST client's terminal result. */
  readonly rest: RestClient;
  readonly logger?: Logger;
  readonly metrics?: MetricsRecorder;
}

/**
 * Emitted when the REST `/snapshot` baseline could not be established for
 * a vehicle on (re)connect, after the REST client exhausted its backoff.
 * The vehicle's `dataState` stays `stale`/`error` and live frames are
 * dropped from the replay queue (the consumer is warned the state may be
 * lossy — MYR-84 AC).
 *
 * Design note (MYR-84): the ticket sketched `CoreError{ kind:
 * 'snapshot_unavailable' }`, but `CoreError` is a single contract-derived
 * `code`-keyed union with a compile-time exhaustiveness guard (MYR-52);
 * `snapshot_unavailable` is not a wire code, so inventing one would fork
 * the error model and break the guard. Instead this carries the REST
 * client's real typed `error` plus the `vehicleId` the SDK could not
 * resolve from the wire (consistent with the MYR-82/83 precedent: the
 * contract-derived union stays the single source of truth).
 */
export interface SnapshotUnavailable {
  readonly kind: 'snapshotUnavailable';
  readonly vehicleId: string;
  readonly error: CoreError;
}

export type OrchestratorEvent = SnapshotUnavailable;

export type OrchestratorListener = (event: OrchestratorEvent) => void;

export type { ReconcilerView };
