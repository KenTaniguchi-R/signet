# Signet

An AI agent plans a project's spend, routes each line item to whoever holds
authority over it, and executes the purchase **under that approver's identity** —
a virtual card issued in their name, a Slack message posted as them, an audit log
that resolves to a real human.

Built for **Built Different: Auth0 × Stripe** (Okta HQ SF, July 2026). Solo build,
one afternoon.

---

## The problem

An agent that can spend money is only as trustworthy as its authorization story.
The usual answer is a service account: the agent holds one powerful credential and
every purchase looks the same in the audit log — *the bot did it*. That is fine
until someone asks who approved the $4,000 one.

Signet's answer is that the agent never holds authority at all. It proposes; the
harness decides who must sign; a real human signs; and the money then moves under
**that human's** identity, not the agent's.

## How it works

```
Agent (Vercel AI SDK v7)
  streamObject + Zod  → line items (planning as constraint satisfaction)
  toolApproval        → gated spend tool; the model emits intent only
        ↓
Harness (our code — owns every decision)
  policy table   → which approver is required
  approvals row  → wait for a real human
  RFC 8693       → exchange for a token that acts AS that approver
  Stripe Issuing → virtual card in their name
  Stripe Billing → meter event, our revenue
```

Two Stripe products, one per direction of money. **Issuing** moves money out,
with the approver as the cardholder. **Billing** meters `signet_managed_spend` and
moves money in. That split is the answer to "how did you use Stripe?"

## The invariants

These are the product, not implementation details.

1. **`approved_by` comes from the server session. Never from the request body.**
   This one line is the entire security model.

2. **The model cannot express an identity.** The gated tool's Zod schema has no
   `approverId`, no `orgId`, no token field. The approver is resolved by the
   harness from the policy table. A fully compromised model still cannot
   impersonate anyone — there is no field to do it in.

3. **The AI SDK's client-side approval flow is not the authorization mechanism.**
   Its own docs warn that a crafted client response can bypass the gate. We use
   `toolApproval` for the *pause*, and gate the *resume* behind our `approvals`
   row, whose `required_approver_id` came from the policy table.

4. **Roles come from the database, not the session.** Custom claims vanish after a
   token refresh ([nextjs-auth0#2629](https://github.com/auth0/nextjs-auth0/issues/2629)).
   Render the claim if you like; never authorize on it.

5. **Third-party tokens are fetched after approval resolves, never before.** An
   approval can sit for minutes; a token fetched at proposal time is expired at
   execution. No caching at any layer.

6. **Log the boundary.** The `activity` table splits `payload_json` (what the model
   supplied) from `harness_injected_json` (what we resolved). The UI renders both
   side by side, so you can see exactly where the agent stopped and the harness
   took over.

## The policy router

A pure function — `resolvePolicy({ amountCents, reversible })` → which *roles* must
sign. It never resolves a role to a person; that mapping lives in the `users` table
and is done by the harness. This is the piece worth unit-testing, and it's what
makes invariant 2 structural rather than aspirational.

| Condition | Approvers | Rule |
|---|---|---|
| > $2,000 | finance + legal | `over_2000_finance_legal` |
| $200–$2,000, reversible | ops | `band_200_2000_team_lead` |
| $200–$2,000, irreversible | ops + legal | `irreversible_band_200_2000` |
| < $200, irreversible | legal | `irreversible_requires_legal` |
| < $200, reversible | — auto | `auto_approve_under_200` |

Irreversibility always pulls legal in, whatever it costs.

## Stack

| Layer | Choice |
|---|---|
| App | Next.js 16 App Router, React 19, Tailwind v4 |
| DB | Neon Postgres via Drizzle, provisioned through Stripe Projects |
| Auth | Auth0 Organizations, org-scoped RBAC, Token Vault, Connected Accounts |
| Agent | Vercel AI SDK v7 |
| Money **out** | Stripe **Issuing** — the cardholder *is* the approver |
| Money **in** | Stripe **Billing** meters (`signet_managed_spend`) |

Both the identity provider and the database were provisioned through the Stripe
CLI's `projects` plugin — two providers, one CLI.

## Running it

```bash
npm install
cp .env.example .env.local     # fill in Auth0, Stripe, Neon, OpenAI
npm run db:push                # apply the Drizzle schema
npm run db:seed                # three users, one per role
npm run dev                    # localhost:3000
npm test                       # policy router + harness unit tests
```

You'll need an Auth0 tenant with Organizations enabled, a Stripe account in test
mode with a Billing meter named `signet_managed_spend`, and a Neon Postgres
database. `.env.example` lists every variable with a comment on where it comes from.

## Known limitations

Stated honestly, because pretending otherwise is worse than the limitation.

- **Issuing purchases are simulated.** The card, its spending controls, and
  Stripe's enforcement of them are real; the swipe is a test-helpers call. On the
  sandbox this project was built against, USD was never enabled for Financial
  Accounts, so `issuing.cards.create` could not open a card at all — the spend
  path falls back to PaymentIntents and records the rail it actually used on the
  card face. Production needs a funded Issuing balance and real underwriting.
- **Not deployed.** Demoed from a laptop on localhost. Neon means deploying is no
  longer a blocker, but it wasn't the point.
- **One real Slack account.** Only the approver firing the Token Vault action needs
  one; the other two users are Auth0-only. If the exchanged token comes back as a
  bot token rather than a user token, the UI claims only what the token actually
  supports rather than overstating it.
- **Approval durability.** The run is stateless between the two agent calls, and
  the pending approval survives in the database — but if the process dies
  mid-flight the message history doesn't. The production answer is `WorkflowAgent`
  from `@ai-sdk/workflow`.

## Layout

```
src/lib/policy.ts          the pure policy router
src/lib/policy-router.ts   role → person, the harness-only lookup
src/lib/approvals.ts       the approval gate
src/lib/auth0-exchange.ts  RFC 8693 token exchange (~20 lines of fetch)
src/lib/spend.ts           card issuance + meter emission
src/lib/activity.ts        the model/harness boundary log
src/app/api/               plan, approve/decline, spend route handlers
docs/                      design specs and verification notes
```

## License

MIT
