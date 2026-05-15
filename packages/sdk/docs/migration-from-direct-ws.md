# Migrating the Next.js app off the direct WebSocket client

Audience: the `my-robo-taxi` Next.js codebase, replacing its hand-rolled
WebSocket client + Zustand reconciliation with `@myrobotaxi/sdk`. This
unblocks **P7 — Frontend integration**.

The SDK takes over four things the app currently does by hand: the WS
connection lifecycle, the REST snapshot, **reconnect ordering**
(snapshot before live stream — NFR-3.11), and **atomic-group
reconciliation** (no torn nav/charge/gps/gear state). Most of the
existing client-side state machine becomes dead code.

> Paths below use the app's conventional layout (`src/features/…`,
> `src/lib/…`). Grep your tree for the *patterns* (`new WebSocket(`,
> `onmessage`, the vehicle store) and map them — the replacement is the
> same regardless of exact path.

## 1. Provider at the app root

Construct the clients once and wrap the tree. **No module-level
singletons** — the SDK forbids globals; the provider owns lifecycle.

```tsx
// app/providers.tsx (or pages/_app.tsx)
'use client';
import { MyRoboTaxiClient, RestClient } from '@myrobotaxi/sdk';
import { MyRoboTaxiProvider } from '@myrobotaxi/sdk/react';

export function SdkProvider({ children }: { children: React.ReactNode }) {
  const getToken = useCallback(
    async () => (await fetch('/api/sdk-token')).text(), []);
  const client = useMemo(
    () => new MyRoboTaxiClient({ url: process.env.NEXT_PUBLIC_WSS_URL!, getToken }), []);
  const rest = useMemo(
    () => new RestClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL!, getToken }), []);
  return <MyRoboTaxiProvider client={client} rest={rest}>{children}</MyRoboTaxiProvider>;
}
```

## 2. Per-surface replacement checklist

| Existing (delete / replace) | SDK replacement |
|---|---|
| `src/lib/ws/socket.ts` — `new WebSocket()`, reconnect/backoff, heartbeat timers | **delete** — `MyRoboTaxiClient` owns it |
| `src/lib/ws/handlers.ts` — `onmessage` switch applying frames to the store | **delete** — `useVehicleState` returns reconciled state |
| `src/features/vehicles/state/*` — Zustand store, snapshot-vs-frame merge, staleness flags | **delete the reconciliation slices**; keep only UI-local state |
| Components reading `useVehicleStore(s => s.vehicle)` | `const { state, dataState } = useVehicleState(vehicleId)` |
| Manual "connecting…" banners off a store flag | `const conn = useConnectionState()` |
| `fetch('/api/vehicles/:id/snapshot')` on mount + reconnect | **delete** — the provider's orchestrator does snapshot-before-stream |
| Drive history pages doing manual cursor fetches | `const { drives, hasMore, loadMore } = useDrives(vehicleId)` |
| `drive_started`/`drive_ended` toast wiring in the message handler | `useDriveLifecycle((e) => toast(e.type))` |
| Ad-hoc `if (msg.error === 'AUTH_FAILED')` string checks | `CoreError` + `isReauthRequired` / `isTerminal` / `isRetryable` |

After this, `src/features/vehicles/state/` should retain only
view-model/UI state. The snapshot/frame merge, freshness timers, and
reconnect re-fetch logic are **all** redundant — deleting them is the
point (it removes the class of torn-state bugs the reconciler prevents).

## 3. Staleness & freshness

The app likely has client-side timers marking data "stale" after N
seconds. **Delete them.** Freshness is event-driven (NFR-3.7):
`dataState[group]` goes `stale` on disconnect, `loading` during
reconnect, `ready` after the snapshot re-lands — per atomic group. Drive
the "stale" affordance off `dataState`, not a `setTimeout`.

## 4. Auth wiring (NextAuth ↔ ReauthRequired)

The app already gates sensitive ops on `session.user.authTime` (MYR-76).
Bridge it into the SDK's carve-out: when any SDK call surfaces
`reauth_required`, drive an **interactive** sign-in (a silent refresh
cannot advance `auth_time`).

```ts
import { isReauthRequired } from '@myrobotaxi/sdk';
import { signIn } from 'next-auth/react';

function onSdkError(err: CoreError) {
  if (isReauthRequired(err)) {
    void signIn(undefined, { prompt: 'login', callbackUrl: location.pathname });
    return;
  }
  // existing error UI for terminal errors
}
```

Wire `onSdkError` to `client.onEvent` (`kind: 'error'`) and to the
`!r.ok` branch of REST calls. Full rationale: [`auth.md`](./auth.md).

## 5. Test migration

Existing tests that stub `global.WebSocket` / assert on raw frames must
mock at the **SDK** boundary instead:

- **Component tests** — wrap in `<MyRoboTaxiProvider>` with a fake
  `client` (a `{ onEvent, connect, subscribe, getSubscribedVehicles,
  connectionState }` stub) and a fake `rest` (`{ snapshot: { get },
  drives: { list } }` returning canned `RestResult`s). Drive updates by
  invoking the captured `onEvent` listener. See the SDK's own
  `src/react/hooks.test.tsx` for the exact harness shape.
- **Store tests** — most delete with the store. What remains
  (view-model selectors) no longer needs a WS mock.
- **Reconciliation tests** — delete. The SDK's conformance suite
  (MYR-55) owns snapshot/delta/atomic-group correctness; re-testing it
  in the app duplicates coverage and rots.

## 6. Order of operations (low-risk rollout)

1. Land the provider + `useVehicleState` on **one** read-only surface;
   diff against the old store in the same view behind a flag.
2. Verify reconnect: kill the socket, confirm snapshot-before-frames (no
   flicker) and `dataState` transitions.
3. Migrate the remaining surfaces; delete `src/lib/ws/*` and the store
   reconciliation slices in the same PR that removes their last caller.
4. Delete the now-dead WS/store tests with their subjects.

Removing code is the deliverable — a half-migrated surface that still
runs the old socket alongside the SDK will double-connect.
