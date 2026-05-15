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

Total gzipped bundle budget: **< 75 KB** — core (`@myrobotaxi/sdk`) `<` 55 KB + react (`@myrobotaxi/sdk/react`) `<` 20 KB.

Enforced in CI by the **Bundle size** job (MYR-54), which fails the build if either entry point exceeds its budget and posts a PR comment showing the current size, the budget, and the breach.

### Inspect locally before pushing

```bash
npm run build      # from the monorepo root — produces packages/sdk/dist/
npm run size       # human-readable table: each entry, gzipped size vs limit
npm run size:json  # machine-readable (the format CI uploads as the trend artifact)
```

`npm run size` exits non-zero on a breach, mirroring CI.

### What's allowed to be added

- **Zero new runtime dependencies in core** without an explicit budget review in the PR description. Every dep counts against the 55 KB core budget after tree-shaking.
- `devDependencies` don't count (not shipped).
- The `react` peer dep is external — it does not count against the react-entry budget.
- `@myrobotaxi/contracts` types are erased at build (type-only `./types` re-export) and do not ship runtime bytes.
- If a change legitimately needs more headroom, bump the limit in `.size-limit.json` **in the same PR** with a one-line justification in the PR body. Reviewers gate this.

### Trend tracking

Every CI run uploads `size-report.json` as the `bundle-size-report` artifact (90-day retention). The last-30-commits trend on `main` is reconstructable from these artifacts; a standalone dashboard is intentionally out of scope for v1.

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
