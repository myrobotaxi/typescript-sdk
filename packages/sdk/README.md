# @myrobotaxi/sdk

TypeScript SDK for the MyRoboTaxi telemetry server. **Logic-only** — no UI, no map, no theme. You bring the components; the SDK owns the WebSocket lifecycle, the REST snapshot, reconnect orchestration, atomic-group state reconciliation, and a typed error model.

## Installation

```bash
npm install @myrobotaxi/sdk
```

Three entry points:

```ts
import { MyRoboTaxiClient, RestClient, isReauthRequired } from '@myrobotaxi/sdk';
import { MyRoboTaxiProvider, useVehicleState } from '@myrobotaxi/sdk/react';
import type { VehicleState, WebSocketEnvelope } from '@myrobotaxi/sdk/types';
```

`/types` re-exports the pre-generated wire types from [@myrobotaxi/contracts](https://github.com/myrobotaxi/contracts) (the canonical protocol source of truth) and tree-shakes to zero bytes for types-only consumers.

## Quickstart

Snapshot baseline + first live frame, ~10 lines:

```ts
import { MyRoboTaxiClient, RestClient } from '@myrobotaxi/sdk';

const getToken = async () => (await fetch('/api/sdk-token')).text(); // your auth
const rest = new RestClient({ baseUrl: 'https://telemetry.example.com', getToken });
const client = new MyRoboTaxiClient({ url: 'wss://telemetry.example.com/api/ws', getToken });

const snap = await rest.snapshot.get('veh_123');     // REST baseline first
if (snap.ok) render(snap.data);                      // NFR-3.11 ordering
client.onEvent((e) => {
  if (e.kind === 'frame' && e.type === 'vehicle_update') render(e.payload);
});
client.subscribe('veh_123');                         // selective mode
client.connect();
```

In React, the `MyRoboTaxiProvider` does the snapshot-before-stream orchestration for you — see [React hooks](#react-hooks).

## Auth: `getToken()`

Every (re)connect and every REST request calls your `getToken()`; the SDK injects the bearer token and **never stores it** (FR-6.1, never logged). It is the only auth wiring you must provide.

```ts
const getToken = async () => {
  const res = await fetch('/api/sdk-token'); // a route that returns the current access token
  return res.text();
};
```

One auth case you **must** handle: `reauth_required`. The token is valid but the user's last interactive sign-in is too old for a sensitive op — a silent refresh **cannot** fix it. Branch with the guard and trigger an interactive sign-in:

```ts
import { isReauthRequired } from '@myrobotaxi/sdk';

const r = await rest.snapshot.get('veh_123');
if (!r.ok && isReauthRequired(r.error)) {
  await signIn('your-provider', { prompt: 'login' }); // NextAuth — forces re-auth
}
```

Full rationale and the NextAuth pattern: [`docs/auth.md`](./docs/auth.md).

## Error handling

`CoreError` is a single `code`-keyed discriminated union spanning **both** transports — the same code maps to the same variant whether it arrived over WS or REST, so consumer code is one switch. Never string-match `error.message` (FR-7.1); never branch on `error.transport` (diagnostic only).

```ts
import { isRetryable, isTerminal, isReauthRequired } from '@myrobotaxi/sdk';

function handle(err: CoreError) {
  if (isReauthRequired(err)) return promptReauth();   // auth_failed + reauth_required
  if (isTerminal(err)) return surfaceToUser(err);      // permission_denied, not_found, …
  // isRetryable(err) === true → the SDK already auto-retries with backoff
}
```

| code | retryable | terminal | notes |
|---|---|---|---|
| `auth_failed` | no | yes | `subCode: 'reauth_required'` → interactive re-auth |
| `auth_timeout` | yes | no | missed auth deadline → auto-retry |
| `permission_denied` / `vehicle_not_owned` | no | yes | surface to UI |
| `rate_limited` | yes | no | `subCode: 'device_cap'` → terminal (too many devices) |
| `internal_error` / `snapshot_required` | yes | no | transient |
| `not_found` / `invalid_request` | no | yes | REST-only |
| `service_unavailable` | yes | no | REST-only (503); honors `Retry-After` |

Source of truth: `rest-api.md` §4.1.1 + `websocket-protocol.md` §6.1.1.

## Subscribe / unsubscribe

The server fans out **every owned vehicle** at the auth handshake today (DV-07). `client.subscribe(vehicleId)` flips the client to **selective mode** — a client-side defensive drop of frames outside your set, plus a forward-compatible wire intent for when per-vehicle server filtering lands.

- Using the React hooks? **You don't call `subscribe` yourself** — `useVehicleState(vehicleId)` does it (and unsubscribes on unmount).
- Plain client? Call `client.subscribe(vehicleId)` for each vehicle you render; `client.subscribeAll()` to opt back into fan-out; `client.getSubscribedVehicles()` to inspect.

`permission_denied` / `vehicle_not_owned` are **not** attributed to a specific subscribe (the wire `ErrorPayload` carries no vehicleId) — they surface as a generic `error` event. Per-vehicle rejection is tracked in MYR-102.

## React hooks

```tsx
import { MyRoboTaxiProvider, useVehicleState, useConnectionState,
         useDriveLifecycle, useDrives } from '@myrobotaxi/sdk/react';

function App() {
  const client = useMemo(() => new MyRoboTaxiClient({ url, getToken }), []);
  const rest = useMemo(() => new RestClient({ baseUrl, getToken }), []);
  return (
    <MyRoboTaxiProvider client={client} rest={rest}>
      <Dashboard vehicleId="veh_123" />
    </MyRoboTaxiProvider>
  );
}

function Dashboard({ vehicleId }: { vehicleId: string }) {
  const { state, dataState } = useVehicleState(vehicleId);   // snapshot→live, reconciled
  const conn = useConnectionState();                          // 'connected' | 'disconnected' | …
  const { drives, loading, hasMore, loadMore } = useDrives(vehicleId, { limit: 20 });
  useDriveLifecycle((e) => toast(e.type));                    // drive_started / drive_ended
  if (!state) return <Spinner connection={conn} />;
  return <Telemetry state={state} stale={dataState.gps !== 'ready'} drives={drives} />;
}
```

- **`useVehicleState(vehicleId)`** → `{ state, dataState }`. The provider's orchestrator fetches the REST snapshot before resuming the live stream on every (re)connect (NFR-3.11), so you never render a stale baseline. `dataState` is per atomic group (`loading`/`ready`/`stale`/`cleared`/`error`).
- **`useConnectionState()`** → the WS connection state, re-rendering on every transition.
- **`useDriveLifecycle(handler)`** — fire-and-forget `drive_started`/`drive_ended` (toasts, route changes). Does not re-render.
- **`useDrives(vehicleId, { limit })`** → `{ drives, loading, error, hasMore, loadMore, refresh }` (cursor-paginated REST).

Tear-free and React 18 strict-mode safe (`useSyncExternalStore`). Hooks are individually tree-shakeable.

## Observability

Inject your own `Logger` / `MetricsRecorder`; both are auto-wrapped so P1 (tokens, GPS, PII) is redacted at the boundary (FR-11.2). Vercel Analytics / `@vercel/otel` adapters and the full metric catalog: [`docs/observability.md`](./docs/observability.md).

```ts
new MyRoboTaxiClient({ url, getToken, logger: myLogger, metrics: myMetrics });
```

## Bundle size

Published budget (NFR-3.30): **core < 55 KB**, **react < 20 KB**, **total < 75 KB** gzipped (CI-enforced via `size-limit`). `sideEffects: false` + per-hook modules → import only what you use. Verify in a consumer app with `npx source-map-explorer` or your bundler's analyzer; the `/types` subpath is zero runtime bytes.

## Platform support

- **Browser** (modern evergreen; native `WebSocket`)
- **Node** ≥ 20 (inject `ws` via `webSocketFactory`)
- **React** ≥ 18 (peer dependency)

Apple platforms consume the Swift SDK directly. No React Native adapter in v1.

## Migrating an existing Next.js app

Replacing a hand-rolled WebSocket client? See [`docs/migration-from-direct-ws.md`](./docs/migration-from-direct-ws.md).

## License

MIT
