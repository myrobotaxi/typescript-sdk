# Releasing `@myrobotaxi/sdk`

Automated pipeline (`.github/workflows/release.yml`) implementing
NFR-3.41–44 with strict semver (NFR-3.37) and the one-major deprecation
lifecycle (NFR-3.38).

## Tool choice: changesets (not release-please)

We use [**changesets**](https://github.com/changesets/changesets).

| | changesets | release-please |
|---|---|---|
| Model | contributor authors an intent file per PR; release consumes the accumulated set | bot maintains a long-lived "release PR" parsing conventional commits |
| Fit | **purpose-built for publishable npm library (mono)repos** — exactly this repo | optimised for app-style repos / Google ecosystem |
| Canary / prerelease | first-class (`version --snapshot`) | awkward |
| Semver source | explicit per-change author intent (major/minor/patch) — matches NFR-3.37's "author declares breaking" | inferred from commit prefixes (lossy for breaking changes) |

Trade-off: changesets requires every behaviour-changing PR to include a
`.changeset/*.md` file (enforced by review + the `.changeset/README.md`
instructions). That explicit author intent is the point — it makes the
NFR-3.37 "breaking ⇒ major" decision a deliberate, reviewable artifact
rather than a commit-message heuristic.

## Lanes (NFR-3.41–44)

| Lane | Trigger | Action | npm dist-tag |
|---|---|---|---|
| **canary** (NFR-3.43) | every push to `main` | `changeset version --snapshot canary` → publish | `canary` |
| **stable** (NFR-3.41) | weekly, Mon 09:00 UTC (cron) or manual `workflow_dispatch` (lane=stable) | if pending changesets: `changeset version` (bump + CHANGELOG) → commit to `main` → tag → publish | `latest` |
| **hotfix** (NFR-3.42) | manual `workflow_dispatch` (lane=hotfix) | same as stable but on-demand, bypassing the weekly cadence | `latest` |

The stable lane **no-ops if there are no pending changesets** since the
last stable — no empty Monday releases.

## Release notes (NFR-3.44)

`@changesets/changelog-github` generates the CHANGELOG / GitHub release
notes from each changeset summary, attributed to the PR. Categorise by
the PR's `breaking` / `feature` / `fix` / `chore` label; write changeset
summaries in consumer-impact terms.

## Authentication: npm OIDC trusted publishing (no token)

Every publish step uses npm OIDC trusted publishing — **no `NPM_TOKEN`
anywhere**. This reuses the hardened pattern from `myrobotaxi/contracts`
(learned the hard way in MYR-49):

- `permissions: id-token: write` on every publish job.
- **No `registry-url`** on `actions/setup-node` (it injects a sentinel
  `NODE_AUTH_TOKEN` that silently breaks OIDC).
- **No `env: NODE_AUTH_TOKEN`** (even empty breaks OIDC).
- `npm` pinned to `11.5.1` before publish (Node 20 ships 10.x; OIDC
  needs ≥ 11.5.1; `@latest` self-upgrade has a MODULE_NOT_FOUND race).
- `environment: npm-publish` on every publish job.

### One-time setup (before the first publish)

The SDK is unpublished (scaffold `0.0.0`). Before the first release:

1. Ensure the `@myrobotaxi` npm org exists (it does — `@myrobotaxi/contracts` ships there).
2. Configure the trusted publisher at
   `https://www.npmjs.com/package/@myrobotaxi/sdk/access` **after** the
   first manual publish (npm requires the package to exist first — the
   same chicken-and-egg as contracts; see MYR-49 history). Bootstrap the
   first `1.0.0` with a short-lived granular token, then switch to OIDC:
   - Organization: `myrobotaxi`
   - Repository: `typescript-sdk`
   - Workflow filename: `release.yml`
   - Environment name: `npm-publish`
3. Create the `npm-publish` GitHub Environment.

### First stable: `0.0.0 → 1.0.0`

The `0.0.x` versions are scaffold-only and unpublished. The first
stable cut is an intentional, human-initiated `v1.0.0` (add a `major`
changeset, run the stable lane manually). Thereafter the pipeline is
fully automated.

## Authoring a changeset

```bash
npx changeset      # pick bump level, write the consumer-facing summary
git add .changeset && git commit
```

See `.changeset/README.md`. PRs that change shipped behaviour without a
changeset should be flagged in review.
