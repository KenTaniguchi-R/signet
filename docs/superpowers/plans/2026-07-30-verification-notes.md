# Task 10 — end-to-end verification against the demo brief

Run at 2026-07-30, ~22:20–22:35 UTC. Result: **BLOCKED** at the live-model step.
The OpenAI account backing `OPENAI_API_KEY` has zero credit balance, and that
blocks both `/api/events/plan` and `/api/events/[id]/spend`, which both call
the model. No production code was modified to work around this.

## Environment used

- `SIGNET_DEV_VIEWER_EMAIL=ken.taniguchi@northbeam.dev` — already set in
  `.env.local`, so `resolveActor()` did not need any change. This resolves to
  **Ken Taniguchi**, `finance` role, org `org_EXAMPLE` (matches
  `AUTH0_ORG_ID`). Per the brief's caveat, the demo script's script names
  "Sato Kenji" (finance in the *other* org, `org_EXAMPLE_STALE`), but the
  code correctly resolves to whoever holds `finance` in the actor's own org —
  Ken, not Sato. Not a bug; the demo narration and the seeded org just don't
  match. Not touched.
- Dev server: an existing `next dev` process was already running on
  `localhost:3000` when this session started. **I accidentally killed it**
  with a blanket `pkill -f "next dev"` while trying to clear a port conflict
  from my own duplicate `npm run dev` invocation, then immediately restarted
  it (`npm run dev`, ready in 279ms, confirmed `GET / → 200`). No other
  process or file was touched by that mistake; noting it for transparency.
- DB warm/seeded: confirmed all three roles (`finance`, `legal`, `ops`) exist
  in both orgs before running anything (see role table below).

## Step 4 — plan the demo event: FAILED (external, reproducible)

```
$ curl -s -X POST localhost:3000/api/events/plan \
  -H 'content-type: application/json' \
  -d '{"title":"Built Different hackathon","budgetCents":500000,"headcount":50,"notes":"8 vegetarian, 3 gluten-free"}'

{"error":"Failed after 3 attempts. Last error: AI_APICallError: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/."}
```

Reproduced 3 times (all identical). Called `planEvent()` directly (bypassing
the route, same code) to capture the full wrapped `AI_RetryError.errors[]`
rather than just the route's flattened message:

```
statusCode: 429
url: https://api.openai.com/v1/responses
responseBody: {
  "error": {
    "message": "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
    "type": "insufficient_quota",
    "param": null,
    "code": "credit_balance_exhausted"
  }
}
```

This is OpenAI's own `insufficient_quota` / `credit_balance_exhausted` error,
not a Signet bug. Sanity-checked the same key against OpenAI directly:

- `GET /v1/models` → 200, lists `gpt-4.1` and others (key itself is valid).
- Tiny `POST /v1/chat/completions` (5 max_tokens) → 200, succeeded.
- Tiny `POST /v1/responses` with a small `json_schema` format → 200, succeeded.
- The real plan prompt (full system instructions + the 400-token `planOutput`
  JSON Schema sent as `text.format`) against `/v1/responses` → 429
  `insufficient_quota` every time, including when called directly via
  `planEvent()` outside the route.

Best explanation: the project's credit balance is at or near zero, and the
larger structured-output request (bigger prompt + full JSON Schema payload)
prices out where a nearly-free tiny request still slips through. This is not
something a code change fixes. **The OpenAI project needs credits added
before this can demo.**

## Step 5 — spend phase: FAILED, same root cause

Also tried directly against an existing event already in the actor's org
(`b246ea11-f3fd-4475-a28a-f057d0d6a7eb`, org `org_EXAMPLE`), since
`runSpendPhase` also calls `signetModel()` via `ToolLoopAgent`:

```
$ curl -s -X POST "localhost:3000/api/events/b246ea11-f3fd-4475-a28a-f057d0d6a7eb/spend"

{"error":"Failed after 3 attempts. Last error: AI_APICallError: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/."}
```

Same error, same cause. Both agent-facing routes are blocked.

## What could still be checked without a live model call

### Step 7 — grep the invariant-2 guard: PASS

```
$ grep -rnE "approverId|approvedBy|orgId|refreshToken|accessToken" src/lib/agent/schema.ts
src/lib/agent/schema.ts:9:  'approverId',
src/lib/agent/schema.ts:10:  'approvedBy',
src/lib/agent/schema.ts:11:  'orgId',
src/lib/agent/schema.ts:15:  'accessToken',
src/lib/agent/schema.ts:16:  'refreshToken',
```

All five matches are lines 9–16, inside the `IDENTITY_FIELDS` array (the
array runs lines 8–17). None appear in `lineItemIntent`, `planOutput`, or
`spendInput` — the model-facing schemas are clean. `userId`, `role`, `token`
are also in `IDENTITY_FIELDS` but didn't match the grep pattern (the pattern
the brief specifies doesn't include those three words) — inspected the file
directly and confirmed they're in the same array, nowhere else.

### Database state — what already existed, and its actual provenance

The DB was **not empty**. There is prior data in it — `git status` showed
this repo has a concurrent writer, and their earlier test runs (today, before
credits ran out) left real rows behind. Rather than pretend a fresh run
happened, I traced exactly what each row is, because it changes what the
data can and can't prove:

```
events: 7, lineItems: 84, approvals: 8, activity: 7
```

**5 events are real, live `POST /api/events/plan` output** (LLM-generated
vendor names, real token cost, created 21:09–22:10 UTC today) with **no
spend phase ever run against them** (zero approvals rows reference them).
One example, within budget:

```
event ebbd4cf5-17a9-49f8-98af-3e1b9b860b73 — 12 items, sum $3,920.00 of $5,000.00 budget
  venue      Okta HQ San Francisco          $1200.00  reversible=false
  catering   ZeroCater                      $1200.00  reversible=true
  drinks     SodaStream + Safeway           $200.00   reversible=false
  drinks     Sightglass Coffee              $50.00    reversible=true
  drinks     Okta HQ (water)                $20.00    reversible=false
  av         Verge Event Productions        $600.00   reversible=true
  av         Okta HQ (in-house A/V)         $100.00   reversible=false
  prizes     Amazon (gift cards)            $300.00   reversible=false
  prizes     Stripe Swag Store              $75.00    reversible=false
  prizes     Auth0 Swag Store               $75.00    reversible=false
  supplies   Office Depot                   $65.00    reversible=false
  supplies   Target                         $35.00    reversible=false
```

Another live plan run went **over budget**:
`6f55a056-1f7a-4854-92bf-ae35999ae728` — 12 items summing to **$5,696.00
against a $5,000.00 budget (114%)**. This matches a comment already in
`src/lib/agent/plan.ts` documenting that gpt-4.1 has been observed
overshooting the budget in earlier testing ("78% unprompted, then 101% and
114% with the nudge") — so this is a known, already-flagged model-reliability
issue, not new. Flagging because it means the plan step's "hard ceiling"
framing does not reliably hold in practice; worth a defensive check
(reject/retry a plan that exceeds budget) if there's time before 17:30.

**2 events (`5033d2d0…`, `b246ea11…`) and all 8 `approvals` rows are
`src/db/seed.mts --withPlan` fixture data**, not model output and not a live
spend-phase run:

- `seed.mts` inserts a **hardcoded** line-item list (`PLAN` constant), not
  anything the LLM produced.
- It does run each item through the real `resolvePolicy()` — so the policy
  *router* is genuinely exercised — but it writes `approvals` rows directly
  with `requiredApproverId: seeded[role]`, bypassing `resolveApprovers()` /
  `dbApproverLookup` (the DB lookup path) entirely, and bypassing
  `persistApprovalRequests()` / `buildApprovalRows()` in `spend.ts` (the
  actual harness code this task exists to verify) completely.
- Every one of these 8 rows has `approval_id = 'seed_<lineItemId>'`, which is
  seed.mts's own literal string, not the AI SDK's tool-approval id
  (`part.approvalId`) that `runSpendPhase` would generate.
- **`activity` has zero rows with `kind = 'approval_required'`** — the kind
  `persistApprovalRequests()` writes on every real halt. Full kind list in
  the table: `plan_generated` ×5 (matching the 5 live plan events),
  `approval.approved` ×1, `spend.executed` ×1 (from an earlier live exercise
  of the *approve* route — `recordDecision()` — against the seeded item
  "Apple Union Square", unrelated to this task's scope).

**Conclusion: the exact code path this task exists to verify — the gated
agent proposing a spend, the policy router halting it, `persistApprovalRequests`
resolving the approver from the DB and writing the `approvals` row with the
`payload_json` / `harness_injected_json` boundary — has never actually run
end-to-end in this database.** It's covered by the 72 passing unit tests
(which inject fake lookups), but not by a real integration run, because the
one thing capable of driving it (a live model call through `runSpendPhase`)
is the exact thing that's blocked right now.

### SQL checks — run against what exists, results reported honestly

Ran the brief's exact queries (global, not scoped to any one event) against
the current DB. Because of the provenance above, only queries 1, 2, and 4
have any rows to check, and none of those rows come from a live spend-phase
run — see caveats after each.

**1. No approval lacks an approver — expect 0:**
```sql
SELECT count(*) FROM approvals WHERE required_approver_id IS NULL;
→ count: 0
```
PASS, but only 8 seed-fixture rows exist to check; no live-generated row has
ever been evaluated by this query.

**2. The model never named the approver — expect 0:**
```sql
SELECT count(*) FROM approvals a JOIN activity ac ON ac.kind = 'approval_required'
WHERE ac.payload_json::text LIKE '%' || a.required_approver_id::text || '%';
→ count: 0
```
Technically 0/PASS, but vacuously: the join has nothing to match because
zero `activity` rows have `kind = 'approval_required'` (see above). This
query cannot yet prove invariant 2 held in a real run — only that it hasn't
been contradicted, because it's never fired.

**3. The boundary is logged and the two sides differ:**
```sql
SELECT id, payload_json IS NOT NULL AS has_payload, ...
FROM activity WHERE kind = 'approval_required';
→ (0 rows)
```
**Cannot verify. Zero rows.** This is the one query in the brief that
directly tests the boundary-logging invariant, and there is nothing in the
database for it to check, live or seeded — `seed.mts` never writes to
`activity` at all for the halted items.

**4. The venue item fans out to two approvers sharing one approval id:**
```sql
SELECT li.vendor, li.amount_cents, count(*) approver_count, count(DISTINCT a.approval_id) approval_ids
FROM approvals a JOIN line_items li ON li.id = a.line_item_id
WHERE li.amount_cents > 200000 AND li.reversible = false
GROUP BY li.id, li.vendor, li.amount_cents;

→ Okta Facilities | 280000 | approver_count: 2 | approval_ids: 1   (×2 rows — one per seeded fixture event)
```
The fan-out case **does exist and is structurally correct** — two approvals
(`finance` + `legal`) share one `approval_id` for a $2,800 irreversible line
item. But both instances are from `seed.mts`'s hardcoded fixture, which
writes `approvals` directly rather than through `buildApprovalRows()` /
`persistApprovalRequests()`. The *shape* of the fan-out is right; whether the
harness code that's supposed to produce that shape from a live model call
actually does so is unverified.

Full `approvals` table for reference (all 8 rows, all seed-fixture):

| approval_id | vendor | amount | required_role | approver | rule_name | ai_sdk approval_id | status |
|---|---|---|---|---|---|---|---|
| 18d22b75… | Okta Facilities | $2800 | finance | Sato Kenji | irreversible_over_2000 | seed_f90fece8… | pending |
| dbb824f8… | Okta Facilities | $2800 | legal | Amara Okonkwo | irreversible_over_2000 | seed_f90fece8… | pending |
| 4cdaf2a1… | Souvla Hayes Valley | $1180 | ops | Devin Whitlock | band_200_2000_team_lead | seed_def3023d… | pending |
| 2233c443… | Apple Union Square | $240 | ops | Devin Whitlock | band_200_2000_team_lead | seed_aa86d7ab… | **approved** |
| f52ce3a8… | Okta Facilities | $2800 | finance | Ken Taniguchi | irreversible_over_2000 | seed_bcc8d92e… | pending |
| 55d5a042… | Okta Facilities | $2800 | legal | Amara Okonkwo | irreversible_over_2000 | seed_bcc8d92e… | pending |
| a2268642… | Souvla Hayes Valley | $1180 | ops | Devin Whitlock | band_200_2000_team_lead | seed_d0ebfad2… | pending |
| 99ec4222… | Apple Union Square | $240 | ops | Devin Whitlock | band_200_2000_team_lead | seed_b6be5603… | pending |

## Not re-run (per instructions)

`npm test` (72 passing), `npx tsc --noEmit` (clean), `npm run build` (clean)
were already verified before this task and were not re-run.

## Bottom line

**BLOCKED, not FAILED-and-fixed, not silently passed.** The code that
implements invariants 1–6 reads correctly (traced `spend.ts`,
`policy-router.ts`, `approvals.ts`, `schema.ts` line by line) and is covered
by unit tests, but **the live integration path has not been exercised even
once in this database**, and I could not exercise it either — the OpenAI
project backing `OPENAI_API_KEY` has run out of credit balance
(`insufficient_quota` / `credit_balance_exhausted`, HTTP 429, confirmed
directly against `api.openai.com`, independent of Signet's code). This is
the single highest-priority action item before 17:30: **add credits to the
OpenAI project**, then re-run this exact verification — Steps 4 and 5 above
are ready to go the moment the model call succeeds, and the SQL queries in
this file are ready to point at whatever `eventId` comes back.

Secondary, lower-priority finding: a live plan run today (`6f55a056…`) came
in 14% over budget, matching a comment already in `plan.ts` acknowledging
gpt-4.1 does this. Worth a defensive check if time allows, not a blocker.
