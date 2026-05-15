---
"@myrobotaxi/sdk": patch
---

MYR-103: scope the WS client's `auth_failed_total{subCode}` emission to
`auth_failed` outcomes only, matching the REST scoping shipped in
MYR-82. Previously the WS client incremented the counter on every
`error` frame (rate_limited / internal_error / not_found / …), tagging
non-auth errors as `subCode: 'null'` and inflating the metric. The
`{subCode}` tag shape is unchanged so a single cross-transport
dashboard still sums correctly. No public API change.
