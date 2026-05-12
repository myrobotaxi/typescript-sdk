# Contributing to `typescript-sdk`

## Repo layout

```
typescript-sdk/
├── .github/
│   ├── workflows/        CI + Claude Review
│   ├── CODEOWNERS        @tnando on SDK surface + infra paths
│   ├── dependabot.yml    weekly npm + actions bumps
│   └── pull_request_template.md
├── packages/
│   └── sdk/              the @myrobotaxi/sdk package
├── tsconfig.base.json    shared TS config
├── eslint.config.mjs     shared ESLint flat config
└── package.json          monorepo root (npm workspaces)
```

## First-time setup

```bash
git clone git@github.com:myrobotaxi/typescript-sdk.git
cd typescript-sdk
npm install
```

## Dev loop

From the monorepo root:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

All four must pass before opening a PR. The CI workflow re-runs them on every push and the Claude Review bot leaves a verdict on every PR.

## Branching + commits

Follow Linear's `{{issue.branchName}}` convention. Branch name format:

```
thomasnandola/myr-NN-short-slug
```

Commit messages MUST include the Linear ticket identifier:

```
MYR-NN <Imperative verb> <what changed>
```

Linear auto-links commits containing `MYR-NN`.

## PR workflow

1. Create a feature branch from `main`.
2. Push, open a PR. CI runs lint + typecheck + test + build.
3. The Claude Review bot leaves an automated verdict.
4. Resolve any `Critical` / `Warning` review comments per the severity table.
5. Merge via squash. Linear auto-transitions the ticket to Done.

## Contract source-of-truth

Wire-shape types come from the standalone [`@myrobotaxi/contracts`](https://github.com/myrobotaxi/contracts) package — they are NOT hand-written in this repo. The SDK consumes them via `packages/sdk/src/types.ts`, which re-exports from `@myrobotaxi/contracts/types`.

Schema authoring currently lives in [`myrobotaxi/telemetry/docs/contracts/schemas/`](https://github.com/myrobotaxi/telemetry/tree/main/docs/contracts/schemas) and is vendored into the contracts repo via paired PR (until the Phase 2 migration moves authoring into the contracts repo itself). A contract change is therefore a **three-PR cascade**: telemetry → contracts → SDK (this repo) bumps the dep.
