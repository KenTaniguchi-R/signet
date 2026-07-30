import Stripe from 'stripe';

import type { SpendRail } from '../db/schema.ts';

import { stripe } from './stripe.ts';

/**
 * Money out, executed under the approver's identity.
 *
 * INVARIANT 2 — every function here takes the approver as a resolved `Approver`
 * object supplied by the harness, never an id the model could have written.
 * There is no code path that turns a model-authored string into a cardholder.
 *
 * Two rails, tried in order:
 *
 *  1. `issuing_card`  — a real Stripe Issuing virtual card in the approver's
 *     name, with a spending limit Stripe itself enforces. This is the product.
 *  2. `payment_intent` — the fallback. The Issuing cardholder is still created
 *     and is still a real Stripe object bearing the approver's name; only the
 *     card is missing, so the charge rides a PaymentIntent that carries the
 *     approver in metadata.
 *
 * The fallback exists because Issuing card creation is blocked on this account:
 * `issuing.cards.create` requires an OPEN `financial_account_v2`, and this
 * account's Financial Account cannot leave `pending` — no currency is enabled
 * for Financial Accounts on it (`POST /v2/money_management/financial_addresses`
 * → `unsupported_currency` for both usd and gbp). That needs Stripe-side
 * enablement; it is not a code defect and not fixable from the dashboard.
 * `selectRail` probes rather than assumes, so the day the account is enabled
 * this file starts issuing real cards with no edit.
 */

export type { SpendRail };

/** The approver, as resolved by the harness from the policy table. */
export interface Approver {
  userId: string;
  email: string;
  displayName: string;
}

export interface SpendRequest {
  approver: Approver;
  amountCents: number;
  vendor: string;
  category: string;
  /** Used to make the meter event idempotent across retries. */
  lineItemId: string;
  /** Recorded on the cardholder's terms acceptance. Take from the approval request. */
  ip: string;
}

export interface SpendResult {
  rail: SpendRail;
  /** Always set — the cardholder is real on both rails. */
  cardholderId: string;
  cardholderName: string;
  cardId: string | null;
  last4: string | null;
  /** `ic_…` on the card rail, `pi_…` on the fallback. */
  chargeRef: string;
  /** True when the charge is a PaymentIntent standing in for a card swipe. */
  simulated: boolean;
}

/**
 * Cardholders now REQUIRE a phone number (`cardholder_phone_number_required`) —
 * Stripe uses it for 3D Secure on virtual cards. Real approvers would supply
 * their own; the demo users have none, so they share this test number.
 */
const DEMO_PHONE_NUMBER = '+15555550123';

/** The demo organization's address. Cardholders require a billing address. */
const DEMO_BILLING_ADDRESS = {
  line1: '1 Market St',
  city: 'San Francisco',
  state: 'CA',
  postal_code: '94105',
  country: 'US',
} as const;

function splitName(displayName: string): { first: string; last: string } {
  const parts = displayName.trim().split(/\s+/);
  // Stripe rejects a cardholder with an empty last name, so never leave it blank.
  return { first: parts[0] ?? 'Unknown', last: parts.slice(1).join(' ') || parts[0] || 'Approver' };
}

/**
 * Creates, or reuses, a real Stripe Issuing cardholder for the approver.
 *
 * The terms-acceptance date and IP must be supplied AT CREATION or the
 * cardholder lands in `requirements.past_due` and can never back an active
 * card. First and last name are required for the same reason.
 */
export async function ensureCardholder(approver: Approver, ip: string): Promise<Stripe.Issuing.Cardholder> {
  const existing = await stripe.issuing.cardholders.list({ email: approver.email, limit: 1 });
  if (existing.data.length > 0) {
    const found = existing.data[0];
    // `cardholders.create` happily accepts a missing phone number, but
    // `cards.create` then refuses the cardholder outright — Stripe needs it for
    // 3D Secure. Backfill rather than hand back a cardholder that cannot hold a
    // card, or the failure surfaces one call later pointing at the wrong object.
    if (!found.phone_number) {
      return stripe.issuing.cardholders.update(found.id, { phone_number: DEMO_PHONE_NUMBER });
    }
    return found;
  }

  const { first, last } = splitName(approver.displayName);

  return stripe.issuing.cardholders.create({
    type: 'individual',
    name: approver.displayName,
    email: approver.email,
    phone_number: DEMO_PHONE_NUMBER,
    // Required by Stripe. In a real deployment this is the approver's address on
    // file; for the demo org every approver shares the company address.
    billing: { address: DEMO_BILLING_ADDRESS },
    individual: {
      first_name: first,
      last_name: last,
      card_issuing: {
        user_terms_acceptance: {
          date: Math.floor(Date.now() / 1000),
          ip,
        },
      },
    },
    metadata: { signet_approver_user_id: approver.userId },
  });
}

/**
 * Attempts the real card. Returns null when this account cannot issue one,
 * which is the expected outcome here until Stripe enables Financial Accounts.
 * Any other Stripe error is a genuine bug and is rethrown.
 */
async function tryIssueCard(
  cardholderId: string,
  amountCents: number,
  lineItemId: string,
): Promise<Stripe.Issuing.Card | null> {
  const financialAccount = process.env.STRIPE_FINANCIAL_ACCOUNT_ID;
  if (!financialAccount) return null;

  try {
    return await stripe.issuing.cards.create({
      cardholder: cardholderId,
      currency: 'usd',
      type: 'virtual',
      // Cards default to `inactive`; an inactive card declines every authorization.
      status: 'active',
      // Stripe enforces this limit itself. The harness does not police the amount
      // after the fact — the card physically cannot spend more than was approved.
      spending_controls: {
        spending_limits: [{ amount: amountCents, interval: 'all_time' }],
      },
      metadata: { signet_line_item_id: lineItemId },
      // `financial_account_v2` — NOT the old Treasury `financial_account`.
      ...({ financial_account_v2: financialAccount } as Record<string, string>),
    });
  } catch (err) {
    const stripeErr = err as Stripe.errors.StripeError;
    const message = stripeErr?.message ?? '';
    if (/status is pending|financial account/i.test(message)) return null;
    throw err;
  }
}

/**
 * Executes the spend under the approver's identity and returns what actually
 * happened. Callers must persist `rail` and `simulated` — the demo states the
 * limitation out loud rather than hiding it.
 */
export async function executeSpend(req: SpendRequest): Promise<SpendResult> {
  const { approver, amountCents, vendor, category, lineItemId, ip } = req;

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new RangeError(`amountCents must be a positive integer, received ${amountCents}`);
  }

  const cardholder = await ensureCardholder(approver, ip);
  const card = await tryIssueCard(cardholder.id, amountCents, lineItemId);

  if (card) {
    return {
      rail: 'issuing_card',
      cardholderId: cardholder.id,
      cardholderName: cardholder.name,
      cardId: card.id,
      last4: card.last4,
      chargeRef: card.id,
      simulated: false,
    };
  }

  // Fallback rail. The approver still owns this charge: their cardholder id,
  // their user id and their name are on the PaymentIntent, so the audit trail
  // still resolves to a real human.
  const intent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    payment_method_types: ['card'],
    description: `${category} — ${vendor}`,
    metadata: {
      signet_line_item_id: lineItemId,
      signet_approver_user_id: approver.userId,
      signet_approver_name: approver.displayName,
      signet_cardholder_id: cardholder.id,
      signet_rail: 'payment_intent_fallback',
    },
  });

  return {
    rail: 'payment_intent',
    cardholderId: cardholder.id,
    cardholderName: cardholder.name,
    cardId: null,
    last4: null,
    chargeRef: intent.id,
    simulated: true,
  };
}

/**
 * Money in. Emits one `signet_managed_spend` meter event — our revenue.
 *
 * The meter's value is the line item amount IN CENTS and the metered price is
 * `unit_amount_decimal: "0.01"`, so the org is billed exactly 1% of managed
 * spend. A $2,800 line bills $28.
 *
 * MUST be called sequentially. All twelve line items share one customer and one
 * meter, and concurrent events on the same pair return 409 — never `Promise.all`
 * over this function.
 */
export async function emitManagedSpendMeter(args: {
  stripeCustomerId: string;
  amountCents: number;
  lineItemId: string;
}): Promise<{ emitted: boolean }> {
  const { stripeCustomerId, amountCents, lineItemId } = args;

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new RangeError(`amountCents must be a positive integer, received ${amountCents}`);
  }

  try {
    await stripe.billing.meterEvents.create({
      event_name: process.env.STRIPE_METER_EVENT_NAME ?? 'signet_managed_spend',
      // Every payload value must be a STRING, and the value a positive integer.
      payload: {
        stripe_customer_id: stripeCustomerId,
        value: String(amountCents),
      },
      // Makes a retry safe: the same line item can never bill twice.
      identifier: `signet_line_${lineItemId}`,
    });
    return { emitted: true };
  } catch (err) {
    const stripeErr = err as Stripe.errors.StripeError;
    // A hard error, not a silent no-op — but on a retry path it means this line
    // item was already billed, which is success, not failure.
    //
    // Match the MESSAGE, not the code: this particular error arrives with
    // `code: undefined`, so a `code === 'duplicate_meter_event'` check silently
    // never fires and the whole run dies on the first replay.
    if (
      stripeErr?.code === 'duplicate_meter_event' ||
      /event already exists with identifier/i.test(stripeErr?.message ?? '')
    ) {
      return { emitted: false };
    }
    throw err;
  }
}
