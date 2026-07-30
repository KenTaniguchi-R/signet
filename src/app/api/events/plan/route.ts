import { NoObjectGeneratedError } from 'ai';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { logActivity } from '@/lib/activity';
import { planEvent } from '@/lib/agent/plan';
import { resolveActor } from '@/lib/dev-actor';

/**
 * Demo beat 1. The brief goes in, the plan comes out.
 *
 * The body is validated into `PlanBrief` before it reaches the agent. Note what
 * is NOT in this schema: no orgId, no createdBy, no approver. Those come from
 * the actor, so a caller cannot plan into someone else's organization.
 */
const planRequest = z.object({
  title: z.string().min(1).max(200),
  budgetCents: z.number().int().positive().max(100_000_000),
  headcount: z.number().int().positive().max(100_000),
  notes: z.string().max(4_000).optional(),
});

export async function POST(request: Request) {
  /*
   * `resolveActor`, not `getActor`, unlike the approve and decline routes.
   *
   * Those two set `approved_by`, which IS the security model, so they must
   * refuse anything but a real session. Planning sets no authorization-bearing
   * field — it needs an org to write into and a creator to attribute — so the
   * dev fallback is acceptable here and the route stays testable before the
   * Auth0 users exist. The fallback is already gated on NODE_ENV !==
   * 'production' plus an explicit env var, so this cannot ship open.
   */
  const actor = await resolveActor();
  if (!actor) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = planRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
      { status: 400 },
    );
  }

  try {
    /*
     * Spec 9: one retry, at the route rather than inside the agent, so the
     * retry policy is visible to whoever reads the entry point. A model that
     * misses the schema twice on the same brief is not going to pass a third
     * time, so this does not loop.
     */
    let attempt: Awaited<ReturnType<typeof planEvent>>;
    try {
      attempt = await planEvent({ actor, brief: parsed.data });
    } catch (first) {
      if (!NoObjectGeneratedError.isInstance(first)) throw first;
      attempt = await planEvent({ actor, brief: parsed.data });
    }

    const { eventId, plan } = attempt;

    /*
     * The boundary, recorded. `payload` is the model's own output; everything
     * in `harnessInjected` was resolved here and could not have come from the
     * model. Same split the gate will write per line item.
     */
    await logActivity({
      eventId,
      actorUserId: actor.userId,
      kind: 'plan_generated',
      payload: plan,
      harnessInjected: {
        orgId: actor.orgId,
        createdBy: actor.userId,
        budgetCents: parsed.data.budgetCents,
        model: process.env.SIGNET_MODEL_ID ?? 'gpt-4.1',
      },
    });

    return NextResponse.json(
      { eventId, lineItems: plan.lineItems.length, summary: plan.summary },
      { status: 201 },
    );
  } catch (cause) {
    // Spec 9: a malformed plan is a 422 carrying the raw text, retried once at
    // the route rather than inside the agent, so the retry is visible here.
    if (NoObjectGeneratedError.isInstance(cause)) {
      return NextResponse.json(
        { error: 'The model returned a plan that did not match the schema.', raw: cause.text },
        { status: 422 },
      );
    }

    const message = cause instanceof Error ? cause.message : 'Planning failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
