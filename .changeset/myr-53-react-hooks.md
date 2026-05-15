---
"@myrobotaxi/sdk": minor
---

MYR-53: `@myrobotaxi/sdk/react` — idiomatic React hooks. Adds
`<MyRoboTaxiProvider client rest>` (owns the MYR-84 orchestrator, no
module singletons), `useVehicleState(vehicleId)` → `{ state, dataState }`,
`useConnectionState()`, `useDriveLifecycle(handler)` (drive_started /
drive_ended side-effect hook), and `useDrives(vehicleId, { limit })`
(cursor-paginated REST list with `loadMore`/`refresh`). Logic-only
(NFR-3.32) — no JSX components, built with `createElement`; React is a
peerDependency and `external` in the build. Tear-free / strict-mode safe
via `useSyncExternalStore`; tree-shakeable per-hook modules (react
bundle 7.33 kB gzipped, budget 20 kB). RTL test suite with a mocked
client/REST.
