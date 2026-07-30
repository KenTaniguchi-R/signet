import { and, asc, eq } from 'drizzle-orm';

import { db, users } from '../db/index.ts';
import type { Role } from '../db/schema.ts';

export class NoApproverForRoleError extends Error {
  readonly role: Role;

  constructor(role: Role, orgId: string) {
    super(`No user in org ${orgId} holds the ${role} role.`);
    this.name = 'NoApproverForRoleError';
    this.role = role;
  }
}

/**
 * Signature for role-to-person lookup. Injectable for testing.
 * Implementations must filter on BOTH orgId and role; filtering on role alone
 * would cross tenant boundaries.
 */
export type ApproverLookup = (orgId: string, role: Role) => Promise<string | null>;

/**
 * The real lookup. Filters on BOTH orgId and role — role alone would cross tenants.
 * Queries deterministically with a stable order.
 */
export const dbApproverLookup: ApproverLookup = async (orgId, role) => {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.role, role)))
    .orderBy(asc(users.createdAt))
    .limit(1);

  return row?.id ?? null;
};

/**
 * Role to person. This is the lookup the model is structurally prevented from
 * doing: the approver's identity enters the system here and nowhere else.
 */
export async function resolveApprover(
  orgId: string,
  role: Role,
): Promise<string | null> {
  return dbApproverLookup(orgId, role);
}

/**
 * Resolves each required role to a person, or to null when the org has nobody
 * in that role.
 *
 * REVISED during execution. The original design threw here, on the reasoning
 * that an approval with a null approver sits in nobody's inbox. That turned
 * out to be false in this codebase: `src/lib/approvals.ts` already accepts a
 * null `required_approver_id` and falls back to matching the actor's role —
 *
 *     requiredApproverId === null && requiredRole === actor.role
 *
 * so a null routes to whoever holds the role rather than to nobody. Throwing
 * would have made that fallback unreachable and turned a thin seed into a
 * hard 409 mid-demo. Returning null keeps both paths live: a named approver
 * when the org is seeded, role-based routing when it isn't.
 */
export async function resolveApprovers(
  orgId: string,
  roles: Role[],
  lookup: ApproverLookup = dbApproverLookup,
): Promise<(string | null)[]> {
  const ids: (string | null)[] = [];
  for (const role of roles) {
    ids.push(await lookup(orgId, role));
  }
  return ids;
}

/** Strict variant. Not used by this plan's paths — available for callers that need it. */
export async function requireApprover(
  orgId: string,
  role: Role,
  lookup: ApproverLookup = dbApproverLookup,
): Promise<string> {
  const id = await lookup(orgId, role);
  if (!id) throw new NoApproverForRoleError(role, orgId);
  return id;
}
