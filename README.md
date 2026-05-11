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

- **[my-robo-taxi](https://github.com/myrobotaxi/my-robo-taxi)** (Next.js production app) — depends on this SDK once published
- **[myrobotaxi-test-bench](https://github.com/myrobotaxi/myrobotaxi-test-bench)** (validation dashboard) — depends on this SDK during P3 development via workspace link, then via npm once published

## Development

See [`packages/sdk/CONTRIBUTING.md`](packages/sdk/CONTRIBUTING.md) for the package-level dev loop.

## Contract source-of-truth

The SDK is contract-driven. Every wire shape, atomic group, error code, and state transition is defined in [`docs/contracts/`](https://github.com/myrobotaxi/my-robo-taxi-telemetry/tree/main/docs/contracts) of the [my-robo-taxi-telemetry](https://github.com/myrobotaxi/my-robo-taxi-telemetry) repo. The TS types in this SDK are generated from those contract schemas (see MYR-49).

## License

MIT
