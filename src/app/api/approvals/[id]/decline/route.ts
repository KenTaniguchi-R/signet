import { NextResponse } from 'next/server';

import { getActor } from '@/lib/actor';
import { recordDecision } from '@/lib/approvals';

import { clientIp } from '../ip';

/** Declining is the same authorization check as approving — see ../approve. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const outcome = await recordDecision({
    actor,
    approvalId: id,
    decision: 'declined',
    ip: clientIp(request),
  });

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.httpStatus });
  }
  return NextResponse.json(outcome);
}
