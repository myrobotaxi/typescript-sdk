# Contributing to `@myrobotaxi/sdk`

## Dev loop

```bash
cd packages/sdk
npm install      # one-time from the monorepo root
npm run typecheck
npm run lint
npm run test
npm run build
```

All four commands must pass before opening a PR. CI re-runs them on every push.

## Dependency rule (NFR-3.32 + NFR-3.33)

The SDK is **logic only**. It MUST NOT depend on:

- React Native (Apple platforms use the Swift SDK directly — there is no RN adapter in v1)
- Map renderers (Mapbox, Google Maps, Leaflet, etc.) — consumers compose their own UI
- UI component libraries (shadcn, Material UI, Chakra, etc.)
- Theming libraries
- State management frameworks (Redux, Zustand, Jotai, etc.) — the reconciler exposes its own observable state
- Server-side frameworks (Express, Next.js, Fastify, etc.) — the SDK is consumed by them, never the inverse

The only runtime peer dependency is `react` (optional — used only by the `@myrobotaxi/sdk/react` adapter). The core entry point has zero runtime dependencies in v1; it uses the browser `WebSocket` + Node `ws` (and `fetch`/`undici`) directly.

## Contract source-of-truth

The SDK is contract-driven. Every wire shape, atomic group, error code, and state transition is defined as JSON Schema in the standalone [`@myrobotaxi/contracts`](https://github.com/myrobotaxi/contracts) package. The TS types exposed under `@myrobotaxi/sdk/types` are **re-exported** from `@myrobotaxi/contracts/types` — they are NOT hand-written in this repo, and `packages/sdk/src/types.ts` is the only place that touches them.

Schema authoring currently lives in [`myrobotaxi/telemetry/docs/contracts/schemas/`](https://github.com/myrobotaxi/telemetry/tree/main/docs/contracts/schemas) and is vendored into the contracts repo via paired PR (until the Phase 2 migration moves authoring into the contracts repo itself). A schema-touching change is therefore a **three-PR cascade**:

1. Telemetry repo: edit the source `.schema.json`.
2. Contracts repo: copy the updated schema, regenerate types, bump version.
3. This SDK repo: bump the `@myrobotaxi/contracts` dependency.

The `sdk-architect` agent enforces this at review time.

## Bundle budget (NFR-3.30)

Total gzipped bundle budget: **< 75 KB** (core `<` 55 KB + react `<` 20 KB). MYR-54 lands the CI gate that enforces this. Until then, run `npm run build` locally and inspect `dist/*.js` sizes when adding dependencies.

## Test convention

- Per-file `*.test.ts` adjacent to source (e.g., `src/foo.ts` → `src/foo.test.ts`).
- Vitest table-driven pattern preferred for multi-case coverage.
- 80%+ coverage target on `src/` (enforced by CI once MYR-55 lands the conformance suite).

## Release cadence

Released via the pipeline in MYR-56:

- **Weekly stable** every Monday (semver minor / patch)
- **Hotfix lane** for manually-triggered emergency releases
- **Canary** pre-releases (`vX.Y.Z-canary.N`) on every merge to `main`

Until MYR-56 lands, the package version stays at `0.0.0` and is not published to npm.
