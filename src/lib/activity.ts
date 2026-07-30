import { activity, db } from '../db/index.ts';

/**
 * One row per boundary crossing. `payload` is what the MODEL supplied;
 * `harnessInjected` is what WE resolved. Keeping them in separate columns is
 * the audit story: nothing in the right-hand column came from the left.
 */
export async function logActivity(args: {
  eventId: string;
  actorUserId?: string | null;
  kind: string;
  payload?: unknown;
  harnessInjected?: unknown;
}): Promise<void> {
  await db.insert(activity).values({
    eventId: args.eventId,
    actorUserId: args.actorUserId ?? null,
    kind: args.kind,
    payloadJson: (args.payload ?? null) as never,
    harnessInjectedJson: (args.harnessInjected ?? null) as never,
  });
}
