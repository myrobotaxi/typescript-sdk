---
"@myrobotaxi/sdk": patch
---

MYR-82: add the `reauth_required` carve-out as a typed, cross-transport
surface. New public exports `isReauthRequired()` type guard +
`ReauthRequiredError` type alias narrow the existing code-keyed
`CoreError` union (no second discriminator). REST now emits
`auth_failed_total{subCode}` for parity with the WS client. Adds
end-to-end conformance tests proving the carve-out behaves identically
over REST and WebSocket, plus `docs/auth.md` with the NextAuth
`signIn({ prompt: 'login' })` remediation pattern.
