# @myrobotaxi/sdk

TypeScript SDK for the MyRoboTaxi telemetry server. Logic-only client for browsers, Node, and React. No UI, no map renderer, no theme — consumers compose state with their own UI.

## Status

**v0 — scaffold only.** This repo currently contains the empty package shell (tsconfig, build, vitest, eslint, CI). The actual SDK surface lands ticket-by-ticket under [P3 — TypeScript SDK v1](https://linear.app/myrobotaxi/project/p3-typescript-sdk-v1-ad3733fbdf14).

## Packages

| Package | Purpose |
|---------|---------|
| `@myrobotaxi/sdk` | Core (browser + Node) — WebSocket + REST client, state reconciler, typed errors |
| `@myrobotaxi/sdk/react` | React adapter — hooks for consumers (`useVehicleState`, `useDrives`, etc.) |

Apple platforms (iOS, iPadOS, macOS, watchOS, visionOS) consume the Swift SDK directly — there is no React Native adapter in v1.

## Consumers

- **[react-frontend](https://github.com/myrobotaxi/react-frontend)** (Next.js production app) — depends on this SDK once published
- **[myrobotaxi-test-bench](https://github.com/myrobotaxi/myrobotaxi-test-bench)** (validation dashboard) — depends on this SDK during P3 development via workspace link, then via npm once published

## Development

See [`packages/sdk/CONTRIBUTING.md`](packages/sdk/CONTRIBUTING.md) for the package-level dev loop.

## Contract source-of-truth

Wire-shape types come from the standalone [`@myrobotaxi/contracts`](https://github.com/myrobotaxi/contracts) package — the canonical JSON Schema + pre-generated TypeScript source of truth, consumed by this SDK, the Go [telemetry](https://github.com/myrobotaxi/telemetry) server, and (eventually) a Swift SDK. Schema authoring currently lives in [`myrobotaxi/telemetry/docs/contracts/schemas/`](https://github.com/myrobotaxi/telemetry/tree/main/docs/contracts/schemas) and is vendored into the contracts repo via paired PR (Phase 2 will collapse this to a single home).

## License

MIT
