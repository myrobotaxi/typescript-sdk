---
"@myrobotaxi/sdk": patch
---

MYR-83: per-vehicle subscribe/unsubscribe client surface.
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
