// MyRoboTaxi TypeScript SDK — core entry point.
//
// This is the scaffold placeholder. The actual SDK surface lands
// ticket-by-ticket under P3:
//
//   - MYR-49: JSON Schema → TS codegen (types)
//   - MYR-50: WebSocket client (connect / reconnect / heartbeat)
//   - MYR-51: Snapshot + delta reconciler (atomic-group integrity)
//   - MYR-52: Typed CoreError union
//   - MYR-80: REST client (snapshot / drives / vehicles.list / invites / users.me)
//   - MYR-81: Observability surface (Logger + MetricsRecorder + P1 redaction)
//   - MYR-82: ReauthRequired carve-out
//   - MYR-83: Per-vehicle subscribe/unsubscribe
//   - MYR-84: Reconnect orchestration (REST snapshot before WS resume)
//
// Until MYR-50 lands, this file intentionally exports a single
// version constant so consumers can verify they linked against the
// SDK without needing any of the not-yet-implemented surface.

export const SDK_VERSION = '0.0.1';
