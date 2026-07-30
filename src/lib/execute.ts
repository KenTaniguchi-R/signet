import { eq } from 'drizzle-orm';

import { activity, db, lineItems, orgs, type LineItemStatus } from '@/db';

import { executeSpend, emitManagedSpendMeter, type Approver, type SpendResult } from './spend';

/**
 * Settles an approved line item: moves the money under the approver's identity,
 * records what happened, and bills the org for it.
 *
 * INVARIANT 1 & 2 — `approver` must come from the server session / policy table.
 * Nothing here reads an identity out of the model's arguments, and there is no
 * parameter through which a caller could pass one.
 *
 * INVARIANT 6 — the `activity` row splits what the MODEL supplied from what the
 * HARNESS resolved. That boundary is the audit trail, and it is the thing worth
 * pointing at when someone asks how a compromised model is contained.
 */
export interface SettleInput {
  lineItemId: string;
  eventId: string;
  orgId: string;
  /** Resolved by the harness from the policy table — never from the model. */
  approver: Approver;
  /** The IP of the request that RESOLVED the approval, for terms acceptance. */
  ip: string;
  /** Exactly what the model proposed, logged verbatim for the boundary log. */
  modelPayload: Record<string, unknown>;
  /** The policy rule that required this approver. */
  ruleName: string;
}

export interface SettleResult extends SpendResult {
  meterEmitted: boolean;
}

export async function settleLineItem(input: SettleInput): Promise<SettleResult> {
  const { lineItemId, eventId, orgId, approver, ip, modelPayload, ruleName } = input;

  const [item] = await db.select().from(lineItems).where(eq(lineItems.id, lineItemId)).limit(1);
  if (!item) throw new Error(`No such line item: ${lineItemId}`);
  if (item.status === 'charged') throw new Error(`Line item ${lineItemId} is already charged`);

  // The AMOUNT is read from the row, not from the model's payload. The model
  // proposed this number once, at planning time, and a human approved that
  // specific number — re-reading it here means a second model call cannot
  // quietly inflate an already-approved purchase.
  const result = await executeSpend({
    approver,
    amountCents: item.amountCents,
    vendor: item.vendor,
    category: item.category,
    lineItemId,
    ip,
  });

  await db
    .update(lineItems)
    .set({
      status: 'charged' satisfies LineItemStatus,
      stripeCardholderId: result.cardholderId,
      stripeCardId: result.cardId,
      spendRail: result.rail,
      chargeRef: result.chargeRef,
      simulated: result.simulated,
    })
    .where(eq(lineItems.id, lineItemId));

  await db.insert(activity).values({
    eventId,
    actorUserId: approver.userId,
    kind: 'spend_executed',
    // What the model asked for.
    payloadJson: modelPayload,
    // What we resolved on its behalf. The model could not have written any of this.
    harnessInjectedJson: {
      approverUserId: approver.userId,
      approverName: approver.displayName,
      ruleName,
      amountCents: item.amountCents,
      rail: result.rail,
      simulated: result.simulated,
      cardholderId: result.cardholderId,
      cardId: result.cardId,
      chargeRef: result.chargeRef,
    },
  });

  // Money in. Emitted AFTER the spend succeeds so we never bill for a purchase
  // that did not happen.
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
  let meterEmitted = false;
  if (org?.stripeCustomerId) {
    const meter = await emitManagedSpendMeter({
      stripeCustomerId: org.stripeCustomerId,
      amountCents: item.amountCents,
      lineItemId,
    });
    meterEmitted = meter.emitted;
  }

  return { ...result, meterEmitted };
}

/**
 * Settles many line items IN SEQUENCE.
 *
 * Deliberately not `Promise.all`. Every line item in an event shares one Stripe
 * customer and one meter, and concurrent meter events on that pair return 409.
 * The sequential loop is the fix, so callers must not "optimize" this.
 */
export async function settleLineItems(inputs: SettleInput[]): Promise<SettleResult[]> {
  const results: SettleResult[] = [];
  for (const input of inputs) {
    results.push(await settleLineItem(input));
  }
  return results;
}
