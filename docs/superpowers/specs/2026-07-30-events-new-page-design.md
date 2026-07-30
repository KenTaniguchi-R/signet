# A dedicated Event page at `/events/new`

**Date:** 2026-07-30
**Status:** Approved, not yet implemented

## Problem

The brief form and the plan table share `/`. `BriefForm` fills the empty state,
and once an event exists it is demoted into a `<details>` disclosure labelled
"Plan another event". Two consequences, both bad on stage:

1. The brief has no address. You cannot navigate to it — you either have no
   event yet, or you open a disclosure.
2. The brief text is a `placeholder`, not a value. The presenter has to type the
   whole hackathon brief live, or paste it, before beat 1 can start.

Beat 1 of the demo is "the brief goes in, the plan comes out". It should open on
a page that is already holding the brief.

## Solution

Split the two concerns across two routes.

| Route | Responsibility |
|---|---|
| `/events/new` | The brief. Pre-filled with the real hackathon text, editable. |
| `/` | The plan. Table, spend button, boundary log. Redirects to `/events/new` when there is no plan to show. |

No API change. No schema change. No new queries. `POST /api/events/plan`
already returns `{ eventId, lineItems, summary }` with a 201.

## Components

### `src/app/events/new/page.tsx` (new)

Server component, `export const dynamic = 'force-dynamic'` to match `/` and
`/inbox`.

```
resolveActor()  →  null  →  <SignedOut />
                →  actor →  <IdentityBar actor active="plan" inboxCount viaFallback />
                            <BriefForm />
```

`inboxCount` comes from the existing `getInboxCount(actor.userId)`. `active` is
`"plan"` — the brief page is part of the plan flow, so the nav does not move
between it and `/`.

### `src/app/page.tsx` (modified)

Three edits:

1. Add `import { redirect } from 'next/navigation'`.
2. Replace the `<BriefForm />` empty-state branch with `redirect('/events/new')`,
   placed after the queries resolve and guarded on the same condition the page
   already branches on: `!event || rows.length === 0`. `redirect` throws
   `NEXT_REDIRECT` and returns `never`, so it needs no `return` and must not sit
   inside a `try` block — the page has no try/catch, so this is satisfied.
3. Replace the `<details>` "Plan another event" disclosure with a `next/link`
   anchor to `/events/new`, keeping the existing quiet mono-caps styling so the
   footer of the plan page does not gain visual weight.

The page keeps its `event && rows.length > 0` shape; after the redirect that
condition is always true, so the JSX loses its ternary and de-nests one level.

### `src/components/BriefForm.tsx` (modified)

Three edits:

1. Add `DEFAULT_BRIEF`, the hackathon brief text, alongside the existing
   `DEFAULT_TITLE`. Both stay colocated in this file — one consumer, no module
   warranted. Seed `useState` with it and drop the `placeholder` attribute on
   the textarea, so the text is a real editable value the presenter can retype
   live to show the agent responding to a different brief.
2. On success, `router.push('/')` then `router.refresh()`, replacing
   `setBrief('')` + `router.refresh()`. The form no longer re-renders in place.
3. Delete the `compact` prop and its three conditional branches. Its only
   consumer was the `<details>` disclosure, which this change removes.

`DEFAULT_BRIEF` is verbatim:

> A one-day hackathon at our SF office. We need the floor, lunch, drinks, AV for
> a demo stage, and prizes for three placements. 8 vegetarian and 3 gluten free.
> Building access opens at noon, so catering has to arrive after that.

`DEFAULT_TITLE`, `budget` (`5000`) and `headcount` (`60`) keep their current
values.

### Unchanged

`IdentityBar` — its `active` union already contains `'plan'`.
`src/proxy.ts` — the matcher covers `/events/new`, and `auth0.middleware`
passes non-auth paths through. `/inbox` already exercises this path.

## Data flow

```
/events/new
   ↓  POST /api/events/plan  { title, budgetCents, headcount, notes }
   ↓  201 { eventId, lineItems, summary }
   ↓  router.push('/') + router.refresh()
/
   ↓  getLatestEvent(actor.orgId) → getPlanRows / getBoundaryLog
   PlanTable
```

The response body is not read — `/` re-queries from the DB, which is how the
page already works.

## Error handling

- **Non-2xx from the plan route.** Navigation only happens on `response.ok`, so
  a failure keeps the presenter on `/events/new` with the existing inline error
  paragraph and the typed brief intact. Unchanged behaviour.
- **No redirect loop.** `/` redirects to `/events/new`; `/events/new` never
  redirects. If a plan somehow produced zero line items, `push('/')` bounces
  once back to the brief — the correct outcome, since there is nothing to show.
- **Expired session.** `/events/new` gates on `resolveActor()` and renders
  `SignedOut`. If the session dies between page load and submit, the route
  returns 401 and the inline error surfaces it.

## Testing

Every test in this repo lives in `src/lib` and there is no component or route
test harness. This change adds no lib logic — it is routing plus a default
string — so it introduces no unit tests rather than standing up a harness
during the build window.

Verification is `npm run build` (typecheck plus route manifest, which will fail
loudly if `compact` still has a caller) and a dev-server pass:
`/` with no event redirects to `/events/new` · the brief renders pre-filled ·
"Plan this" produces a plan and lands on `/` · the plan page's link returns to
`/events/new`.

## Out of scope

- `/events/[id]`. Every event still resolves through `getLatestEvent`. A
  per-event permanent URL is a separate change and the demo does not need one.
- A third nav item. Nav stays `Plan | Inbox`.
