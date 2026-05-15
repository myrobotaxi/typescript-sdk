// Internal reconnect-orchestration module (MYR-84). NOT part of the SDK
// public API — no package.json `exports` subpath, not re-exported from
// src/index.ts. Consumed within the package by the React hooks (MYR-53)
// via relative import, mirroring the reconciler module convention.

export { ReconnectOrchestrator } from './orchestrator.js';
export type {
  OrchestratorEvent,
  OrchestratorListener,
  OrchestratorOptions,
  SnapshotUnavailable,
} from './types.js';
