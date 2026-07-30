import { activity, db } from '../db/index.ts';

/**
 * Shape the activity row for insertion. Kept as a pure function for testability.
 * `payload` is what the MODEL supplied; `harnessInjected` is what WE resolved.
 * Keeping them in separate columns is the audit story: nothing in the
 * right-hand column came from the left.
 */
export function buildActivityRow(args: {
  eventId: string;
  actorUserId?: string | null;
  kind: string;
  payload?: unknown;
  harnessInjected?: unknown;
}): {
  eventId: string;
  actorUserId: string | null;
  kind: string;
  payloadJson: unknown;
  harnessInjectedJson: unknown;
} {
  return {
    eventId: args.eventId,
    actorUserId: args.actorUserId ?? null,
    kind: args.kind,
    payloadJson: (args.payload ?? null) as never,
    harnessInjectedJson: (args.harnessInjected ?? null) as never,
  };
}

/**
 * One row per boundary crossing. Logs activity to the database using
 * buildActivityRow for row shaping.
 */
export async function logActivity(args: {
  eventId: string;
  actorUserId?: string | null;
  kind: string;
  payload?: unknown;
  harnessInjected?: unknown;
}): Promise<void> {
  await db.insert(activity).values(buildActivityRow(args));
}
