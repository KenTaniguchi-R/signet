import { and, eq } from 'drizzle-orm';

import { db, orgs, users } from '@/db';

import { getActor, type Actor } from './actor';

export interface ResolvedActor {
  actor: Actor;
  /**
   * True when the actor came from the dev fallback rather than a real session.
   *
   * Reported from the point of decision, never inferred afterwards from the
   * actor's shape. The previous `isDevActor()` sniffed for a `pending|` sub and
   * silently stopped working the moment the seeded users got real ones — it
   * returned false for exactly the case it existed to catch.
   */
  viaFallback: boolean;
}

/**
 * `getActor()` with a development-only fallback.
 *
 * Gated on a hard `NODE_ENV !== 'production'` check AND an explicit opt-in env
 * var, so it cannot ship even by accident. With `SIGNET_DEV_VIEWER_EMAIL`
 * unset this is `getActor()` exactly.
 *
 * The fallback is now an escape hatch, not the demo path: the seeded users have
 * real Auth0 subs, so the demo runs on two real logins in two browser profiles.
 * A fallback actor can render the inbox but cannot approve — approve/decline
 * require a real session under Invariant 1 — which is why callers surface
 * `viaFallback` in the UI. Delete this file once the escape hatch is no longer
 * wanted; it is scaffolding, not a feature.
 */
export async function resolveActor(): Promise<ResolvedActor | null> {
  const actor = await getActor().catch(() => null);
  if (actor) return { actor, viaFallback: false };

  if (process.env.NODE_ENV === 'production') return null;

  const email = process.env.SIGNET_DEV_VIEWER_EMAIL;
  if (!email) return null;

  /*
   * Scoped to AUTH0_ORG_ID, not email alone.
   *
   * Re-seeding against a new Auth0 organization leaves the same demo emails
   * present in two org rows. Matching on email alone then picks whichever the
   * planner returns first, so the dev viewer can silently land in the wrong
   * tenant — and every downstream org check fails 404 for reasons that look
   * nothing like the cause. Fail closed instead: no org, no actor.
   */
  const auth0OrgId = process.env.AUTH0_ORG_ID;
  if (!auth0OrgId) return null;

  const [row] = await db
    .select({
      userId: users.id,
      auth0Sub: users.auth0Sub,
      orgId: users.orgId,
      auth0OrgId: orgs.auth0OrgId,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
    })
    .from(users)
    .innerJoin(orgs, eq(users.orgId, orgs.id))
    .where(and(eq(users.email, email), eq(orgs.auth0OrgId, auth0OrgId)))
    .limit(1);

  return row ? { actor: row, viaFallback: true } : null;
}
