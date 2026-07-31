/**
 * Demo seed.
 *
 *   npm run db:seed              org + the three approvers (idempotent)
 *   npm run db:seed -- --with-plan   also writes a finished 12-item plan
 *   npm run db:seed -- --reset       wipe this org's rows first
 *
 * By default this seeds ONLY what the running app cannot create for itself:
 * the org and one user per role. The event and its line items are written by
 * the agent's plan phase, so seeding them would collide with a live run.
 * `--with-plan` exists for the backup video and for working on /inbox before
 * the agent lands.
 *
 * Re-runnable. Once the Auth0 users exist, set SEED_*_SUB and run it again to
 * attach the real subs to the rows already there.
 */
import { neon } from '@neondatabase/serverless';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';

import * as schema from './schema.ts';
import { activity, approvals, events, lineItems, orgs, users, type Role } from './schema.ts';
import { resolvePolicy } from '../lib/policy.ts';

// Its own client rather than src/db/index.ts: that module is written for the
// bundler and imports extensionless, which node cannot resolve. A one-shot
// script also belongs on the direct connection, same as migrations.
const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL_UNPOOLED (or DATABASE_URL) is not set — see .env.example');
}
const db = drizzle(neon(connectionString), { schema });

const withPlan = process.argv.includes('--with-plan');
const reset = process.argv.includes('--reset');

const auth0OrgId = process.env.AUTH0_ORG_ID;
if (!auth0OrgId) {
  throw new Error('AUTH0_ORG_ID is not set — see .env.local');
}

const ORG_NAME = 'Northbeam Collective';

/**
 * Emails MUST match the Auth0 users, because that is what the dev getViewer()
 * and the eventual callback match on. Override per-role if the tenant differs.
 */
const PEOPLE: { role: Role; displayName: string; email: string; subEnv: string }[] = [
  {
    role: 'finance',
    // The finance approver fires the Token Vault action, so this row must be a
    // real person with a real Slack account — otherwise the inbox shows one
    // name and the Slack message another, and that seam is visible on stage.
    displayName: process.env.SEED_FINANCE_NAME ?? 'Ken Taniguchi',
    email: process.env.SEED_FINANCE_EMAIL ?? 'ken.taniguchi@northbeam.dev',
    subEnv: 'SEED_FINANCE_SUB',
  },
  {
    role: 'legal',
    displayName: process.env.SEED_LEGAL_NAME ?? 'Amara Okonkwo',
    email: process.env.SEED_LEGAL_EMAIL ?? 'amara.okonkwo@northbeam.dev',
    subEnv: 'SEED_LEGAL_SUB',
  },
  {
    role: 'ops',
    displayName: process.env.SEED_OPS_NAME ?? 'Devin Whitlock',
    email: process.env.SEED_OPS_EMAIL ?? 'devin.whitlock@northbeam.dev',
    subEnv: 'SEED_OPS_SUB',
  },
];

/**
 * The demo plan. Categories are the `lineItemIntent` enum, so these rows are
 * indistinguishable from ones the agent would have produced.
 *
 * Shaped to the spec's definition of done: 12 items at or under $5,000, of
 * which exactly 3 halt — venue, catering and prizes — producing 3 approval
 * rows, one per halted item.
 *
 * All three route to finance. That is the demo configuration in `policy.ts`,
 * not a property of this plan: the presenter runs from a single finance
 * session, so a line routed to ops or legal would be unclearable on stage.
 * Devin and Amara are still seeded, and their inboxes are empty by design.
 */
const PLAN: { category: string; vendor: string; amountCents: number; reversible: boolean }[] = [
  { category: 'venue',    vendor: 'Okta Facilities',      amountCents: 280_000, reversible: false },
  { category: 'catering', vendor: 'Souvla Hayes Valley',  amountCents: 118_000, reversible: true },
  { category: 'prizes',   vendor: 'Apple Union Square',   amountCents:  24_000, reversible: true },
  { category: 'av',       vendor: 'Adolph Gasser',        amountCents:  14_800, reversible: true },
  { category: 'catering', vendor: 'Souvla Hayes Valley',  amountCents:  13_200, reversible: true },
  { category: 'supplies', vendor: 'Alphagraphics SoMa',   amountCents:  12_800, reversible: true },
  { category: 'drinks',   vendor: 'Costco Business',      amountCents:   9_600, reversible: true },
  { category: 'av',       vendor: 'Central Computer',     amountCents:   7_400, reversible: true },
  { category: 'supplies', vendor: 'Cole Hardware',        amountCents:   6_300, reversible: true },
  { category: 'catering', vendor: 'Souvla Hayes Valley',  amountCents:   5_700, reversible: true },
  { category: 'supplies', vendor: 'Blick Art Materials',  amountCents:   4_100, reversible: true },
  { category: 'av',       vendor: 'Central Computer',     amountCents:   3_800, reversible: true },
];

const EVENT_TITLE = 'Built Different: Auth0 x Stripe, Okta HQ SF';
const EVENT_BUDGET_CENTS = 500_000;

async function main() {
  if (reset) {
    const [existing] = await db.select().from(orgs).where(eq(orgs.auth0OrgId, auth0OrgId!)).limit(1);
    if (existing) {
      const orgEvents = await db.select({ id: events.id }).from(events).where(eq(events.orgId, existing.id));
      for (const ev of orgEvents) {
        const items = await db.select({ id: lineItems.id }).from(lineItems).where(eq(lineItems.eventId, ev.id));
        for (const item of items) {
          await db.delete(approvals).where(eq(approvals.lineItemId, item.id));
        }
        await db.delete(activity).where(eq(activity.eventId, ev.id));
        await db.delete(lineItems).where(eq(lineItems.eventId, ev.id));
      }
      await db.delete(events).where(eq(events.orgId, existing.id));
      await db.delete(users).where(eq(users.orgId, existing.id));
      await db.delete(orgs).where(eq(orgs.id, existing.id));
      console.log(`reset   removed org ${existing.id} and everything under it`);
    }
  }

  // --- org -----------------------------------------------------------------
  const [found] = await db.select().from(orgs).where(eq(orgs.auth0OrgId, auth0OrgId!)).limit(1);
  const org =
    found ??
    (
      await db
        .insert(orgs)
        .values({
          auth0OrgId: auth0OrgId!,
          stripeCustomerId: process.env.STRIPE_DEMO_CUSTOMER_ID ?? null,
        })
        .returning()
    )[0];

  if (!found && !org.stripeCustomerId) {
    console.warn('warn    STRIPE_DEMO_CUSTOMER_ID unset — the meter has no customer to bill');
  }
  console.log(`${found ? 'reuse ' : 'insert'}  org   ${ORG_NAME}  ${org.id}`);

  // --- users ---------------------------------------------------------------
  const seeded: Record<string, string> = {};

  for (const person of PEOPLE) {
    const auth0Sub = process.env[person.subEnv] ?? `pending|${person.email}`;

    const [existing] = await db
      .select()
      .from(users)
      .where(and(eq(users.orgId, org.id), eq(users.email, person.email)))
      .limit(1);

    if (existing) {
      // Re-running with real subs is how a placeholder becomes a real user.
      await db
        .update(users)
        .set({ auth0Sub, role: person.role, displayName: person.displayName })
        .where(eq(users.id, existing.id));
      seeded[person.role] = existing.id;
      console.log(`update  user  ${person.displayName.padEnd(16)} ${person.role.padEnd(8)} ${auth0Sub}`);
    } else {
      const [row] = await db
        .insert(users)
        .values({
          auth0Sub,
          orgId: org.id,
          email: person.email,
          displayName: person.displayName,
          role: person.role,
        })
        .returning();
      seeded[person.role] = row.id;
      console.log(`insert  user  ${person.displayName.padEnd(16)} ${person.role.padEnd(8)} ${auth0Sub}`);
    }
  }

  // --- optional plan -------------------------------------------------------
  if (withPlan) {
    const [event] = await db
      .insert(events)
      .values({
        orgId: org.id,
        title: EVENT_TITLE,
        budgetCents: EVENT_BUDGET_CENTS,
        status: 'planning',
        createdBy: seeded.ops,
      })
      .returning();

    let halted = 0;
    let approvalRows = 0;

    for (const item of PLAN) {
      // Status is DERIVED from the policy router, never hardcoded, so seeded
      // data cannot drift away from the rules the app enforces.
      const decision = resolvePolicy({
        amountCents: item.amountCents,
        reversible: item.reversible,
      });

      const [row] = await db
        .insert(lineItems)
        .values({
          eventId: event.id,
          category: item.category,
          vendor: item.vendor,
          amountCents: item.amountCents,
          reversible: item.reversible,
          status: decision.requiresApproval ? 'awaiting_approval' : 'auto_approved',
        })
        .returning();

      if (!decision.requiresApproval) continue;
      halted += 1;

      for (const role of decision.approverRoles) {
        await db.insert(approvals).values({
          lineItemId: row.id,
          approvalId: `seed_${row.id}`,
          requiredRole: role,
          requiredApproverId: seeded[role] ?? null,
          ruleName: decision.ruleName,
          status: 'pending',
        });
        approvalRows += 1;
      }
    }

    const total = PLAN.reduce((sum, i) => sum + i.amountCents, 0);
    console.log(`insert  event ${EVENT_TITLE}  ${event.id}`);
    console.log(
      `insert  plan  ${PLAN.length} items, $${(total / 100).toFixed(2)} of ` +
        `$${(EVENT_BUDGET_CENTS / 100).toFixed(2)} · ${halted} halted · ${approvalRows} approval rows`,
    );
  }

  console.log('\ndone. set SIGNET_DEV_VIEWER_EMAIL to one of the emails above to pick a viewer.');
}

await main();
