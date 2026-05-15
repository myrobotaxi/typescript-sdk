# Auth & the `reauth_required` carve-out

The SDK never stores credentials (FR-6.1). Every (re)connect and every
REST request calls the consumer-supplied `getToken()`; the SDK injects
the returned bearer token and forgets it. This document covers the one
auth case consumers **must** handle explicitly: `reauth_required`.

## The two kinds of auth failure

| Server says | `CoreError` | SDK behaviour | Consumer does |
|---|---|---|---|
| token expired / invalid (`auth_failed`, no `subCode`) | `code: 'auth_failed'`, `retryable` | SDK silently calls `getToken({ forceRefresh: true })` **once** and retries | nothing — transparent |
| sign-in too old (`auth_failed`, `subCode: 'reauth_required'`) | `code: 'auth_failed'`, `subCode: 'reauth_required'`, **terminal, not retryable** | SDK does **not** retry — surfaces it | trigger an **interactive** re-authentication |

The distinction is structural. A `reauth_required` response means the
bearer token is perfectly valid, but the server enforces a *recent-auth*
window for sensitive operations (rest-api.md §4.1.1 / §7.6–§7.7) and the
user's last interactive sign-in is older than that window. A silent token
refresh **cannot** fix this — refreshing an access token does not move
the underlying `auth_time` claim forward. Only the user signing in again
does. An SDK that auto-retried here would spin against an unsatisfiable
gate forever, so the carve-out is deliberate and non-negotiable.

## Detecting it

Both transports map this to the same typed error. Branch with the guard,
never on `error.message` (FR-7.1) and never on `error.transport`:

```ts
import { isReauthRequired } from '@myrobotaxi/sdk';

// REST
const r = await rest.snapshot();
if (!r.ok && isReauthRequired(r.error)) {
  await promptReauth();        // see below
  return;
}

// WebSocket
client.subscribe((evt) => {
  if (evt.kind === 'error' && isReauthRequired(evt.error)) {
    void promptReauth();
  }
});
```

`isReauthRequired(e)` narrows `e` to `ReauthRequiredError`, so the
compiler knows `e.code === 'auth_failed'` and `e.subCode ===
'reauth_required'` in the branch. `e.transport` (`'rest' | 'ws'`) is the
**carrier** — diagnostic only. The contract defines `reauth_required` as
a REST envelope, so in practice `transport` is `'rest'`; a `'ws'` value
means the SDK's defensive contract-drift mapping fired and should be
treated identically.

## Remediation — NextAuth example

`reauth_required` is terminal: the SDK will not recover on its own. The
consumer must drive a fresh interactive sign-in, then resume.

```ts
import { signIn } from 'next-auth/react';
import { isReauthRequired } from '@myrobotaxi/sdk';

async function promptReauth(): Promise<void> {
  // Forces the IdP to re-prompt and re-issue a token with a fresh
  // auth_time. `prompt: 'login'` defeats silent SSO so the recent-auth
  // window actually advances.
  await signIn('your-provider', { prompt: 'login', redirect: true });
}
```

After the user returns from sign-in, the next `getToken()` resolves with
a token whose `auth_time` is fresh; the original WS connection /
REST call can be retried by the consumer (the SDK does **not** retry it
automatically — it cannot know when the user finished signing in).

> NextAuth v4 vs v5: in v5 (`next-auth@beta`) import `signIn` from
> `@/auth` or `next-auth/react` per your setup; the `prompt: 'login'`
> provider param is what matters, not the import path.

## Observability

Both carriers emit `auth_failed_total{subCode}` so a single dashboard can
track how often the recent-auth gate trips:

- `subCode: 'reauth_required'` — recent-auth gate fired (expected, low rate)
- `subCode: 'null'` — a plain `auth_failed` was surfaced (after the one
  silent refresh retry was already spent)

Both carriers scope this to surfaced `auth_failed` outcomes only — an
error (WS frame or REST response) can be `rate_limited` /
`internal_error` / `not_found` / etc., and folding those into
`auth_failed_total` would mislead operators. The `{subCode}` tag
dimension is identical across both, which is the point — you alert on
the tag, not the carrier. (REST scoping landed in MYR-82; WS scoping in
MYR-103, which removed the earlier emit-on-every-error-frame behaviour.)

## Why not a separate error `kind`?

`CoreError` is a single `code`-keyed discriminated union with a
compile-time exhaustiveness guard (MYR-52). `reauth_required` is a
`subCode` refinement of `auth_failed`, not a new top-level code, so it
stays in that union and is exposed as a **narrowing guard +
`ReauthRequiredError` type alias** rather than a second discriminator.
Consumers branch on one model (`error.code`, plus `isReauthRequired`
for the carve-out); the union never forks.
