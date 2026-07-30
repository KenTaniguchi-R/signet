<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Signet

## What this is

Hackathon project for **Built Different: Auth0 × Stripe** (Okta HQ SF, 2026-07-30). Build window **13:00–17:30**, demo 17:30. Solo build.

**Signet:** an AI agent plans a project's spend, routes each line item to whoever holds authority over it, and executes the purchase **under that approver's identity** — a virtual card issued in their name, a Slack message posted as them, an audit log that resolves to a real human.

Event brief: *"a monetized, multi-user SaaS app from scratch using Stripe and Auth0."* All three words are graded.

**The full spec lives in the Obsidian vault, not in this repo:**
- `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/projects/signet/README.md` — spec, demo script, build order, cut lines
- `.../projects/signet/build-notes.md` — gotchas, verified reference code, dashboard setup

Read both before making architectural decisions. They contain research that is expensive to re-derive and several corrections to things that look obvious.

---

## Architecture

Local-only. No deploy target — the demo runs on localhost from the presenter's laptop.

```
Agent (Vercel AI SDK v7)
  streamObject + Zod  → 12 line items (planning = constraint satisfaction)
  toolApproval        → gated spend tool; the model emits intent only
        ↓
Harness (our code — owns every decision)
  policy table   → which approver is required
  approvals row  → wait for a real human
  RFC 8693       → exchange for a token that acts AS that approver
  Stripe Issuing → virtual card in their name
  Stripe Billing → meter event, our revenue
```

| Layer | Choice |
|---|---|
| App | Next.js 16 App Router, React 19, Tailwind v4 |
| DB | **Neon Postgres** via Drizzle, provisioned through Stripe Projects |
| Auth | Auth0 Organizations, org-scoped RBAC, Token Vault, Connected Accounts |
| Agent | Vercel AI SDK v7 |
| Money **out** | Stripe **Issuing** — cardholder *is* the approver |
| Money **in** | Stripe **Billing** meters (`signet_managed_spend`) |

Two Stripe products, one per direction. That is deliberate and it is the answer to "how did you use Stripe?"

### Database — decided, do not re-litigate mid-build

**Neon Postgres. One engine, one driver, one dialect.** SQLite was considered pre-event and cut.

```bash
stripe projects add neon/free -p signet       # parent plan — FREE
stripe projects add neon/postgres -p signet   # the database (deployable)
stripe projects env -p signet                 # DATABASE_URL lands here
```

⚠️ **`neon/free`, never `neon/launch`** — Launch is paid, usage-based compute and storage. Same trap as `auth0/b2b-professional`.

**Why:** provisioning *both* the identity provider and the database through Stripe Projects makes Projects a real part of the submission. The event copy leads with *"how developers and agents can provision and manage services, including Auth0, from the Stripe CLI."* Two providers, one CLI. Postgres also means no native modules, so the edge-runtime / middleware import-graph problem class doesn't exist.

**If `ACCOUNT_NOT_ELIGIBLE`:** sign up at neon.tech and paste the connection string. Two minutes, **zero code difference** — you lose the Projects anecdote, not the build. **Do not reintroduce SQLite.**

⚠️ **Neon free tier scales to zero.** Compute suspends when idle and cold-starts on the next query. **Warm the DB immediately before presenting** — a multi-second pause at demo beat 2 reads as "broken" to the room.

---

## Version pins — settle these before writing feature code

```
ai@7                 # ESM-only, provider spec v4
@ai-sdk/openai@4
@ai-sdk/react@4
```

- `stepCountIs` is **`isStepCount`** in v7 (old name still aliased)
- `toolApproval` on `generateText`/`streamText`/`ToolLoopAgent` is the v7 API. `needsApproval` on `tool()` is deprecated
- **NEVER install `@auth0/ai-vercel`.** Peers are `ai: ^5 || ^6` — it will fight v7. It is also useless here: its Token Vault helper only exchanges for the *currently logged-in* user, which breaks the entire premise. Call the RFC 8693 endpoint directly (~20 lines of `fetch`, code in build-notes §4.1)
- If `@auth0/ai-components` drags `@auth0/ai-vercel` in, **don't fight it** — hand-roll the consent link. Connected Accounts is a redirect to the connect endpoint, not a dance

---

## Invariants — do not violate these, they are the product

1. **`approved_by` comes from the server session. Never from the request body.** This one line is the entire security model.
2. **The model cannot express an identity.** The gated tool's Zod schema has no `approverId`, no `orgId`, no token field. The approver is resolved by the harness from the policy table. A fully compromised model still cannot impersonate anyone.
3. **The AI SDK's client-side approval flow is NOT the authorization mechanism.** Its own docs warn that a crafted client response can bypass the gate. Use `toolApproval` for the *pause*; gate the *resume* behind our `approvals` row, where `required_approver_id` came from the policy table.
4. **Roles come from our DB, not the session.** nextjs-auth0 [#2629](https://github.com/auth0/nextjs-auth0/issues/2629): custom claims vanish after a token refresh and `beforeSessionSaved` stops being called. A 4.5-hour session *will* refresh. Render the claim if you like; never authorize on it. `sub` and `org_id` are default-persisted and safe to read.
5. **Fetch third-party tokens *after* approval resolves, never before.** An approval can sit for minutes; a token fetched at proposal time is expired at execution and 401s with no useful message. No caching at any layer.
6. **Log the boundary.** `activity` splits `payload_json` (what the model supplied) from `harness_injected_json` (what we resolved). Demo talking point, not just hygiene.

---

## Gotchas — check here before debugging

| Symptom | Cause |
|---|---|
| Token exchange **403** | Token Vault grant type not enabled on the Auth0 Application (Advanced Settings → Grant Types) |
| Token exchange **401** | Refresh token rotation left ON in Auth0, OR the Purpose → "Connected Accounts for Token Vault" toggle never flipped, OR no user identity matches `connection` |
| Slack exchange fails | Connection name is **`sign-in-with-slack`**, not `slack` |
| Slack issues no refresh token | Slack-side token rotation must be **ON** — the *opposite* of the Auth0-side setting. Two dashboards, same words, opposite values |
| `/inbox` empty late in the session | Invariant 4 — roles read from the session instead of the DB |
| RBAC returns `[]` | nextjs-auth0 v4 filters custom claims out of `session.user` by default |
| First query after idle hangs for seconds | Neon free-tier compute scaled to zero and is cold-starting. Warm it before demoing |
| Meter event `400` | `payload` values must be **strings**, and positive integers |
| Meter event `400 duplicate_meter_event` | Hard error, not a silent no-op. ⚠️ **The error arrives with `code: undefined`** — a `code === 'duplicate_meter_event'` check never fires and the run dies on the first replay. Match the message `/event already exists with identifier/` instead. Verified 2026-07-30 |
| Meter event `409` | Concurrent events on the same customer+meter. **Emit sequentially — never `Promise.all`.** All 12 line items share one customer and one meter |
| Issuing card won't activate | Cardholder missing `individual.card_issuing.user_terms_acceptance.date` + `.ip` and first/last name → `requirements.past_due`. Card `status` also defaults to `inactive` |
| `cardholder_phone_number_required` on `cards.create` | `cardholders.create` accepts a **missing** `phone_number`, but `cards.create` then refuses that cardholder (Stripe needs it for 3D Secure). The error names the cardholder, so it reads like a cardholder bug one call too late. Always set `phone_number` at creation, and **backfill it on any cardholder you reuse from `cardholders.list`** |
| `cardholders.create` → `parameter_missing: billing` | `billing.address` (line1/city/state/postal_code/country) is required, not optional |
| `parameter_missing: The v2 financial account id must be specified` | `issuing.cards.create` now **requires `financial_account_v2`**. Use `STRIPE_FINANCIAL_ACCOUNT_ID`. The old Treasury param was `financial_account` (singular) — not the same thing. build-notes §5 trap 3 |
| `You cannot create a new card for FinancialAccount … status is pending` | **Verified dead end on this account — do not re-investigate.** USD is not enabled for Financial Accounts here (`POST /v2/money_management/financial_addresses` → `unsupported_currency: usd`), so the FA can never open and no card can be created, on any API version. Needs Stripe-side enablement. Use the PaymentIntents fallback. build-notes §5 trap 3b has the full probe table |
| Tempted to check `details_submitted` / `capabilities` / `tos_acceptance` on the account | Those are **normal to be empty in a sandbox** and are not the Issuing gate. Cost ~20 min on 2026-07-30. The only meaningful probe is the financial-addresses call above |

Use Neon's **pooled** connection string for the app (serverless-friendly); the direct one is for migrations.

---

## Commands

```bash
npm run dev                   # localhost:3000
npx drizzle-kit push          # apply schema

stripe projects status -p signet         # what's provisioned
stripe projects env -p signet            # env var names (DATABASE_URL lands here)
stripe billing meters list -p signet     # verify the meter exists before emitting
stripe listen --forward-to localhost:3000/api/webhooks/issuing -p signet   # only if the real-time auth stretch lands
```

`stripe projects add neon/postgres` writes the connection string into the project env — pull it with `stripe projects env` rather than hand-copying from the Neon dashboard.

Stripe CLI uses a **separate profile** — pass `-p signet` on every command so the real business account is untouched.

Before building on an exchanged Slack token, check what kind it is:
```bash
curl -s -H "Authorization: Bearer $TOKEN" https://slack.com/api/auth.test
# user_id and no bot_id → user token; "post as the approver" works
# bot_id present        → bot token; take the fallback beat (build-notes gotcha #10)
```

**Codex only:** prefix supported shell commands with `rtk` (e.g. `rtk git status`).

---

## Conventions

- TypeScript. No `any` in the auth or policy paths
- The policy router is a **pure function** — `resolvePolicy(lineItem) → { requiresApproval, approverRole, ruleName }`. Unit-test it. It's the only thing worth testing today and it's what judges are told is "the product, not the button"
- All DB access in route handlers and server components (Node runtime)
- Secrets in `.env.local`, never committed

---

## Known limitations — state these honestly, don't hide them

- **Not deployed** unless a host says the submission needs a URL — but Neon means deploying is no longer a blocker. Demoed from the laptop
- **Issuing purchases are simulated.** The card, its spending controls, and Stripe's enforcement of them are real; the swipe is a test-helpers call. Sandbox cards can't be used at real merchants. Production needs a funded Issuing balance and real underwriting
- **One real Slack account.** Only the approver firing the Token Vault action needs one; the other two users are Auth0-only
- **Approval durability.** The run is stateless between the two agent calls, but if the process dies mid-flight the pending approval is in the DB and the message history isn't. Production answer is `WorkflowAgent` from `@ai-sdk/workflow`
- **Not attempting** unless everything else is green: CIBA push approval, real-time Issuing authorizations, Stripe Connect via Token Vault, Google Calendar

---

## If time runs short

Cut in this order: **Product Catalog → streaming output.**

**Never cut:** two distinct identities with different inboxes · policy-based routing to the correct approver · the virtual card in the approver's name · the `signet_managed_spend` meter · the Slack post via Token Vault.

If only one thing works at 17:30, it must be: **a different person approves, and the money moves under their name.**

<!-- stripe-projects-cli managed:agents-md:start -->
## Stripe Projects CLI

This repository is initialized for the Stripe project "signet".

## Tools used

- [Stripe CLI](https://docs.stripe.com/stripe-cli) with the `projects` plugin to manage third-party services, credentials, and deployments for this project. Use the stripe-projects-cli to manage deploying and access to third party services.
<!-- stripe-projects-cli managed:agents-md:end -->
