# @myrobotaxi/sdk

## 0.1.0

### Minor Changes

- [#25](https://github.com/myrobotaxi/typescript-sdk/pull/25) [`8a1ad0b`](https://github.com/myrobotaxi/typescript-sdk/commit/8a1ad0bea5ef84bf5892bf21dd4f610c81f1c146) Thanks [@tnando](https://github.com/tnando)! - MYR-53: `@myrobotaxi/sdk/react` — idiomatic React hooks. Adds
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

### Patch Changes

- [#24](https://github.com/myrobotaxi/typescript-sdk/pull/24) [`705939c`](https://github.com/myrobotaxi/typescript-sdk/commit/705939c01f1eed04f1212f366edf083114ce2f48) Thanks [@tnando](https://github.com/tnando)! - MYR-103: scope the WS client's `auth_failed_total{subCode}` emission to
  `auth_failed` outcomes only, matching the REST scoping shipped in
  MYR-82. Previously the WS client incremented the counter on every
  `error` frame (rate_limited / internal_error / not_found / …), tagging
  non-auth errors as `subCode: 'null'` and inflating the metric. The
  `{subCode}` tag shape is unchanged so a single cross-transport
  dashboard still sums correctly. No public API change.

- [#27](https://github.com/myrobotaxi/typescript-sdk/pull/27) [`44a8473`](https://github.com/myrobotaxi/typescript-sdk/commit/44a8473ea2db8665c4c6fac3d339435dedb19fb4) Thanks [@tnando](https://github.com/tnando)! - MYR-55: contract conformance test suite (NFR-3.45 ship gate). A
  canonical fixture corpus (`src/conformance/fixtures/{websocket,rest,
atomic-groups,edge-cases}`) is driven through the REAL SDK code paths
  (`wsErrorToCoreError` / `restErrorToCoreError` / the reconciler) — one
  vitest case per fixture, so failure blocks merge in the standard `test`
  CI check on any contract-touching PR. A committed `manifest.json` (the
  Swift P4 conformance suite's single source of truth) is drift-guarded by
  a test (`UPDATE_MANIFEST=1 npm test` regenerates). Test-only — not
  bundled, no public API or version change.

- [#22](https://github.com/myrobotaxi/typescript-sdk/pull/22) [`4db2280`](https://github.com/myrobotaxi/typescript-sdk/commit/4db228097c71dd8b6658618b3c2ccc63a8185971) Thanks [@tnando](https://github.com/tnando)! - MYR-82: add the `reauth_required` carve-out as a typed, cross-transport
  surface. New public exports `isReauthRequired()` type guard +
  `ReauthRequiredError` type alias narrow the existing code-keyed
  `CoreError` union (no second discriminator). REST now emits
  `auth_failed_total{subCode}` for parity with the WS client. Adds
  end-to-end conformance tests proving the carve-out behaves identically
  over REST and WebSocket, plus `docs/auth.md` with the NextAuth
  `signIn({ prompt: 'login' })` remediation pattern.

- [#21](https://github.com/myrobotaxi/typescript-sdk/pull/21) [`4ba4fdc`](https://github.com/myrobotaxi/typescript-sdk/commit/4ba4fdc5369ac2b1294d084355f040620690f22b) Thanks [@tnando](https://github.com/tnando)! - MYR-83: per-vehicle subscribe/unsubscribe client surface.
  `MyRoboTaxiClient` gains `subscribe(vehicleId)` → `Subscription`,
  `subscribeAll()`, and `getSubscribedVehicles()`; the MYR-50 event
  listener is renamed `subscribe` → `onEvent` (safe pre-1.0, no external
  consumers). Subscriptions are tracked client-side, queued before
  `auth_ok`, re-sent on every reconnect, and enforced by a client-side
  defensive drop of vehicle-scoped frames outside the subscribed set.

  Per the contract (DV-07) the server does not process subscribe/
  unsubscribe yet and the wire `ErrorPayload` carries no vehicleId, so
  there is intentionally **no** per-vehicle `subscribeRejected` event —
  `permission_denied` / `vehicle_not_owned` surface as the generic
  `error` event with MYR-50 C-8 terminal handling. Honest per-vehicle
  rejection is blocked on an `ErrorPayload` contract change (follow-up).

- [#23](https://github.com/myrobotaxi/typescript-sdk/pull/23) [`57b0e34`](https://github.com/myrobotaxi/typescript-sdk/commit/57b0e34c3e7b9759087f81da8ed8932eeec6d71b) Thanks [@tnando](https://github.com/tnando)! - MYR-84: reconnect orchestration — the SDK now re-fetches the REST
  `/snapshot` baseline BEFORE resuming the WS live stream on cold connect
  AND every reconnect (NFR-3.11, websocket-protocol.md §7.2). New internal
  `ReconnectOrchestrator` composes the WS client (MYR-50/83), REST client
  (MYR-80), and per-vehicle reconcilers (MYR-51): groups go `stale` on
  disconnect, `loading` on reconnect, live frames are queued until the
  snapshot lands (CG-SM-4), and rapid reconnects supersede stale in-flight
  fetches (generation guard). Snapshot failure surfaces a typed
  `snapshotUnavailable` event (carrying the REST `CoreError` + vehicleId —
  no new wire code) and keeps the vehicle non-`ready`. `destroy()` aborts
  in-flight fetches via `AbortSignal`. Consumed by the React hooks
  (MYR-53); not part of the public entry surface.

- [#28](https://github.com/myrobotaxi/typescript-sdk/pull/28) [`83fd43b`](https://github.com/myrobotaxi/typescript-sdk/commit/83fd43b8c4882528e93ea07a1111c9a36f0de8f0) Thanks [@tnando](https://github.com/tnando)! - MYR-85: consumer-facing docs (P7 onboarding). Rewrites the published
  `README.md` (quickstart, `getToken()` + `reauth_required`, the four
  React hooks, the `CoreError` reference table, subscribe/unsubscribe
  guidance, observability, bundle budget) and adds
  `docs/migration-from-direct-ws.md` — a Next.js per-surface
  delete/replace checklist for moving `my-robo-taxi` off its hand-rolled
  WebSocket client + Zustand reconciliation onto the SDK, including the
  NextAuth ↔ ReauthRequired bridge and SDK-boundary test migration.
  Docs-only; no API or behaviour change.
