---
"@myrobotaxi/sdk": patch
---

MYR-55: contract conformance test suite (NFR-3.45 ship gate). A
canonical fixture corpus (`src/conformance/fixtures/{websocket,rest,
atomic-groups,edge-cases}`) is driven through the REAL SDK code paths
(`wsErrorToCoreError` / `restErrorToCoreError` / the reconciler) — one
vitest case per fixture, so failure blocks merge in the standard `test`
CI check on any contract-touching PR. A committed `manifest.json` (the
Swift P4 conformance suite's single source of truth) is drift-guarded by
a test (`UPDATE_MANIFEST=1 npm test` regenerates). Test-only — not
bundled, no public API or version change.
