# Dedicated Event Brief Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the event brief its own address at `/events/new`, pre-filled with the hackathon brief, so demo beat 1 opens on a form that is ready to submit.

**Architecture:** Split the two concerns that currently share `/`. A new server component at `/events/new` renders `IdentityBar` + `BriefForm`; `/` becomes the plan view alone and redirects to `/events/new` when there is no plan to show. `BriefForm` seeds its textarea with real text instead of a placeholder and navigates to `/` on success. No API, schema, or query changes.

**Tech Stack:** Next.js 16 App Router (note: Middleware is called Proxy in 16), React 19, Tailwind v4, TypeScript.

## Global Constraints

- Read `node_modules/next/dist/docs/` before writing App Router code. This is not the Next.js in your training data.
- `redirect` comes from `next/navigation`, returns `never`, needs no `return`, and must never sit inside a `try` block.
- All page components stay server components. Only `BriefForm` carries `'use client'`.
- No `any` in auth or policy paths.
- Existing tests live in `src/lib` and run under Node's built-in test runner (`npm test` → `node --test "src/**/*.test.ts"`). There is no component or route test harness, and this plan does not add one — see "Testing approach" below.
- `getPlanRows` and `getBoundaryLog` both take `(eventId, orgId)` as of commit `d67596c`. **Preserve both call sites exactly** — `page.tsx` is rewritten wholesale in Task 2, and dropping the second argument is the easiest way to break this build.
- Start from a clean working tree (`d67596c` or later). Stage named files rather than `git add -A`, so an unrelated edit made in another terminal mid-task does not ride along.

## Testing approach — read this before Task 1

This change adds no library logic. It is one new route, one redirect, one default string, and a prop deletion. Every test in this repo targets pure functions in `src/lib` (`policy`, `spend`, `activity`, `slack`, `agent/*`); there is no React Testing Library, no Playwright, no route-handler harness, and adding one during a 4.5-hour build window is not the right trade.

So the TDD cycle here is **typecheck-first, then a scripted manual pass**, not a written unit test. Each task's "verify it fails" step is a real command that produces a real failure, and each "verify it passes" step is the same command going green. Do not invent a test harness to satisfy the shape of TDD.

`npx tsc --noEmit` is the primary gate rather than `npm run build`, because it needs no `DATABASE_URL` and returns in seconds.

---

### Task 1: The `/events/new` page and a pre-filled, navigating brief form

**Files:**
- Create: `src/app/events/new/page.tsx`
- Modify: `src/components/BriefForm.tsx` (add `DEFAULT_BRIEF`; seed state; drop `placeholder`; `push` on success)
- Test: none — see "Testing approach" above

**Interfaces:**
- Consumes: `resolveActor()` from `@/lib/dev-actor`, returning `{ actor, viaFallback } | null`; `getInboxCount(userId: string): Promise<number>` from `@/lib/queries`; `IdentityBar` with props `{ actor, active: 'plan' | 'inbox', inboxCount: number, viaFallback?: boolean }`; `SignedOut` from `@/app/SignedOut`.
- Produces: the route `/events/new`. Task 2's `<Link href="/events/new">` and `redirect('/events/new')` both depend on this route existing. `BriefForm` after this task takes **no props**.

- [ ] **Step 1: Confirm the route does not exist yet**

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/events/new` with `npm run dev` running.
Expected: `404`

If the dev server is not running, start it in a separate terminal with `npm run dev` first. Leave it running for the rest of this plan — every verification step uses it.

- [ ] **Step 2: Create the page**

Create `src/app/events/new/page.tsx`:

```tsx
import { BriefForm } from '@/components/BriefForm';
import { IdentityBar } from '@/components/IdentityBar';
import { SignedOut } from '@/app/SignedOut';
import { resolveActor } from '@/lib/dev-actor';
import { getInboxCount } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * Demo beat 1 opens here. The brief is a real value on the form rather than a
 * placeholder, so the presenter submits instead of types — but it stays
 * editable, so a judge asking "what if it were a different event?" gets an
 * answer live rather than a promise.
 */
export default async function NewEventPage() {
  const resolved = await resolveActor();
  if (!resolved) return <SignedOut />;
  const { actor, viaFallback } = resolved;

  const inboxCount = await getInboxCount(actor.userId);

  return (
    <>
      {/*
        `active="plan"` deliberately. The brief and the plan are one flow, and a
        nav item that lights up differently between them would draw the room's
        eye to the chrome at the exact moment the plan appears.
      */}
      <IdentityBar
        actor={actor}
        active="plan"
        inboxCount={inboxCount}
        viaFallback={viaFallback}
      />

      <main className="mx-auto flex w-full max-w-[1120px] flex-1 flex-col gap-5 px-6 py-10">
        <BriefForm />
      </main>
    </>
  );
}
```

- [ ] **Step 3: Verify the route now renders**

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/events/new`
Expected: `200`

Then open `http://localhost:3000/events/new` in a browser. Expected: the identity bar with your name, and the brief form with "What are you planning?" — the Brief textarea still **empty** with grey placeholder text. That is correct at this step; Step 4 fills it.

- [ ] **Step 4: Pre-fill the brief and navigate on success**

In `src/components/BriefForm.tsx`, add `DEFAULT_BRIEF` directly below the existing `DEFAULT_TITLE` constant:

```tsx
const DEFAULT_TITLE = 'Built Different: Auth0 x Stripe, Okta HQ SF';

/**
 * A value, not a placeholder. The presenter should be able to land on the page
 * and hit one button; typing 300 characters on stage is the failure mode this
 * page exists to remove. Still editable — retype it to show the agent
 * re-planning against a different brief.
 */
const DEFAULT_BRIEF =
  'A one-day hackathon at our SF office. We need the floor, lunch, drinks, AV ' +
  'for a demo stage, and prizes for three placements. 8 vegetarian and 3 gluten ' +
  'free. Building access opens at noon, so catering has to arrive after that.';
```

Change the `brief` state to seed from it:

```tsx
const [brief, setBrief] = useState(DEFAULT_BRIEF);
```

In `onSubmit`, replace the success branch. Find:

```tsx
      setBrief('');
      router.refresh();
```

Replace with:

```tsx
      /*
       * To the plan, not back to an empty form. The route returns the new
       * `eventId` but we deliberately ignore it: `/` re-reads the latest event
       * from the DB, which is the same path a hard refresh takes, so there is
       * one code path to trust on stage rather than two.
       */
      router.push('/');
      router.refresh();
```

Remove the `placeholder` attribute from the `<textarea>` — it is dead now that the field has a value. Find and delete this line:

```tsx
          placeholder="A one-day hackathon at our SF office. We need the floor, lunch, drinks, AV for a demo stage, and prizes for three placements. 8 vegetarian and 3 gluten free. Building access opens at noon, so catering has to arrive after that."
```

Also drop `placeholder:text-ink-faint` from that textarea's `className`, since no placeholder can render any more.

Leave the `compact` prop alone in this task. Task 2 removes it, after its last caller is gone.

- [ ] **Step 5: Verify the form is pre-filled and submits**

Run: `npx tsc --noEmit`
Expected: no output (clean exit).

Then reload `http://localhost:3000/events/new`. Expected: the Brief textarea holds the hackathon text in normal ink (not grey placeholder ink), and "Plan this" is enabled without touching the keyboard.

Click "Plan this". Expected: the button reads "Planning…", then the browser navigates to `/` and shows the plan table. This takes several seconds — the model is generating 12 line items.

> **If the first request hangs for seconds before anything happens:** that is Neon free-tier compute cold-starting, not a bug. Warm it before demoing.

- [ ] **Step 6: Commit**

```bash
git add src/app/events/new/page.tsx src/components/BriefForm.tsx
git commit -m "Give the brief its own page, already holding the brief"
```

Stage those two paths by name, not `git add -A`.

---

### Task 2: `/` becomes the plan alone

**Files:**
- Modify: `src/app/page.tsx` (imports; redirect; `<details>` → `<Link>`; de-nest)
- Modify: `src/components/BriefForm.tsx` (delete the `compact` prop)
- Test: none — see "Testing approach" above

**Interfaces:**
- Consumes: `/events/new` from Task 1; `BriefForm` with no props.
- Produces: nothing downstream. This is the last task.

- [ ] **Step 1: Prove `compact` still has a caller**

Run: `grep -rn "compact" src/`
Expected: three hits in `src/components/BriefForm.tsx` (the prop signature and two `className`/`rows` ternaries) plus one in `src/app/page.tsx` (`<BriefForm compact />`).

This is the failing state: the prop cannot be deleted while `page.tsx` passes it. Both files change together in this task for that reason.

- [ ] **Step 2: Rewrite `page.tsx`**

Replace the whole of `src/app/page.tsx` with:

```tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { BoundaryLog } from '@/components/BoundaryLog';
import { ExecuteSpend } from '@/components/ExecuteSpend';
import { IdentityBar } from '@/components/IdentityBar';
import { PlanTable } from '@/components/PlanTable';
import { resolveActor } from '@/lib/dev-actor';
import { getBoundaryLog, getInboxCount, getLatestEvent, getPlanRows } from '@/lib/queries';

import { SignedOut } from './SignedOut';

export const dynamic = 'force-dynamic';

export default async function PlanPage() {
  const resolved = await resolveActor();
  if (!resolved) return <SignedOut />;
  const { actor, viaFallback } = resolved;

  const [event, inboxCount] = await Promise.all([
    getLatestEvent(actor.orgId),
    getInboxCount(actor.userId),
  ]);
  const [rows, boundary] = event
    ? await Promise.all([
        getPlanRows(event.id, actor.orgId),
        getBoundaryLog(event.id, actor.orgId),
      ])
    : [[], { entries: [], names: {} }];

  /*
   * Nothing to show is not an empty state here — the brief has its own page.
   * `redirect` throws NEXT_REDIRECT and is typed `never`, so it both narrows
   * `event` to non-null below and must stay outside any try/catch.
   */
  if (!event || rows.length === 0) redirect('/events/new');

  // `proposed` means the plan phase wrote the row and the spend phase has not
  // yet been asked to commit it — the only state where beat 2 has work to do.
  const proposedCount = rows.filter((row) => row.status === 'proposed').length;

  return (
    <>
      <IdentityBar
        actor={actor}
        active="plan"
        inboxCount={inboxCount}
        viaFallback={viaFallback}
      />

      <main className="mx-auto flex w-full max-w-[1120px] flex-1 flex-col gap-5 px-6 py-10">
        <PlanTable rows={rows} title={event.title} budgetCents={event.budgetCents} />

        {/*
          Beat 2. Only while something is still `proposed` — once every item
          is routed or settled the button has nothing left to do and would
          read as an unfinished step on stage.
        */}
        {proposedCount > 0 && (
          <ExecuteSpend eventId={event.id} proposedCount={proposedCount} />
        )}

        <BoundaryLog entries={boundary.entries} names={boundary.names} />

        {/*
          A link, not a disclosure. The brief has an address now, and an
          expandable second copy of the form under the plan would put two
          briefs on one screen.
        */}
        <Link
          href="/events/new"
          className="w-fit rounded-sm px-2.5 py-1.5 font-mono text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Plan another event
        </Link>
      </main>
    </>
  );
}
```

Note what is preserved: `getPlanRows(event.id, actor.orgId)` and `getBoundaryLog(event.id, actor.orgId)` both keep the two-argument form introduced in `d67596c`. The `BriefForm` import is gone.

- [ ] **Step 3: Delete the `compact` prop**

In `src/components/BriefForm.tsx`:

Change the signature from

```tsx
export function BriefForm({ compact = false }: { compact?: boolean }) {
```

to

```tsx
export function BriefForm() {
```

Unwrap the header — it was only conditional to hide it in the disclosure. Change

```tsx
      {!compact && (
        <div className="flex flex-col gap-1.5">
          <h2 className="font-serif text-2xl tracking-[-0.01em]">What are you planning?</h2>
          <p className="max-w-[58ch] text-sm leading-relaxed text-ink-muted">
            The agent decomposes this into line items under the budget. Anything a policy rule
            stops is routed to the person who holds authority over it.
          </p>
        </div>
      )}
```

to

```tsx
      <div className="flex flex-col gap-1.5">
        <h2 className="font-serif text-2xl tracking-[-0.01em]">What are you planning?</h2>
        <p className="max-w-[58ch] text-sm leading-relaxed text-ink-muted">
          The agent decomposes this into line items under the budget. Anything a policy rule
          stops is routed to the person who holds authority over it.
        </p>
      </div>
```

Collapse the form's `className` ternary from

```tsx
      className={`flex flex-col gap-4 rounded-sm border border-rule bg-surface ${
        compact ? 'p-5' : 'px-6 py-7'
      }`}
```

to

```tsx
      className="flex flex-col gap-4 rounded-sm border border-rule bg-surface px-6 py-7"
```

Fix the textarea's row count from

```tsx
          rows={compact ? 3 : 4}
```

to

```tsx
          rows={4}
```

- [ ] **Step 4: Verify `compact` is gone and everything typechecks**

Run: `grep -rn "compact" src/app src/components/BriefForm.tsx`
Expected: no output (exit code 1).

Scope this grep to `src/app` and `BriefForm.tsx` rather than all of `src/`. A
bare `grep -rn "compact" src/` also matches the English word in a `BoundaryLog`
comment and in a `policy-router.test.ts` test name, neither of which is this
prop, so it can never return empty.

Run: `npx tsc --noEmit`
Expected: no output.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Verify the routes behave**

With `npm run dev` running, walk the flow:

1. Open `http://localhost:3000/`. Expected: the plan table for the most recent event, with "Plan another event" as a plain link at the bottom — no disclosure triangle.
2. Click "Plan another event". Expected: `/events/new`, brief pre-filled.
3. Confirm the nav does not shift: "Plan" stays highlighted on both pages.
4. Click "Plan this". Expected: a new plan, and the browser lands back on `/`.

Then verify the redirect. This needs an org with no events, which the demo database no longer has — so check it by reasoning against the code rather than destroying demo data: `if (!event || rows.length === 0) redirect('/events/new')` runs before any JSX, and `/events/new` never redirects, so there is exactly one hop. **Do not delete rows from `events` or `line_items` to test this.** A wiped demo database at 17:00 costs more than an unverified branch.

- [ ] **Step 6: Run the existing test suite**

Run: `npm test`
Expected: all tests pass. Nothing in this change touches `src/lib`, so a failure here means something unrelated broke and should be investigated before committing rather than absorbed into this commit.

- [ ] **Step 7: Commit**

```bash
git add src/app/page.tsx src/components/BriefForm.tsx
git commit -m "Send the empty plan page to the brief, and drop the disclosure"
```

Again, staged by name.

---

## Self-review

**Spec coverage.** Every section of `2026-07-30-events-new-page-design.md` maps to a step: the new route → Task 1 Step 2; the `redirect` → Task 2 Step 2; the `<details>` → `<Link>` swap → Task 2 Step 2; `DEFAULT_BRIEF` and dropping the placeholder → Task 1 Step 4; `push('/')` → Task 1 Step 4; deleting `compact` → Task 2 Step 3; "`IdentityBar` unchanged" and "`proxy.ts` unchanged" → both absent from every Files block, as intended.

**Placeholder scan.** No TBDs. Every code step carries the literal code. The two "no test file" entries are explicit decisions with stated reasoning, not deferrals.

**Type consistency.** `getPlanRows(eventId, orgId)` and `getBoundaryLog(eventId, orgId)` are two-argument in both the plan and `src/lib/queries.ts` as of `d67596c`. `IdentityBar`'s `active` prop is `'plan'` in both pages and its union already permits it. `BriefForm` takes no props after Task 2, and its only two callers (`/events/new` from Task 1, and nothing on `/`) pass none.

**Known asymmetry.** Task 1 leaves `BriefForm` momentarily supporting a `compact` prop that `/` still passes — intentional, so Task 1 stands alone as a reviewable, working commit. Task 2 closes it.
