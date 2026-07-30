import { and, eq } from 'drizzle-orm';

import { activity, approvals, db, events, lineItems, orgs, users, type Role } from '@/db';

import type { Actor } from './actor';
import { emitManagedSpendMeter, executeSpend, type SpendResult } from './spend';

export type Decision = 'approved' | 'declined';

export type DecisionOutcome =
  | { ok: false; httpStatus: 403 | 404 | 409; error: string }
  | { ok: true; state: 'declined' }
  | {
      ok: true;
      state: 'awaiting_co_approver';
      remaining: { role: Role; displayName: string | null }[];
    }
  | { ok: true; state: 'charged'; spend: SpendResult; metered: boolean };

/**
 * Records an approval decision and, once every required approver has signed,
 * executes the spend under that approver's identity.
 *
 * INVARIANT 1 — `approvedBy` comes from `actor`, which the caller resolved from
 * the server session. The request body is never consulted for identity. The
 * route handler does not even parse one.
 *
 * INVARIANT 3 — this, not the AI SDK's client-side approval flow, is the
 * authorization boundary. The SDK gives us the pause; the right to resume is
 * decided here against `required_approver_id`, which the policy router wrote.
 *
 * INVARIANT 6 — every write records what the client supplied (`payload_json`)
 * separately from what the harness resolved (`harness_injected_json`).
 */
export async function recordDecision(opts: {
  actor: Actor;
  approvalId: string;
  decision: Decision;
  ip: string;
}): Promise<DecisionOutcome> {
  const { actor, approvalId, decision, ip } = opts;

  const [row] = await db
    .select({ approval: approvals, lineItem: lineItems, event: events, org: orgs })
    .from(approvals)
    .innerJoin(lineItems, eq(lineItems.id, approvals.lineItemId))
    .innerJoin(events, eq(events.id, lineItems.eventId))
    .innerJoin(orgs, eq(orgs.id, events.orgId))
    .where(eq(approvals.id, approvalId))
    .limit(1);

  // Same response for "does not exist" and "belongs to another org", so the
  // endpoint cannot be used to probe for approval ids.
  if (!row || row.org.id !== actor.orgId) {
    return { ok: false, httpStatus: 404, error: 'No such approval' };
  }

  const isNamedApprover = row.approval.requiredApproverId === actor.userId;
  const matchesRequiredRole =
    row.approval.requiredApproverId === null && row.approval.requiredRole === actor.role;
  if (!isNamedApprover && !matchesRequiredRole) {
    return {
      ok: false,
      httpStatus: 403,
      error: `This approval is routed to ${row.approval.requiredRole}, not to you`,
    };
  }

  // Conditional update is the concurrency guard: a double-clicked button or two
  // open tabs resolve the row once, and the loser gets a 409 rather than a
  // second charge.
  const updated = await db
    .update(approvals)
    .set({ status: decision, approvedBy: actor.userId, approvedAt: new Date() })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, 'pending')))
    .returning({ id: approvals.id });

  if (updated.length === 0) {
    return { ok: false, httpStatus: 409, error: 'This approval was already resolved' };
  }

  await db.insert(activity).values({
    eventId: row.event.id,
    actorUserId: actor.userId,
    kind: `approval.${decision}`,
    payloadJson: { approvalId, decision },
    harnessInjectedJson: {
      source: 'server_session',
      approvedBy: actor.userId,
      approvedByName: actor.displayName,
      requiredRole: row.approval.requiredRole,
      requiredApproverId: row.approval.requiredApproverId,
      ruleName: row.approval.ruleName,
    },
  });

  if (decision === 'declined') {
    await db
      .update(lineItems)
      .set({ status: 'declined' })
      .where(eq(lineItems.id, row.lineItem.id));
    return { ok: true, state: 'declined' };
  }

  // Every required approver must have signed. The venue line draws finance AND
  // legal; one signature is not authority to spend.
  const siblings = await db
    .select({
      status: approvals.status,
      role: approvals.requiredRole,
      displayName: users.displayName,
    })
    .from(approvals)
    .leftJoin(users, eq(users.id, approvals.requiredApproverId))
    .where(eq(approvals.lineItemId, row.lineItem.id));

  const stillPending = siblings.filter((s) => s.status === 'pending');
  if (stillPending.length > 0) {
    return {
      ok: true,
      state: 'awaiting_co_approver',
      remaining: stillPending.map((s) => ({ role: s.role, displayName: s.displayName })),
    };
  }

  // The identity on the money is the person who completed the approval — never
  // a value the model or the client supplied.
  const spend = await executeSpend({
    approver: { userId: actor.userId, email: actor.email, displayName: actor.displayName },
    amountCents: row.lineItem.amountCents,
    vendor: row.lineItem.vendor,
    category: row.lineItem.category,
    lineItemId: row.lineItem.id,
    ip,
  });

  // Sequential, never Promise.all — all twelve line items share one customer and
  // one meter, and concurrent events on that pair return 409.
  let metered = false;
  if (row.org.stripeCustomerId) {
    const result = await emitManagedSpendMeter({
      stripeCustomerId: row.org.stripeCustomerId,
      amountCents: row.lineItem.amountCents,
      lineItemId: row.lineItem.id,
    });
    metered = result.emitted;
  }

  await db
    .update(lineItems)
    .set({
      status: 'charged',
      stripeCardholderId: spend.cardholderId,
      stripeCardId: spend.cardId,
      // Which rail actually moved the money, and the card face to render. On
      // this Stripe account the card is a stand-in (`simulated_card`); the
      // cardholder and the PaymentIntent behind it are real.
      spendRail: spend.rail,
      chargeRef: spend.chargeRef,
      cardLast4: spend.last4,
      cardExp: spend.exp,
      simulated: spend.simulated,
    })
    .where(eq(lineItems.id, row.lineItem.id));

  await db.insert(activity).values({
    eventId: row.event.id,
    actorUserId: actor.userId,
    kind: 'spend.executed',
    payloadJson: {
      vendor: row.lineItem.vendor,
      category: row.lineItem.category,
      amountCents: row.lineItem.amountCents,
    },
    harnessInjectedJson: {
      rail: spend.rail,
      simulated: spend.simulated,
      cardholderId: spend.cardholderId,
      cardholderName: spend.cardholderName,
      cardId: spend.cardId,
      cardLast4: spend.last4,
      chargeRef: spend.chargeRef,
      approverUserId: actor.userId,
      metered,
    },
  });

  return { ok: true, state: 'charged', spend, metered };
}
