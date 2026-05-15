// MyRoboTaxi TypeScript SDK — core entry point.
//
// SDK surface lands ticket-by-ticket under P3:
//
//   - MYR-49 ✓ JSON Schema → TS types (via @myrobotaxi/contracts)
//   - MYR-81 ✓ Observability surface (Logger + MetricsRecorder + P1 redaction)
//   - MYR-52 ✓ Typed CoreError union
//   - MYR-51 ✓ Snapshot + delta reconciler (internal — used by hooks)
//   - MYR-50 ✓ WebSocket client (connect / reconnect / heartbeat / watchdog)
//   - MYR-80 ✓ REST client (snapshot / drives / vehicles.list / invites / users.me)
//   - MYR-82 ✓ ReauthRequired carve-out (typed guard + cross-transport parity)
//   - MYR-83 ✓ Per-vehicle subscribe/unsubscribe intent + defensive drop
//   - MYR-84 ✓ Reconnect orchestration (REST snapshot before WS resume)

export const SDK_VERSION = '0.0.8';

export * from './observability/index.js';
export * from './errors/index.js';
export * from './client/index.js';
export * from './rest/index.js';
