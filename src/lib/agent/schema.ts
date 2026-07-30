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
  lineItemId: z.uuid(),
});

export type SpendInput = z.infer<typeof spendInput>;
