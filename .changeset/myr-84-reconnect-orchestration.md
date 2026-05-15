---
"@myrobotaxi/sdk": patch
---

MYR-84: reconnect orchestration — the SDK now re-fetches the REST
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
