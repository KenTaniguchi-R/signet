import { NextResponse } from 'next/server';
import { z } from 'zod';

import { EventNotInOrgError, runSpendPhase } from '@/lib/agent/spend';
import { resolveActor } from '@/lib/dev-actor';

export const runtime = 'nodejs';

/**
 * Demo beat 2. The plan goes in, line items are committed or routed for
 * approval, and the result comes back.
 *
 * The eventId must be a valid UUID. If the event doesn't belong to the
 * calling actor's org, return 404 to avoid leaking whether an event exists
 * in another tenant.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const resolved = await resolveActor();
  if (!resolved) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  // `viaFallback` is deliberately ignored: every approver on this path is
  // resolved by the policy table (Invariant 2), never by the caller.
  const { actor } = resolved;

  // Next 16: params is a Promise.
  const { id } = await ctx.params;

  // Validate that id is a well-formed UUID before hitting the database.
  const uuidSchema = z.string().uuid();
  const idValidation = uuidSchema.safeParse(id);
  if (!idValidation.success) {
    return NextResponse.json(
      { error: 'Invalid event ID format' },
      { status: 400 },
    );
  }

  try {
    const result = await runSpendPhase({ actor, eventId: id });
    return NextResponse.json(result, { status: 200 });
  } catch (cause) {
    // runSpendPhase throws EventNotInOrgError when the event doesn't belong to
    // the actor's org. Return 404 for both "not found" and "wrong org" to avoid
    // leaking whether an event exists in another tenant.
    if (cause instanceof EventNotInOrgError) {
      return NextResponse.json(
        { error: 'Event not found' },
        { status: 404 },
      );
    }

    // Any other error is a 500.
    const message = cause instanceof Error ? cause.message : 'Spend phase failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
