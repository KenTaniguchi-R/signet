import { eq } from 'drizzle-orm';

import { db, orgs, users } from '@/db';

import { getActor, type Actor } from './actor';

/**
 * `getActor()` with a development-only fallback.
 *
 * The Auth0 users do not exist yet, so without this the UI cannot be built or
 * reviewed at all. Gated on a hard `NODE_ENV !== 'production'` check AND an
 * explicit opt-in env var, so it cannot ship even by accident.
 *
 * Delete the fallback once real logins work. It is scaffolding, not a feature.
 */
export async function resolveActor(): Promise<Actor | null> {
  const actor = await getActor().catch(() => null);
  if (actor) return actor;

  if (process.env.NODE_ENV === 'production') return null;

  const email = process.env.SIGNET_DEV_VIEWER_EMAIL;
  if (!email) return null;

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
    .where(eq(users.email, email))
    .limit(1);

  return row ?? null;
}

/** True when the actor came from the dev fallback rather than a real session. */
export function isDevActor(actor: Actor | null): boolean {
  return Boolean(actor && actor.auth0Sub.startsWith('pending|'));
}
