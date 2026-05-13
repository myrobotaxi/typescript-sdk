// MyRoboTaxi TypeScript SDK — core entry point.
//
// SDK surface lands ticket-by-ticket under P3:
//
//   - MYR-49 ✓ JSON Schema → TS types (via @myrobotaxi/contracts)
//   - MYR-81 ✓ Observability surface (Logger + MetricsRecorder + P1 redaction)
//   - MYR-50   WebSocket client (connect / reconnect / heartbeat)
//   - MYR-51   Snapshot + delta reconciler (atomic-group integrity)
//   - MYR-52   Typed CoreError union
//   - MYR-80   REST client (snapshot / drives / vehicles.list / invites / users.me)
//   - MYR-82   ReauthRequired carve-out
//   - MYR-83   Per-vehicle subscribe/unsubscribe
//   - MYR-84   Reconnect orchestration (REST snapshot before WS resume)

export const SDK_VERSION = '0.0.2';

export * from './observability/index.js';
