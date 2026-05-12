# @myrobotaxi/sdk

TypeScript SDK for the MyRoboTaxi telemetry server. Logic-only — no UI, no map, no theme.

## Status

**v0 scaffold.** Public API surface is not yet implemented. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the dev loop and the [P3 — TypeScript SDK v1 Linear project](https://linear.app/myrobotaxi/project/p3-typescript-sdk-v1-ad3733fbdf14) for the build-out plan.

## Installation

```bash
npm install @myrobotaxi/sdk
```

The React adapter is exposed under the `/react` subpath, and the wire-shape types under `/types`:

```ts
import { /* SDK exports */ } from '@myrobotaxi/sdk';
import { /* React hooks */ } from '@myrobotaxi/sdk/react';
import type { VehicleState, WebSocketEnvelope } from '@myrobotaxi/sdk/types';
```

The `/types` subpath re-exports the pre-generated types from [@myrobotaxi/contracts](https://github.com/myrobotaxi/contracts) — the canonical wire-protocol source of truth. It tree-shakes to zero bytes for consumers that only need types.

## Platform support

- **Browser** (every modern evergreen browser; uses native `WebSocket`)
- **Node** ≥ 20 (uses `ws` for the WebSocket transport)
- **React** ≥ 18

Apple platforms (iOS, iPadOS, macOS, watchOS, visionOS) consume the Swift SDK directly. There is **no React Native adapter** in v1.

## License

MIT
