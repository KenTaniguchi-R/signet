# Sign out, and the dev-actor fallback

**Date:** 2026-07-30 · **Status:** approved · **Scope:** ~20 min, 6 files

## The problem

Clicking "Sign out" returns you to the identical signed-in screen.

`/auth/logout` is not broken. It clears the session and redirects to `/`, where
`resolveActor()` (`src/lib/dev-actor.ts`) finds no session, falls back to
`SIGNET_DEV_VIEWER_EMAIL`, and reconstructs the same actor. `SignedOut` renders
only when there is no session *and* no fallback actor, so it never appears.

The fallback existed because Auth0 users did not resolve to DB rows yet. That is
no longer true. In the active org (`org_EXAMPLE`) all three seeded users
carry real subs:

| email | role | auth0_sub |
|---|---|---|
| ken.taniguchi@northbeam.dev | finance | `auth0\|EXAMPLE_FINANCE` |
| amara.okonkwo@northbeam.dev | legal | `auth0\|EXAMPLE_LEGAL` |
| devin.whitlock@northbeam.dev | ops | `auth0\|EXAMPLE_OPS` |

The `pending|` placeholder rows survive only in the stale org
`org_EXAMPLE_STALE`, which the `AUTH0_ORG_ID` scoping already excludes.

Two defects follow from the fallback outliving its purpose:

1. **`isDevActor()` no longer works.** It detects the fallback via
   `auth0Sub.startsWith('pending|')`, but the active-org fallback actor has a
   real sub. It returns `false` for precisely the case it exists to catch.
   Nothing imports it.
2. **A fallback actor can render the inbox but cannot approve.**
   `approve/route.ts:18` and `decline/route.ts:10` use `getActor()`, not
   `resolveActor()` — correct under Invariant 1, but it means the Approve button
   401s for a viewer the UI presents as fully signed in.

The root cause of the reported confusion is not logout. It is that **nothing on
screen distinguishes a real session from the fallback.**

## Decision

The demo is driven by **two real Auth0 logins in two browser profiles**. Separate
cookie jars mean no sign-out is needed mid-demo, and the Approve buttons work
because both windows hold real sessions.

Given that, the fallback stops being the demo path and becomes an escape hatch.
Neutralize it and make its use visible, rather than deleting it 90 minutes before
demo.

Rejected: **deleting `dev-actor.ts` outright** — the right cleanup, and what
AGENTS.md prescribes once real logins work, but it removes the safety net at the
worst moment for a larger diff. Do it after the demo. Rejected: **cookie-scoped
logout suppression** — only pays off if the fallback must stay on during the
demo, which the decision above rules out.

## Design

### 1. Config: the fallback defaults off

Comment out `SIGNET_DEV_VIEWER_EMAIL` in `.env.local`. Next loads `.env.local`
into `process.env` at server start, so this needs a dev-server restart to take
effect. With it unset, `resolveActor()` degrades to `getActor()` exactly, and
`/auth/logout` is correct with no code change.

### 2. `resolveActor()` reports which path it took

```ts
export interface ResolvedActor {
  actor: Actor;
  viaFallback: boolean;
}
export async function resolveActor(): Promise<ResolvedActor | null>;
```

The flag is set at the point of decision rather than inferred later from actor
shape — that inference is what broke `isDevActor()`. Delete `isDevActor()`; it is
dead and wrong.

`Actor` itself does not change. The dev-only concern stays out of the core type
that the auth and policy paths read.

### 3. `IdentityBar` shows the fallback

Add an optional `viaFallback?: boolean` prop. When true, render a `DEV VIEWER`
chip beside the role, reusing the existing halt tokens (`text-halt` on
`bg-halt-tint`) and the established mono treatment
`font-mono text-[0.6875rem] uppercase tracking-[0.13em]`. Halt ink already means
"a human is required here" elsewhere in the UI, which is the right connotation:
this viewer cannot approve.

No environment guard is needed: `resolveActor()` refuses the fallback when
`NODE_ENV === 'production'`, so `viaFallback` can only be true in development.

### 4. Call sites

Four, all mechanical:

- `src/app/page.tsx:13` — destructure, pass `viaFallback` to `IdentityBar`
- `src/app/inbox/page.tsx:13` — same
- `src/app/api/events/plan/route.ts:34` — take `.actor`, ignore the flag
- `src/app/api/events/[id]/spend/route.ts:21` — same

The two API routes ignore the flag deliberately. The approver on those paths is
resolved by the policy table, never by the caller (Invariant 2), so how the
caller authenticated does not affect the outcome.

## Invariants

Unaffected. No approver identity moves, and `approved_by` still comes from
`getActor()` on the approve/decline routes only. The change makes Invariant 1
*more* legible by labelling the one actor that cannot satisfy it.

## Testing

No new unit tests. The policy router is the tested surface; this is presentation
and a return-type change the compiler checks.

Manual verification, in order:

1. `SIGNET_DEV_VIEWER_EMAIL` commented out, dev server restarted → `/` shows
   `SignedOut`, not the plan.
2. Sign in as Ken → plan renders, **no** `DEV VIEWER` chip.
3. Sign out → lands on `SignedOut` and stays there.
4. Second browser profile, sign in as Devin → his inbox shows the Catering and
   Prizes items; Ken's shows Venue. Approve succeeds in both.
5. Temporarily re-set `SIGNET_DEV_VIEWER_EMAIL`, restart → chip appears. Unset
   again before demoing.

## Known limitation

The fallback still exists and is one env var from being live. Step 5 above is the
only guard against presenting on it by accident, and the chip is what makes that
mistake self-announcing. Post-demo, delete `src/lib/dev-actor.ts` and point the
four call sites at `getActor()`.
