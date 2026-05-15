# Changesets

This repo releases `@myrobotaxi/sdk` via [changesets](https://github.com/changesets/changesets).

**Every PR that changes shipped behaviour MUST include a changeset.** Run:

```bash
npx changeset
```

Pick the bump level per NFR-3.37 (strict semver):

- **major** — any breaking public-API change. Deprecated APIs must survive one full major (NFR-3.38).
- **minor** — additive, backwards-compatible (new export, new optional option).
- **patch** — bug fix / internal change with no public-surface effect.

Write the summary in terms of consumer impact — it becomes the CHANGELOG / release-notes entry (categorised by the PR's `breaking` / `feature` / `fix` / `chore` label per NFR-3.44).

Docs-only / CI-only PRs may use an empty changeset (`npx changeset --empty`).

See `packages/sdk/RELEASING.md` for the full pipeline (weekly stable, hotfix lane, canary).
