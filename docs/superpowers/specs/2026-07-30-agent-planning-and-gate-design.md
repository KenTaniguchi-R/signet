# Signet — Agent Planning & Approval Gate

**Date:** 2026-07-30
**Scope:** plan → policy → gate → persist. Stops before execution (Issuing / Slack / meter).
**Depends on:** `getViewer()`, implemented in parallel by the author of the Auth0 layer.

---

## 1. What this builds

Two agent calls and the harness between them.

1. **Plan.** The model decomposes a brief into 12 line items under a budget. No tools, no credentials.
2. **Spend.** The model calls one gated tool per line item. Policy decides which calls halt. The harness writes the resulting approvals with the required approver resolved server-side.

Execution of an approved item — the Issuing card, the Token Vault Slack post, the meter event — is a later chunk. This one ends when `approvals` rows exist and `/inbox` has something to render.

## 2. Verified API facts

Checked against `ai@7.0.42` type definitions and bundled docs, 2026-07-30. Three of these contradict the vault notes.

| Fact | Source |
|---|---|
| `streamObject` is **deprecated** — *"Use `streamText` with an `output` setting instead."* | `node_modules/ai/dist/index.d.ts:7575` |
| Structured output is `output: Output.object({ schema })` on `generateText` / `streamText` | `docs/03-ai-sdk-core/10-generating-structured-data.mdx` |
| **"A tool call needs approval"** halts the agent loop | `docs/03-agents/04-loop-control.mdx:12` |
| `tool-approval-request` carries `approvalId`, `toolCall` (typed, with `.input`), `isAutomatic`, `signature` | `ToolApprovalRequestOutput` in `index.d.ts` |
| Resume = push `{ role: 'tool', content: [{ type: 'tool-approval-response', approvalId, approved, reason }] }` | `docs/03-agents/06-tool-approvals.mdx` |
| `toolApproval` accepted on `ToolLoopAgent`, `generateText`, `streamText` | 3 declaration sites in `index.d.ts` |
| `experimental_toolApprovalSecret` exists and HMAC-binds an approval to tool name + call id + input | `index.d.ts`, 4 sites |
| `stepCountIs` is aliased to `isStepCount` | export list in `index.d.ts` |
| Next 16 route handlers: `const { id } = await ctx.params` | `next/dist/docs/01-app/01-getting-started/15-route-handlers.md:195` |

**Model:** `gpt-4.1`. The key on this account does not serve `gpt-5` — verified against `/v1/models`. Build-notes §4.4 hardcodes `gpt-5`, which would 404 mid-demo.

## 3. Corrections to build-notes §4.4

Both are internal contradictions in the reference snippet, not disagreements about intent.

**`lineItemId`.** The persist snippet reads `part.toolCall.input.lineItemId`; the intent schema three blocks above has no such field. Resolution: the tool schema carries `lineItemId`. A row id is a resource reference, not an identity — invariant 2 bars `approverId`, `orgId`, and token fields. The harness verifies the id belongs to the event in scope before acting on it, so a hallucinated or cross-tenant id is rejected rather than trusted.

**`rule` out of scope.** The snippet reads `rule.approverId` inside the persist loop, but `rule` is bound inside the `toolApproval` callback. Resolution: the loop re-resolves policy from `part.toolCall.input`. `resolvePolicy` is pure, so re-running it is free and cannot diverge.

**`getViewer` return type.** Build-notes §4.2 returns the Auth0 `sub` as `userId`. `approvals.required_approver_id` and `approvals.approved_by` are FKs to `users.id` (a UUID). Returning `sub` there would fail the FK or, worse, silently compare unequal strings in the ownership check. `Viewer.userId` is `users.id`; the Auth0 `sub` is carried separately.

## 4. Architecture

```
POST /api/events/plan
  generateText + Output.object(planSchema)     ← no tools, no credentials
  → INSERT events, INSERT 12 line_items (status: 'proposed')

POST /api/events/[id]/spend
  ToolLoopAgent { tools: { spend }, toolApproval }
    per tool call → resolvePolicy(input)         ← pure function
      requiresApproval: false → undefined   → execute → 'auto_approved'
      requiresApproval: true  → 'user-approval' → loop halts
  run returns
  → for each tool-approval-request part:
      re-resolve policy, resolveApprover(orgId, role) from DB
      INSERT approvals { approvalId, requiredApproverId, ruleName, status: 'pending' }
      UPDATE line_items SET status = 'awaiting_approval'
  → persist message history for the resume call
```

The model never sees an approver, an org, or a token. It sees a category, a vendor, an amount, a reversibility flag, and a line item id it was already given.

### Module boundaries

| File | Responsibility | Depends on |
|---|---|---|
| `src/lib/agent/schema.ts` | `lineItemIntent` Zod schema. Shared by plan output and tool input. | zod |
| `src/lib/policy.ts` | `resolvePolicy(input) → PolicyDecision`. **Pure.** No DB, no I/O, no clock. | schema types |
| `src/lib/policy-router.ts` | `resolveApprover(orgId, role) → userId \| null`. DB only. | db, policy types |
| `src/lib/viewer.ts` | `Viewer` type + `getViewer()` declaration. | — |
| `src/lib/agent/model.ts` | The one place a model name appears. | @ai-sdk/openai |
| `src/lib/agent/plan.ts` | Phase 1. Prompt, call, persist. | model, schema, db |
| `src/lib/agent/spend.ts` | Phase 2. Agent construction, gate, persist-approvals harness. | model, schema, policy, policy-router, db |
| `src/lib/activity.ts` | `logActivity({ kind, payload, harnessInjected })`. | db |

`policy.ts` is pure so it can be unit-tested without a database — per AGENTS.md it is the only thing worth testing today.
`policy-router.ts` is separate solely to keep that purity; merging them would drag a DB into every test.

### The seam

```ts
// src/lib/viewer.ts
export type Viewer = {
  /** users.id — a UUID from OUR table. NOT the Auth0 sub. */
  userId: string;
  /** orgs.id — a UUID from OUR table. NOT the Auth0 org_id. */
  orgId: string;
  /** Authoritative. Read from the users table. Survives a token refresh. */
  roles: Role[];
  /** From the session claim. Display only — never authorize on this. */
  claimedRoles: string[];
};

export async function getViewer(): Promise<Viewer | null>;
```

Implemented by the Auth0 layer. Until it lands, a dev implementation reads a seeded user, gated on `SIGNET_DEV_VIEWER_EMAIL` and a hard `NODE_ENV !== 'production'` check so it cannot ship.

## 5. The intent schema

```ts
export const lineItemIntent = z.object({
  category: z.enum(['venue', 'catering', 'drinks', 'av', 'prizes', 'supplies']),
  vendor: z.string().min(1),
  amountCents: z.number().int().positive(),
  reversible: z.boolean(),
  rationale: z.string(),   // why the agent chose this — demo surface, not authorization input
});
```

No `approverId`. No `orgId`. No token. No role. A fully compromised model emitting arbitrary conforming JSON still cannot name a person.

The spend tool's input is this schema plus `lineItemId: z.string().uuid()`.

## 6. Policy

```ts
export type PolicyDecision =
  | { requiresApproval: false; ruleName: string }
  | { requiresApproval: true; approverRoles: Role[]; ruleName: string };

export function resolvePolicy(input: LineItemIntent): PolicyDecision;
```

Rules are **additive, not first-match**. Every rule is evaluated; the required roles are the union of what matched.

| # | Condition | Adds | `ruleName` |
|---|---|---|---|
| 1 | `amountCents > 200_000` | `finance`, `legal` | `over_2000_requires_finance_and_legal` |
| 2 | `!reversible` | `legal` | `irreversible_requires_legal` |
| 3 | `20_000 <= amountCents <= 200_000` | `ops` | `over_200_requires_team_lead` |
| — | nothing matched | — | `under_200_auto_approve` |

`ruleName` on the decision is the matched names joined by `+`, so the audit trail records every reason, not just the first one.

First-match ordering was the obvious design and it is wrong here. The demo's venue item is **$2,800 and irreversible** — it matches rules 1 and 2 at once. Under first-match it would route to legal alone, and spec §4's mock (Sato/Finance seeing it, "Also requires: Legal") would be unreachable. Union routing is what the demo actually shows.

Rule 3 is bounded on both sides rather than open-topped, so a $5,000 item does not also pull in `ops`. Above $2,000, finance and legal supersede the team lead.

Worked examples from the demo brief:

| Item | Amount | Reversible | Roles | `ruleName` |
|---|---|---|---|---|
| Venue | $2,800 | no | `finance`, `legal` | `over_2000_requires_finance_and_legal+irreversible_requires_legal` |
| Catering | $900 | yes | `ops` | `over_200_requires_team_lead` |
| Drinks | $180 | yes | — | `under_200_auto_approve` |
| Supplies | $40 | yes | — | `under_200_auto_approve` |

Multi-approver items write one `approvals` row per required role. The line item does not become `approved` until every row is. That matches the mock in spec §4 ("Also requires: Legal (pending)").

### Tests

`resolvePolicy` gets a table-driven test. No mocks — it is a pure function of its input. Cases:

- Every threshold from both sides: 19_999 / 20_000 / 200_000 / 200_001.
- An irreversible item **under $200** still routes to legal, and does *not* pick up `ops`.
- An irreversible item **over $2,000** returns `finance` + `legal` with **both** rule names in `ruleName` — the regression test for the first-match bug above.
- Roles are deduplicated: rules 1 and 2 both add `legal`, and the venue case must yield two roles, not three.
- A `$2,000` item exactly routes to `ops` and not to finance — the spec band is `$200 – $2,000` inclusive.

## 7. The gate

```ts
const agent = new ToolLoopAgent({
  model: signetModel(),
  tools: { spend: spendTool },
  toolApproval: {
    spend: (input) => (resolvePolicy(input).requiresApproval ? 'user-approval' : undefined),
  },
  stopWhen: isStepCount(30),
});
```

`undefined` rather than `'not-applicable'` — the docs treat them identically and `undefined` is the documented default return.

`experimental_toolApprovalSecret` is passed from `SIGNET_TOOL_APPROVAL_SECRET`. It is defence in depth, not the boundary: the SDK binds an approval to its tool call, and our `approvals` row independently decides who was allowed to make it. If the env var is absent the app logs a warning and continues — a missing secret must not break the demo, because it is not what makes the system safe.

### Persisting what came back

```ts
for (const part of result.content) {
  if (part.type !== 'tool-approval-request' || part.isAutomatic) continue;

  const input = part.toolCall.input;

  // The model supplied this id. Verify it before trusting it.
  const lineItem = await db.findLineItem(input.lineItemId, eventId);
  if (!lineItem) { await logActivity({ kind: 'rejected_unknown_line_item', ... }); continue; }

  const decision = resolvePolicy(input);              // re-resolved, pure
  if (!decision.requiresApproval) { /* unreachable; log and skip */ }

  for (const role of decision.approverRoles) {
    const approverId = await resolveApprover(viewer.orgId, role);   // ← DB, not model
    await db.createApproval({
      lineItemId: lineItem.id,
      approvalId: part.approvalId,
      requiredRole: role,
      requiredApproverId: approverId,
      ruleName: decision.ruleName,
      status: 'pending',
    });
  }
}
```

Every `approvals` row is written from `resolvePolicy` plus a DB lookup. Nothing on that row originates in the model's output except the line item it points at, and that pointer is validated against the event first.

### Activity logging

Each tool call writes one `activity` row:

```ts
payloadJson:         input                                    // what the MODEL supplied
harnessInjectedJson: { approverIds, orgId, ruleName, requiredRoles }   // what WE resolved
```

The split is the demo talking point: two JSON columns side by side, and nothing in the right-hand one came from the left.

## 8. Message history

Resuming needs `result.responseMessages` from the spend call. The run is stateless between calls, so the history is persisted alongside the event — a `messages_json` column on `events`, written at the end of the spend call.

This is the honest limitation named in AGENTS.md: if the process dies the approval survives and the history does not. `messages_json` narrows that window to a single write. The production answer is still `WorkflowAgent`.

## 8.5 Schema changes

Two additions to `src/db/schema.ts`, both required by sections above. Applied with `npx drizzle-kit push`.

| Change | Required by |
|---|---|
| `events.messages_json` — `jsonb`, nullable | §8, the resume path needs the history |
| `uniqueIndex('approvals_item_role_idx').on(lineItemId, requiredRole)` | §9, idempotency on a repeated tool call |

Nothing else in the schema moves. `approvals.approval_id` is deliberately **not** unique — one `tool-approval-request` fans out to one row per required role, and the venue item proves it.

## 9. Error handling

| Failure | Handling |
|---|---|
| Plan output fails schema validation | `NoObjectGeneratedError` → 422 with the raw text. One retry at the route, not inside the agent. |
| Plan exceeds the budget | Not an error. Persisted and surfaced in the UI — a plan that overshoots is information, and silently discarding it hides the constraint-satisfaction work. |
| `resolveApprover` returns null (no user holds the role) | Hard fail the spend call, 409. Better a visible error than an approval nobody can action. Seed data must cover every role the policy can name. |
| Model calls `spend` with an unknown `lineItemId` | Skip, log to `activity`, continue. Do not fail the run. |
| Model calls `spend` twice for one line item | Idempotent on `(lineItemId, requiredRole)` — a unique index. Second insert is a no-op. |
| No `OPENAI_API_KEY` | Throw at module load with a message naming `.env.local`, matching `src/db/index.ts`. |

## 10. Out of scope

Named so they are not silently assumed: the resume path and `/api/approvals/[id]/approve`; Issuing; the Token Vault exchange; the meter event; `/inbox` and `/events/[id]`; streaming the plan (cut line #2 — `Output.object` on `streamText` with `partialOutputStream` is the upgrade path, and the schema does not change).

## 11. Definition of done

- `npx tsc --noEmit` clean. No `any` in policy or viewer paths.
- `resolvePolicy` tests pass, including both boundary sides of every threshold.
- `POST /api/events/plan` with the spec §2 brief returns 12 line items summing at or under $5,000.
- `POST /api/events/[id]/spend` leaves exactly 3 line items at `awaiting_approval` and writes **4** `approvals` rows — the venue contributes two (finance + legal), catering and one other contribute one each. The remaining 9 items are `auto_approved`.
- Every `approvals` row has a non-null `required_approver_id` resolved from the DB.
- `activity` rows show a populated `harness_injected_json` distinct from `payload_json`.
- Grepping `src/lib/agent/` for `approverId`, `role`, or `token` finds no hit inside any Zod schema handed to the model.
