import { and, eq } from 'drizzle-orm';

import { db, orgs, users, type Role } from '@/db';

import { auth0 } from './auth0';

export interface Actor {
  userId: string;
  auth0Sub: string;
  orgId: string;
  auth0OrgId: string;
  email: string;
  displayName: string;
  role: Role;
}

/**
 * Resolves the current request's actor.
 *
 * INVARIANT 4 — the role is read from `users.role` in Postgres, never from a
 * session claim. nextjs-auth0 #2629: custom claims silently disappear after a
 * token refresh and `beforeSessionSaved` stops firing. A 4.5-hour session will
 * refresh. `sub` and `org_id` are default-persisted and safe to read; anything
 * we authorize on is not.
 *
 * Returns null when there is no session, or when the authenticated Auth0 user
 * has no row in this org — an unprovisioned user is not a member.
 */
export async function getActor(): Promise<Actor | null> {
  const session = await auth0.getSession();
  if (!session) return null;

  const claimedOrgId = (session.user as { org_id?: unknown }).org_id;
  const auth0OrgId =
    typeof claimedOrgId === 'string' ? claimedOrgId : process.env.AUTH0_ORG_ID;
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
    .where(and(eq(users.auth0Sub, session.user.sub), eq(orgs.auth0OrgId, auth0OrgId)))
    .limit(1);

  return row ?? null;
}

/** Same as {@link getActor}, but throws instead of returning null. */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new Error('Not authenticated, or not a member of this organization');
  return actor;
}
