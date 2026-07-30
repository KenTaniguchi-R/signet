# Signet Agent — Planning & Approval Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent that decomposes a budget brief into 12 line items, routes each through a policy router, and halts on the ones needing human sign-off — writing approval rows whose required approver is resolved server-side, never by the model.

**Architecture:** Two agent calls with a harness between them. Phase 1 is `generateText` + `Output.object` with no tools — pure constraint satisfaction, no credentials in scope. Phase 2 is a `ToolLoopAgent` with a single gated `spend` tool; `toolApproval` runs the pure policy router per call, and a `'user-approval'` return halts the loop (a documented stop condition in `ai@7`). The harness then re-resolves policy from the returned `tool-approval-request` parts and writes `approvals` rows with `required_approver_id` from the DB.

**Tech Stack:** Next.js 16 App Router · TypeScript · `ai@7.0.42` + `@ai-sdk/openai@4` · Zod v4 · Drizzle + Neon Postgres · `node --test` (Node 24 native TS type-stripping, zero test dependencies)

**Spec:** `docs/superpowers/specs/2026-07-30-agent-planning-and-gate-design.md`

## Global Constraints

- **`approved_by` and `required_approver_id` come from the server session and the DB. Never from a request body or model output.** This is the security model.
- **No Zod schema handed to the model may contain `approverId`, `orgId`, `role`, or any token field.** A compromised model must be structurally unable to name a person.
- **No `any` in the auth or policy paths.** (AGENTS.md)
- **All DB access in route handlers and server components, Node runtime.** (AGENTS.md)
- **`ai@7` pins:** `streamObject` and `generateObject` are deprecated — use `output: Output.object({ schema })` on `generateText`/`streamText`. `stepCountIs` is `isStepCount`. **Never install `@auth0/ai-vercel`** (peers `ai: ^5 || ^6`).
- **Model is `gpt-4.1`.** This account's key does not serve `gpt-5`; build-notes §4.4 is wrong on this.
- **Next 16 route handlers:** `const { id } = await ctx.params` — params is a Promise.
- **Meter events emit sequentially, never `Promise.all`** (409 on concurrent same-customer events). Not exercised in this plan, but do not add a `Promise.all` over line items that a later task would inherit.
- **Secrets live in `.env.local`, never committed.**
- **`src/lib/policy.ts` and `src/lib/policy.test.ts` are DONE and are the source of truth.** Do not modify or re-test them.
- **`src/lib/actor.ts` is DONE and is the session contract.** Use `getActor(): Promise<Actor | null>` and `requireActor()`. `Actor.userId` is `users.id`, `Actor.orgId` is `orgs.id`, and `Actor.role` is **singular**. Do not modify this file, do not add a `getViewer`.
- **Import convention, and it matters:** any module reachable from a `*.test.ts` must use **relative `.ts` specifiers** (`../db/index.ts`). Node's test runner does not read `tsconfig` path aliases, so a transitive `@/db` import fails to resolve under `node --test`. Route handlers and other untested files may use `@/…`, matching `actor.ts` and `proxy.ts`.
- **A concurrent writer is active in this repo.** Before editing any file you did not create, re-read it — it may have changed since this plan was written. Never revert someone else's edit to make your own apply.

---

### Task 1: Make the test runner see `.env.local`

**Revised 2026-07-30 during execution.** The original Task 1 — adding `allowImportingTsExtensions` to `tsconfig.json` and a `test` script to `package.json` — was completed by a concurrent writer before this plan ran. Verified green: `npm test` → 13/13 pass, `npx tsc --noEmit` → clean. **Do not redo it.**

What remains is a problem the original plan missed. Later tasks add tests for modules that transitively import `src/db/index.ts`, and that module **throws at import time** when `DATABASE_URL` is unset:

```ts
if (!connectionString) {
  throw new Error('DATABASE_URL is not set — see .env.example');
}
```

`node --test` does not read `.env.local`, so `plan.test.ts`, `spend.test.ts`, and `policy-router.test.ts` would all fail at import before a single assertion ran. `policy.test.ts` escapes this only because its one DB import is `import type`, which type-stripping erases.

`--env-file-if-exists` is the fix: it loads the file when present and is a no-op when absent, so a fresh clone without `.env.local` still runs the tests that don't need it. (Plain `--env-file` errors out when the file is missing.)

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` with `.env.local` loaded. Every later task's test step depends on it.

- [ ] **Step 1: Reproduce the failure the fix prevents**

Run:
```bash
node --test src/db/index.ts
```
Expected: FAIL — `DATABASE_URL is not set`. This is the error later tasks would hit.

- [ ] **Step 2: Confirm the fix clears it**

Run:
```bash
node --env-file-if-exists=.env.local --test src/db/index.ts
```
Expected: no `DATABASE_URL` error. (It reports 0 tests — that file has none. The point is that it loads.)

- [ ] **Step 3: Update the test script**

Re-read `package.json` first — a concurrent writer edited it recently. Change the existing `test` script to:

```json
    "test": "node --env-file-if-exists=.env.local --test \"src/**/*.test.ts\"",
```

- [ ] **Step 4: Verify the existing suite still passes**

Run: `npm test`
Expected: PASS — `tests 13`, `pass 13`, `fail 0`.

- [ ] **Step 5: Commit**

Commit **only** `package.json`. Other files in the tree belong to a concurrent writer — do not stage them.

```bash
git add package.json
git commit -m "test: load .env.local in the test runner

Modules under test transitively import src/db/index.ts, which throws at
import when DATABASE_URL is unset. --env-file-if-exists keeps a clone
without .env.local runnable."
```

---

### Task 2: The intent schema

The schema the model sees. Shared by the planner's output and the spend tool's input. Its job is to be structurally incapable of naming a person.

**Files:**
- Create: `src/lib/agent/schema.ts`
- Test: `src/lib/agent/schema.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `lineItemIntent` — Zod object schema
  - `type LineItemIntent = z.infer<typeof lineItemIntent>`
  - `planOutput` — Zod object schema, `{ summary: string, lineItems: LineItemIntent[] }`
  - `type PlanOutput = z.infer<typeof planOutput>`
  - `spendInput` — `lineItemIntent` extended with `lineItemId: z.string().uuid()`
  - `type SpendInput = z.infer<typeof spendInput>`
  - `IDENTITY_FIELDS: readonly string[]` — the banned key list, exported so later tasks can reuse the guard

- [ ] **Step 1: Write the failing test**

Create `src/lib/agent/schema.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IDENTITY_FIELDS,
  lineItemIntent,
  planOutput,
  spendInput,
} from './schema.ts';

describe('lineItemIntent', () => {
  test('accepts a well-formed line item', () => {
    const parsed = lineItemIntent.parse({
      category: 'venue',
      vendor: 'Okta HQ 13F',
      amountCents: 280000,
      reversible: false,
      rationale: 'Capacity 60 exceeds the 50-person headcount.',
    });

    assert.equal(parsed.amountCents, 280000);
    assert.equal(parsed.reversible, false);
  });

  test('strips an injected approverId rather than passing it through', () => {
    const parsed = lineItemIntent.parse({
      category: 'venue',
      vendor: 'Okta HQ 13F',
      amountCents: 280000,
      reversible: false,
      rationale: 'x',
      approverId: 'c0ffee00-0000-4000-8000-000000000000',
    });

    assert.equal('approverId' in parsed, false);
  });

  test('rejects a fractional amount', () => {
    assert.equal(
      lineItemIntent.safeParse({
        category: 'drinks',
        vendor: 'Bevmo',
        amountCents: 1999.5,
        reversible: true,
        rationale: 'x',
      }).success,
      false,
    );
  });

  test('rejects a zero or negative amount', () => {
    for (const amountCents of [0, -100]) {
      assert.equal(
        lineItemIntent.safeParse({
          category: 'drinks',
          vendor: 'Bevmo',
          amountCents,
          reversible: true,
          rationale: 'x',
        }).success,
        false,
        `amountCents=${amountCents} must not parse`,
      );
    }
  });

  test('rejects an unknown category', () => {
    assert.equal(
      lineItemIntent.safeParse({
        category: 'bribes',
        vendor: 'x',
        amountCents: 100,
        reversible: true,
        rationale: 'x',
      }).success,
      false,
    );
  });
});

describe('invariant 2 - the schema cannot express an identity', () => {
  // Walk the shape rather than JSON.stringify-ing it: Zod schema objects hold
  // internal references that stringify to {} or throw on a cycle, which would
  // make this guard silently pass on everything.
  function collectKeys(schema: unknown, seen = new Set<string>()): Set<string> {
    const shape = (schema as { shape?: Record<string, unknown> })?.shape;
    if (shape) {
      for (const [key, child] of Object.entries(shape)) {
        seen.add(key);
        collectKeys(child, seen);
      }
    }
    const element = (schema as { element?: unknown })?.element;
    if (element) collectKeys(element, seen);
    return seen;
  }

  test('no identity field appears in any model-facing schema', () => {
    for (const schema of [lineItemIntent, planOutput, spendInput]) {
      const keys = collectKeys(schema);
      for (const field of IDENTITY_FIELDS) {
        assert.ok(
          !keys.has(field),
          `${field} must never appear in a model-facing schema`,
        );
      }
    }
  });

  test('the key walker actually sees nested keys', () => {
    // Guards the guard: if collectKeys returned an empty set the test above
    // would pass vacuously.
    assert.ok(collectKeys(planOutput).has('amountCents'));
  });

  test('lineItemIntent exposes exactly the five intended keys', () => {
    assert.deepEqual(Object.keys(lineItemIntent.shape).sort(), [
      'amountCents',
      'category',
      'rationale',
      'reversible',
      'vendor',
    ]);
  });
});

describe('spendInput', () => {
  test('adds lineItemId and nothing else', () => {
    const extra = Object.keys(spendInput.shape).filter(
      (k) => !(k in lineItemIntent.shape),
    );
    assert.deepEqual(extra, ['lineItemId']);
  });

  test('rejects a lineItemId that is not a uuid', () => {
    assert.equal(
      spendInput.safeParse({
        lineItemId: 'not-a-uuid',
        category: 'venue',
        vendor: 'x',
        amountCents: 100,
        reversible: true,
        rationale: 'x',
      }).success,
      false,
    );
  });
});

describe('planOutput', () => {
  test('requires at least one line item', () => {
    assert.equal(
      planOutput.safeParse({ summary: 'empty', lineItems: [] }).success,
      false,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./schema.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/agent/schema.ts`:

```ts
import { z } from 'zod';

/**
 * Fields that would let the model name a person, an org, or a credential.
 * Invariant 2: no model-facing schema may contain any of these. The schema
 * test asserts it, so adding one is a test failure, not a code review note.
 */
export const IDENTITY_FIELDS = [
  'approverId',
  'approvedBy',
  'orgId',
  'userId',
  'role',
  'token',
  'accessToken',
  'refreshToken',
] as const;

/** What the model may say about a purchase. Nothing about who authorises it. */
export const lineItemIntent = z.object({
  category: z.enum(['venue', 'catering', 'drinks', 'av', 'prizes', 'supplies']),
  vendor: z.string().min(1),
  amountCents: z.number().int().positive(),
  reversible: z.boolean(),
  /** Why the agent chose this. Rendered in the UI; never an authorization input. */
  rationale: z.string().min(1),
});

export type LineItemIntent = z.infer<typeof lineItemIntent>;

export const planOutput = z.object({
  summary: z.string().min(1),
  lineItems: z.array(lineItemIntent).min(1),
});

export type PlanOutput = z.infer<typeof planOutput>;

/**
 * The gated tool's input. `lineItemId` is a resource reference, not an
 * identity — and the harness verifies it belongs to the event in scope
 * before acting on it, so a hallucinated id is rejected rather than trusted.
 */
export const spendInput = lineItemIntent.extend({
  lineItemId: z.string().uuid(),
});

export type SpendInput = z.infer<typeof spendInput>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 13 policy tests plus 9 schema tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS, no output.

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/schema.ts src/lib/agent/schema.test.ts
git commit -m "feat: intent schema the model cannot name a person in

IDENTITY_FIELDS is asserted against every model-facing schema, so
invariant 2 fails the build rather than failing review."
```

---

### Task 3: SUPERSEDED — do not implement

**Revised 2026-07-30 during execution.** This task specified a `getViewer()` seam with a production-guarded dev stand-in, to be replaced later by the Auth0 layer. A concurrent writer landed the real thing first: `src/lib/actor.ts` exports `getActor(): Promise<Actor | null>` and `requireActor(): Promise<Actor>`, reading the Auth0 session and joining `users` to `orgs`.

It gets right the detail this task existed to protect: `Actor.userId` is `users.id`, not the Auth0 `sub`, so the `approvals` foreign keys resolve.

**The contract later tasks consume:**

```ts
export interface Actor {
  userId: string;      // users.id       — FK target for approvals
  auth0Sub: string;
  orgId: string;       // orgs.id        — FK target for events
  auth0OrgId: string;
  email: string;
  displayName: string;
  role: Role;          // SINGULAR, not an array
}

export async function getActor(): Promise<Actor | null>;
export async function requireActor(): Promise<Actor>;   // throws instead of returning null
```

`getActor()` returns `null` both when there is no session and when the authenticated user has no row in the org — an unprovisioned user is not a member.

**Do not create `src/lib/viewer.ts`. Do not modify `src/lib/actor.ts`.** Tasks 6, 8, and 9 consume `Actor` and `getActor` directly. No task reads `Actor.role`: the approver for a line item is resolved from the DB by role in Task 7, never from the session — that separation is invariant 4.

Skip to Task 4.

### Task 4: Schema additions

Two columns/indexes the later tasks need. Applied with `drizzle-kit push`.

**Files:**
- Modify: `src/db/schema.ts`

**Interfaces:**
- Consumes: existing `events`, `approvals`, `lineItems` tables
- Produces: `events.messagesJson`, and a unique index on `approvals(line_item_id, required_role)`

- [ ] **Step 1: Add the messages column**

In `src/db/schema.ts`, in the `events` table definition, add after `status`:

```ts
  /** Serialized ModelMessage[] from the spend call. Needed to resume after approval. */
  messagesJson: jsonb('messages_json'),
```

- [ ] **Step 2: Add the idempotency index**

The `approvals` table currently uses the two-argument `pgTable(name, columns)` form and needs the three-argument form to carry an index. Replace the whole `export const approvals = ...` block with this — the column definitions are unchanged, only the wrapping:

```ts
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lineItemId: uuid('line_item_id')
      .notNull()
      .references(() => lineItems.id),
    /** AI SDK v7 tool-approval id — the handle used to resume the run. */
    approvalId: text('approval_id').notNull(),
    /** Resolved by the policy router. NEVER supplied by the model or the client. */
    requiredRole: text('required_role').$type<Role>().notNull(),
    requiredApproverId: uuid('required_approver_id').references(() => users.id),
    ruleName: text('rule_name').notNull(),
    status: text('status').$type<ApprovalStatus>().notNull().default('pending'),
    /** Set from the SERVER SESSION on approve. Never from the request body. */
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('approvals_item_role_idx').on(t.lineItemId, t.requiredRole)],
);
```

`approvals.approval_id` stays **non-unique** on purpose. One `tool-approval-request` fans out to one row per required role, and the venue item ($2,800, irreversible → finance + legal) produces two rows sharing an `approval_id`. A unique constraint there would silently drop the second approver.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. `jsonb` and `uniqueIndex` are already imported at the top of the file.

- [ ] **Step 4: Push the schema**

Run: `npm run db:push`
Expected: Drizzle reports the added column and index. If it hangs for several seconds on the first query, that is Neon's free tier cold-starting — wait, do not cancel.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat: messages_json for resume, unique approvals index for idempotency"
```

---

### Task 5: Model and activity helpers

Two small modules the agent tasks both need. Kept separate so the model name lives in exactly one place and the audit-log shape is defined once.

**Files:**
- Create: `src/lib/agent/model.ts`
- Create: `src/lib/activity.ts`
- Test: `src/lib/agent/model.test.ts`

**Interfaces:**
- Consumes: `db`, `activity` from `src/db/index.ts`
- Produces:
  - `signetModel(): LanguageModel`
  - `SIGNET_MODEL_ID: string`
  - `logActivity(args: { eventId: string; actorUserId?: string | null; kind: string; payload?: unknown; harnessInjected?: unknown }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/agent/model.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SIGNET_MODEL_ID } from './model.ts';

describe('model pin', () => {
  test('does not point at a model this account cannot serve', () => {
    // Verified against /v1/models on 2026-07-30: this key tops out at gpt-4.1.
    // build-notes 4.4 hardcodes gpt-5, which would 404 mid-demo.
    assert.ok(
      !SIGNET_MODEL_ID.startsWith('gpt-5'),
      `${SIGNET_MODEL_ID} is not available on this account's key`,
    );
  });

  test('is overridable by env for the demo machine', () => {
    assert.equal(typeof SIGNET_MODEL_ID, 'string');
    assert.ok(SIGNET_MODEL_ID.length > 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./model.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/agent/model.ts`:

```ts
import { createOpenAI } from '@ai-sdk/openai';

/**
 * Verified against /v1/models on 2026-07-30: this account's key serves up to
 * gpt-4.1. build-notes 4.4 says gpt-5, which does not exist here.
 */
export const SIGNET_MODEL_ID = process.env.SIGNET_MODEL_ID ?? 'gpt-4.1';

export function signetModel() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set — see .env.example');
  }
  return createOpenAI({ apiKey })(SIGNET_MODEL_ID);
}
```

Create `src/lib/activity.ts`:

```ts
import { activity, db } from '../db/index.ts';

/**
 * One row per boundary crossing. `payload` is what the MODEL supplied;
 * `harnessInjected` is what WE resolved. Keeping them in separate columns is
 * the audit story: nothing in the right-hand column came from the left.
 */
export async function logActivity(args: {
  eventId: string;
  actorUserId?: string | null;
  kind: string;
  payload?: unknown;
  harnessInjected?: unknown;
}): Promise<void> {
  await db.insert(activity).values({
    eventId: args.eventId,
    actorUserId: args.actorUserId ?? null,
    kind: args.kind,
    payloadJson: (args.payload ?? null) as never,
    harnessInjectedJson: (args.harnessInjected ?? null) as never,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/model.ts src/lib/agent/model.test.ts src/lib/activity.ts
git commit -m "feat: single-source model pin (gpt-4.1) and activity boundary logger"
```

---

### Task 6: Phase 1 — the planner

`generateText` with `output: Output.object`, no tools. Produces line items and persists them at `status: 'proposed'`.

**Files:**
- Create: `src/lib/agent/plan.ts`
- Test: `src/lib/agent/plan.test.ts`

**Interfaces:**
- Consumes: `planOutput` (Task 2), `signetModel` (Task 5), `Actor` from `src/lib/actor.ts`
- Produces:
  - `buildPlanPrompt(brief: { title: string; budgetCents: number; headcount: number; notes?: string }): string`
  - `planEvent(args: { actor: Actor; brief: PlanBrief }): Promise<{ eventId: string; plan: PlanOutput }>`
  - `type PlanBrief`

- [ ] **Step 1: Write the failing test**

`planEvent` needs a DB and a live model, so the unit test covers the prompt builder — the part with logic in it. Create `src/lib/agent/plan.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPlanPrompt } from './plan.ts';

const brief = {
  title: 'Built Different hackathon',
  budgetCents: 500000,
  headcount: 50,
  notes: '8 vegetarian, 3 gluten-free',
};

describe('buildPlanPrompt', () => {
  test('states the budget in dollars, not raw cents', () => {
    const prompt = buildPlanPrompt(brief);
    assert.ok(prompt.includes('$5,000'), 'budget must be human-readable');
    assert.ok(!prompt.includes('500000'), 'raw cents confuse the model');
  });

  test('carries the constraints that make this a planning problem', () => {
    const prompt = buildPlanPrompt(brief);
    assert.ok(prompt.includes('50'), 'headcount drives venue capacity');
    assert.ok(prompt.includes('8 vegetarian, 3 gluten-free'));
  });

  test('never tells the model who approves anything', () => {
    const prompt = buildPlanPrompt(brief).toLowerCase();
    for (const word of ['approver', 'finance', 'legal', 'ops role', 'sato']) {
      assert.ok(
        !prompt.includes(word),
        `prompt must not mention "${word}" — routing is the harness's job`,
      );
    }
  });

  test('omits the notes line entirely when there are no notes', () => {
    const prompt = buildPlanPrompt({ ...brief, notes: undefined });
    assert.ok(!prompt.includes('Additional constraints'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./plan.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/agent/plan.ts`:

```ts
import { Output, generateText } from 'ai';

import { db, events, lineItems } from '../db/index.ts';
import type { Actor } from '../actor.ts';
import { signetModel } from './model.ts';
import { type PlanOutput, planOutput } from './schema.ts';

export type PlanBrief = {
  title: string;
  budgetCents: number;
  headcount: number;
  notes?: string;
};

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US')}`;
}

/**
 * The prompt describes a constraint-satisfaction problem and nothing else.
 * It deliberately says nothing about approval, roles, or people: which
 * purchases need a human is decided by resolvePolicy after the fact, and a
 * model that knew the thresholds would be tempted to plan around them.
 */
export function buildPlanPrompt(brief: PlanBrief): string {
  const lines = [
    `Plan the spend for: ${brief.title}`,
    ``,
    `Total budget: ${dollars(brief.budgetCents)} (hard ceiling)`,
    `Headcount: ${brief.headcount}`,
    ...(brief.notes ? [`Additional constraints: ${brief.notes}`] : []),
    ``,
    `Produce about 12 line items across venue, catering, drinks, av, prizes,`,
    `and supplies. Constraints you must satisfy:`,
    `- Venue capacity must be at least the headcount.`,
    `- Catering must be sized for the headcount and honour the dietary notes.`,
    `- The total must not exceed the budget. Trade off between categories`,
    `  where needed and explain the trade-off in the rationale.`,
    `- Mark an item irreversible when it is a signed contract or a`,
    `  non-refundable deposit.`,
    ``,
    `Give every item a concrete named vendor and a one-sentence rationale.`,
  ];
  return lines.join('\n');
}

export async function planEvent(args: {
  actor: Actor;
  brief: PlanBrief;
}): Promise<{ eventId: string; plan: PlanOutput }> {
  const { output } = await generateText({
    model: signetModel(),
    output: Output.object({ schema: planOutput }),
    prompt: buildPlanPrompt(args.brief),
  });

  const [event] = await db
    .insert(events)
    .values({
      orgId: args.actor.orgId,
      title: args.brief.title,
      budgetCents: args.brief.budgetCents,
      createdBy: args.actor.userId,
      status: 'planning',
    })
    .returning();

  await db.insert(lineItems).values(
    output.lineItems.map((item) => ({
      eventId: event.id,
      category: item.category,
      vendor: item.vendor,
      amountCents: item.amountCents,
      reversible: item.reversible,
      status: 'proposed' as const,
    })),
  );

  return { eventId: event.id, plan: output };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — four `buildPlanPrompt` tests plus everything prior.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/plan.ts src/lib/agent/plan.test.ts
git commit -m "feat: phase 1 planner — Output.object, no tools, no credentials

streamObject is deprecated in ai@7; Output.object on generateText is the
v7 idiom. The prompt never mentions approval thresholds."
```

---

### Task 7: The approver router

Maps a role to a person, against the DB. Deliberately separate from `resolvePolicy` so that function stays pure and testable without a database.

**Files:**
- Create: `src/lib/policy-router.ts`
- Test: `src/lib/policy-router.test.ts`

**Interfaces:**
- Consumes: `Role` from `src/db/schema.ts`, `db`/`users` from `src/db/index.ts`
- Produces:
  - `resolveApprover(orgId: string, role: Role): Promise<string | null>` — returns `users.id`
  - `NoApproverForRoleError` — thrown by callers, exported here so the route can catch it
  - `resolveApprovers(orgId: string, roles: Role[]): Promise<string[]>` — throws `NoApproverForRoleError` if any role is unfilled

- [ ] **Step 1: Write the failing test**

Create `src/lib/policy-router.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { NoApproverForRoleError } from './policy-router.ts';

describe('NoApproverForRoleError', () => {
  test('names the role and the org so the failure is actionable on stage', () => {
    const err = new NoApproverForRoleError('legal', 'org-uuid-1');

    assert.ok(err.message.includes('legal'));
    assert.ok(err.message.includes('org-uuid-1'));
    assert.equal(err.role, 'legal');
    assert.equal(err.name, 'NoApproverForRoleError');
  });

  test('is an Error subclass so route handlers can catch it by type', () => {
    assert.ok(new NoApproverForRoleError('finance', 'o') instanceof Error);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./policy-router.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/policy-router.ts`:

```ts
import { and, eq } from 'drizzle-orm';

import { db, users } from '../db/index.ts';
import type { Role } from '../db/schema.ts';

export class NoApproverForRoleError extends Error {
  readonly role: Role;

  constructor(role: Role, orgId: string) {
    super(`No user in org ${orgId} holds the ${role} role.`);
    this.name = 'NoApproverForRoleError';
    this.role = role;
  }
}

/**
 * Role to person. This is the lookup the model is structurally prevented from
 * doing: the approver's identity enters the system here and nowhere else.
 */
export async function resolveApprover(
  orgId: string,
  role: Role,
): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.role, role)))
    .limit(1);

  return row?.id ?? null;
}

/**
 * Fails loudly on an unfilled role. An approval row with a null approver sits
 * in nobody's inbox and reads as a hang during the demo — a 409 is better.
 */
export async function resolveApprovers(
  orgId: string,
  roles: Role[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const role of roles) {
    const id = await resolveApprover(orgId, role);
    if (!id) throw new NoApproverForRoleError(role, orgId);
    ids.push(id);
  }
  return ids;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/policy-router.ts src/lib/policy-router.test.ts
git commit -m "feat: role-to-person lookup, kept out of the pure policy function

An unfilled role throws rather than writing a null-approver row that
would sit in nobody's inbox."
```

---

### Task 8: Phase 2 — the gated spend agent

The core of the feature. A `ToolLoopAgent` with one gated tool; `'user-approval'` halts the loop; the harness writes approvals from policy + DB.

**Files:**
- Create: `src/lib/agent/spend.ts`
- Test: `src/lib/agent/spend.test.ts`

**Interfaces:**
- Consumes: `spendInput` (Task 2), `resolvePolicy` (existing), `resolveApprovers` (Task 7), `signetModel` (Task 5), `logActivity` (Task 5), `Actor` from `src/lib/actor.ts`
- Produces:
  - `spendApprovalRule(input: SpendInput): 'user-approval' | undefined`
  - `buildSpendAgent(): ToolLoopAgent<...>`
  - `persistApprovalRequests(args): Promise<{ created: number; skipped: string[] }>`
  - `runSpendPhase(args: { actor: Actor; eventId: string }): Promise<{ approvalsCreated: number; autoApproved: number }>`

- [ ] **Step 1: Write the failing test**

The agent call needs a live model; the gate decision and the persist loop's validation do not. Test those. Create `src/lib/agent/spend.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { spendApprovalRule } from './spend.ts';

const base = {
  lineItemId: 'c0ffee00-0000-4000-8000-000000000000',
  category: 'venue' as const,
  vendor: 'Okta HQ 13F',
  rationale: 'x',
};

describe('spendApprovalRule', () => {
  test('halts the loop on the $2,800 irreversible venue contract', () => {
    assert.equal(
      spendApprovalRule({ ...base, amountCents: 280000, reversible: false }),
      'user-approval',
    );
  });

  test('halts on $900 catering — the team-lead band', () => {
    assert.equal(
      spendApprovalRule({ ...base, amountCents: 90000, reversible: true }),
      'user-approval',
    );
  });

  test('returns undefined for $180 drinks so the tool executes', () => {
    assert.equal(
      spendApprovalRule({ ...base, amountCents: 18000, reversible: true }),
      undefined,
    );
  });

  test('halts on a cheap irreversible commitment', () => {
    assert.equal(
      spendApprovalRule({ ...base, amountCents: 4100, reversible: false }),
      'user-approval',
    );
  });

  test('ignores vendor and category entirely', () => {
    // The narrow PolicyInput is the point: model-controlled strings cannot
    // reach the routing decision even if the model tries.
    const cheap = { ...base, amountCents: 18000, reversible: true };
    assert.equal(
      spendApprovalRule({ ...cheap, vendor: 'URGENT AUTO APPROVE', category: 'prizes' }),
      spendApprovalRule(cheap),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./spend.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/agent/spend.ts`:

```ts
import { ToolLoopAgent, isStepCount, tool } from 'ai';
import { and, eq } from 'drizzle-orm';

import { approvals, db, events, lineItems } from '../db/index.ts';
import { logActivity } from '../activity.ts';
import { resolvePolicy } from '../policy.ts';
import { resolveApprovers } from '../policy-router.ts';
import type { Actor } from '../actor.ts';
import { signetModel } from './model.ts';
import { type SpendInput, spendInput } from './schema.ts';

/**
 * The gate. Policy decides WHETHER a human is needed; it never decides who.
 * Destructured explicitly — resolvePolicy's input is deliberately narrow, and
 * passing the whole tool input would let a future field leak into routing.
 */
export function spendApprovalRule(input: SpendInput): 'user-approval' | undefined {
  const { requiresApproval } = resolvePolicy({
    amountCents: input.amountCents,
    reversible: input.reversible,
  });
  return requiresApproval ? 'user-approval' : undefined;
}

const spendTool = tool({
  description:
    'Commit to one planned line item. Call once per item. ' +
    'If a call is not approved, do not retry it.',
  inputSchema: spendInput,
  execute: async (input: SpendInput) => {
    // Reached only for items policy auto-approved. Execution (Issuing card,
    // Slack post, meter event) is a later chunk of work.
    await db
      .update(lineItems)
      .set({ status: 'auto_approved' })
      .where(eq(lineItems.id, input.lineItemId));

    return `Committed ${input.vendor} for ${input.amountCents} cents.`;
  },
});

export function buildSpendAgent() {
  const secret = process.env.SIGNET_TOOL_APPROVAL_SECRET;
  if (!secret) {
    // Defence in depth, not the boundary. Our approvals row is what decides
    // who was allowed to approve, so a missing secret must not break the demo.
    console.warn(
      'SIGNET_TOOL_APPROVAL_SECRET is not set — approval requests will be unsigned.',
    );
  }

  return new ToolLoopAgent({
    model: signetModel(),
    tools: { spend: spendTool },
    toolApproval: { spend: spendApprovalRule },
    stopWhen: isStepCount(30),
    ...(secret ? { experimental_toolApprovalSecret: secret } : {}),
    system:
      'You commit planned purchases by calling the spend tool once per line ' +
      'item, using the lineItemId given to you. When a call is not approved, ' +
      'do not retry it.',
  });
}

export async function runSpendPhase(args: {
  actor: Actor;
  eventId: string;
}): Promise<{ approvalsCreated: number; autoApproved: number }> {
  const items = await db
    .select()
    .from(lineItems)
    .where(eq(lineItems.eventId, args.eventId));

  const agent = buildSpendAgent();
  const messages = [
    {
      role: 'user' as const,
      content:
        'Commit each of these line items by calling the spend tool once ' +
        'per item:\n' +
        items
          .map(
            (i) =>
              `- lineItemId=${i.id} category=${i.category} vendor=${i.vendor} ` +
              `amountCents=${i.amountCents} reversible=${i.reversible}`,
          )
          .join('\n'),
    },
  ];

  const result = await agent.generate({ messages });

  let approvalsCreated = 0;

  for (const part of result.content) {
    if (part.type !== 'tool-approval-request' || part.isAutomatic) continue;

    const input = part.toolCall.input as SpendInput;

    // The model supplied this id. Verify it belongs to the event in scope
    // before trusting it — a hallucinated or cross-event id is dropped.
    const [lineItem] = await db
      .select()
      .from(lineItems)
      .where(
        and(eq(lineItems.id, input.lineItemId), eq(lineItems.eventId, args.eventId)),
      )
      .limit(1);

    if (!lineItem) {
      await logActivity({
        eventId: args.eventId,
        kind: 'rejected_unknown_line_item',
        payload: input,
        harnessInjected: { reason: 'lineItemId not in this event' },
      });
      continue;
    }

    const decision = resolvePolicy({
      amountCents: input.amountCents,
      reversible: input.reversible,
    });

    const approverIds = await resolveApprovers(
      args.actor.orgId,
      decision.approverRoles,
    );

    for (const [i, role] of decision.approverRoles.entries()) {
      await db
        .insert(approvals)
        .values({
          lineItemId: lineItem.id,
          approvalId: part.approvalId,
          requiredRole: role,
          requiredApproverId: approverIds[i],
          ruleName: decision.ruleName,
          status: 'pending',
        })
        .onConflictDoNothing();
      approvalsCreated += 1;
    }

    await db
      .update(lineItems)
      .set({ status: 'awaiting_approval' })
      .where(eq(lineItems.id, lineItem.id));

    await logActivity({
      eventId: args.eventId,
      kind: 'approval_required',
      payload: input,
      harnessInjected: {
        approverIds,
        orgId: args.actor.orgId,
        ruleName: decision.ruleName,
        requiredRoles: decision.approverRoles,
      },
    });
  }

  await db
    .update(events)
    .set({ messagesJson: result.responseMessages as never })
    .where(eq(events.id, args.eventId));

  // Count from the DB, not by subtracting from items.length. The loop halts at
  // the first step containing an approval request, so items the model never
  // reached are neither auto-approved nor pending — subtraction would report
  // them as committed money that never moved.
  const autoApprovedRows = await db
    .select({ id: lineItems.id })
    .from(lineItems)
    .where(
      and(eq(lineItems.eventId, args.eventId), eq(lineItems.status, 'auto_approved')),
    );

  return { approvalsCreated, autoApproved: autoApprovedRows.length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — five `spendApprovalRule` tests plus everything prior.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/spend.ts src/lib/agent/spend.test.ts
git commit -m "feat: gated spend agent — policy halts the loop, DB names the approver

Every approvals row comes from resolvePolicy plus a DB lookup. The only
model-supplied value on it is a lineItemId, validated against the event
before use."
```

---

### Task 9: Route handlers

Two POST routes wiring the phases to HTTP. Next 16: `ctx.params` is a Promise.

**Files:**
- Create: `src/app/api/events/plan/route.ts`
- Create: `src/app/api/events/[id]/spend/route.ts`

**Interfaces:**
- Consumes: `planEvent` (Task 6), `runSpendPhase` (Task 8), `getActor` from `src/lib/actor.ts`, `NoApproverForRoleError` (Task 7)
- Produces: `POST /api/events/plan`, `POST /api/events/[id]/spend`

- [ ] **Step 1: Create the plan route**

Create `src/app/api/events/plan/route.ts`:

```ts
import { NoObjectGeneratedError } from 'ai';
import { z } from 'zod';

import { planEvent } from '@/lib/agent/plan';
import { getActor } from '@/lib/actor';

export const runtime = 'nodejs';

const body = z.object({
  title: z.string().min(1),
  budgetCents: z.number().int().positive(),
  headcount: z.number().int().positive(),
  notes: z.string().optional(),
});

export async function POST(req: Request) {
  const actor = await getActor();
  if (!actor) return new Response('Unauthorized', { status: 401 });

  const parsed = body.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const { eventId, plan } = await planEvent({ actor, brief: parsed.data });
    return Response.json({ eventId, plan });
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err)) {
      return Response.json(
        { error: 'The model did not return a valid plan.', text: err.text },
        { status: 422 },
      );
    }
    throw err;
  }
}
```

- [ ] **Step 2: Create the spend route**

Create `src/app/api/events/[id]/spend/route.ts`:

```ts
import { runSpendPhase } from '@/lib/agent/spend';
import { NoApproverForRoleError } from '@/lib/policy-router';
import { getActor } from '@/lib/actor';

export const runtime = 'nodejs';

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const actor = await getActor();
  if (!actor) return new Response('Unauthorized', { status: 401 });

  // Next 16: params is a Promise.
  const { id } = await ctx.params;

  try {
    const result = await runSpendPhase({ actor, eventId: id });
    return Response.json(result);
  } catch (err) {
    if (err instanceof NoApproverForRoleError) {
      return Response.json({ error: err.message, role: err.role }, { status: 409 });
    }
    throw err;
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Verify the routes build**

Run: `npm run build`
Expected: PASS. Both routes appear in the route list as dynamic (ƒ).

- [ ] **Step 5: Commit**

```bash
git add src/app/api
git commit -m "feat: plan and spend route handlers

Next 16 params is a Promise. Unfilled approver role returns 409 rather
than writing an approval nobody can action."
```

---

### Task 10: End-to-end verification against the demo brief

No new code. This is the gate that says the feature works.

**Files:**
- Create: `docs/superpowers/plans/2026-07-30-verification-notes.md` (paste real output into it)

**Interfaces:**
- Consumes: everything
- Produces: evidence

- [ ] **Step 1: Seed users covering every role the policy can name**

The policy router can require `finance`, `legal`, and `ops`. If any is unfilled, Task 7 throws and the spend route 409s by design.

A concurrent writer already built the seed script, which creates one user per role:

Run: `npm run db:seed`

Then confirm all three roles exist in the demo org:
```sql
SELECT role, count(*) FROM users GROUP BY role ORDER BY role;
```
Expected: a row each for `finance`, `legal`, and `ops`, each count at least 1. If any is missing, stop — Task 7 will throw and the spend route will 409.

- [ ] **Step 2: Warm the database**

Neon's free tier suspends when idle. A multi-second pause at demo time reads as broken.

Run any trivial query (the studio connection in Step 1 counts).

- [ ] **Step 3: Start the dev server**

Run: `npm run dev`
Expected: ready on localhost:3000.

- [ ] **Step 4: Plan the demo event**

Run:
```bash
curl -s -X POST localhost:3000/api/events/plan \
  -H 'content-type: application/json' \
  -d '{"title":"Built Different hackathon","budgetCents":500000,"headcount":50,"notes":"8 vegetarian, 3 gluten-free"}' | tee /tmp/plan.json
```

Expected: `eventId` plus roughly 12 line items whose `amountCents` sum to at most 500000. Record the actual count and sum.

- [ ] **Step 5: Run the spend phase**

Run:
```bash
EVENT=$(python3 -c "import json;print(json.load(open('/tmp/plan.json'))['eventId'])")
curl -s -X POST "localhost:3000/api/events/$EVENT/spend"
```

Expected: `{"approvalsCreated":N,"autoApproved":M}` with `N >= 1`.

- [ ] **Step 6: Verify the invariants in the database**

Run each query against `DATABASE_URL` and paste the real output into the verification notes. `psql "$DATABASE_URL" -c "<query>"` works, as does Drizzle Studio.

1. **No approval lacks an approver.** Must return 0.
```sql
SELECT count(*) FROM approvals WHERE required_approver_id IS NULL;
```

2. **The model never named the approver.** Must return 0 — the approver UUID must not appear anywhere in what the model supplied.
```sql
SELECT count(*)
FROM approvals a
JOIN activity ac ON ac.kind = 'approval_required'
WHERE ac.payload_json::text LIKE '%' || a.required_approver_id::text || '%';
```

3. **The boundary is logged and the two sides differ.** Must return one row per approval-required item, with both columns non-null and unequal.
```sql
SELECT id, payload_json IS NOT NULL AS has_payload,
       harness_injected_json IS NOT NULL AS has_injected,
       payload_json::text <> harness_injected_json::text AS differ
FROM activity WHERE kind = 'approval_required';
```

4. **The venue item fans out to two approvers sharing one approval id.** Must return a row with `approver_count = 2` and `approval_ids = 1`.
```sql
SELECT li.vendor, li.amount_cents,
       count(*) AS approver_count,
       count(DISTINCT a.approval_id) AS approval_ids
FROM approvals a JOIN line_items li ON li.id = a.line_item_id
WHERE li.amount_cents > 200000 AND li.reversible = false
GROUP BY li.id, li.vendor, li.amount_cents;
```

If query 4 returns nothing, the model produced no irreversible item over $2,000 — re-run the plan, or set one item's `reversible` to false by hand and re-run spend. The demo depends on this case existing.

- [ ] **Step 7: Grep the invariant-2 guard**

Run:
```bash
grep -rnE "approverId|approvedBy|orgId|refreshToken|accessToken" src/lib/agent/schema.ts
```
Expected: matches **only** inside the `IDENTITY_FIELDS` array, nowhere in a schema definition.

- [ ] **Step 8: Full check**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: all three PASS.

- [ ] **Step 9: Commit the evidence**

```bash
git add docs/superpowers/plans/2026-07-30-verification-notes.md
git commit -m "docs: end-to-end verification of the plan and gate against the demo brief"
```

---

## Out of scope

Named so they are not silently assumed complete: the resume path and `POST /api/approvals/[id]/approve`; Stripe Issuing; the Token Vault exchange and Slack post; the `signet_managed_spend` meter event; `/inbox` and `/events/[id]` pages; streaming the plan (cut line #2 — the upgrade is `streamText` + `partialOutputStream` with the same schema).

The Auth0 session layer (`src/lib/auth0.ts`, `src/lib/actor.ts`, `src/proxy.ts`) and the seed script (`src/db/seed.mts`) were built by a concurrent writer and are consumed, not modified, by this plan.
