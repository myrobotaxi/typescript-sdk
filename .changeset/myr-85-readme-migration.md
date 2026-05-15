---
"@myrobotaxi/sdk": patch
---

MYR-85: consumer-facing docs (P7 onboarding). Rewrites the published
`README.md` (quickstart, `getToken()` + `reauth_required`, the four
React hooks, the `CoreError` reference table, subscribe/unsubscribe
guidance, observability, bundle budget) and adds
`docs/migration-from-direct-ws.md` — a Next.js per-surface
delete/replace checklist for moving `my-robo-taxi` off its hand-rolled
WebSocket client + Zustand reconciliation onto the SDK, including the
NextAuth ↔ ReauthRequired bridge and SDK-boundary test migration.
Docs-only; no API or behaviour change.
