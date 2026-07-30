import { NextResponse } from 'next/server';

import { getActor } from '@/lib/actor';
import { recordDecision } from '@/lib/approvals';

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
  const outcome = await recordDecision({
    actor,
    approvalId: id,
    decision: 'approved',
    ip: clientIp(request),
  });

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.httpStatus });
  }
  return NextResponse.json(outcome);
}
