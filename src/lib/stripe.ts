import Stripe from 'stripe';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * The product account (`acct_EXAMPLE…`, CLI profile `signet`). The Billing meter,
 * metered price, demo customer and every Issuing object live here. The second
 * Stripe account in this project is the Stripe Projects control plane and no
 * money moves through it — do not point this client at it.
 */
export const stripe = new Stripe(requireEnv('STRIPE_SECRET_KEY'));

export { requireEnv };
