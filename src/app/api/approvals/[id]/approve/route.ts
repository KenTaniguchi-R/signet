import { NextResponse } from 'next/server';

import { getActor } from '@/lib/actor';
import { recordDecision } from '@/lib/approvals';
import { auth0 } from '@/lib/auth0';

import { clientIp } from '../ip';

/**
 * The approval gate.
 *
 * Note what this handler does NOT do: read a body. There is no field a caller
 * could set to name an approver. The identity comes from `getActor()`, which
 * reads the server session and the database. That is invariant 1, and it is the
 * whole security model.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { id } = await ctx.params;

  // The subject token for the RFC 8693 exchange that posts to Slack as this
  // approver. Read from the SESSION, like the identity itself — it is not a
  // field a caller could supply, and it is only ever used after the approval
  // resolves (invariant 5). Absent means no Slack post, never a failed charge.
  const session = await auth0.getSession();

  const outcome = await recordDecision({
    actor,
    approvalId: id,
    decision: 'approved',
    ip: clientIp(request),
    refreshToken: session?.tokenSet?.refreshToken ?? null,
  });

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.httpStatus });
  }
  return NextResponse.json(outcome);
}
