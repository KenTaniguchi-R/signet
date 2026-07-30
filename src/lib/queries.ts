import { and, desc, eq, inArray } from 'drizzle-orm';

import { approvals, db, events, lineItems, users, type Role } from '@/db';

import type { PlanRow, SpentCard } from '@/components/PlanTable';
import { resolvePolicy } from './policy';

/** The org's most recent event, or null before the agent has planned anything. */
export async function getLatestEvent(orgId: string) {
  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.orgId, orgId))
    .orderBy(desc(events.createdAt))
    .limit(1);

  return event ?? null;
}

/**
 * The card face for a settled line item, or null if there is nothing to show.
 *
 * Requires BOTH a persisted card face and a resolved signer: rendering a card
 * with no name on it would undercut the one claim the card exists to make.
 * An auto-approved line item has no signer and so shows no card — the money
 * moved under policy, not under a person, and the UI should not pretend it did.
 */
function toSpentCard(
  item: { cardLast4: string | null; cardExp: string | null },
  signer: { displayName: string; role: Role } | undefined,
): SpentCard | null {
  if (!item.cardLast4 || !item.cardExp || !signer) return null;
  return {
    cardholderName: signer.displayName,
    role: signer.role,
    last4: item.cardLast4,
    exp: item.cardExp,
  };
}

/**
 * The plan, with each row's policy decision re-derived rather than read from
 * `line_items.status`. `resolvePolicy` is pure, so re-running it is free and
 * the table cannot drift from the rules the harness enforces.
 */
export async function getPlanRows(eventId: string): Promise<PlanRow[]> {
  const items = await db
    .select()
    .from(lineItems)
    .where(eq(lineItems.eventId, eventId))
    .orderBy(desc(lineItems.amountCents));

  if (items.length === 0) return [];

  const rows = await db
    .select({
      lineItemId: approvals.lineItemId,
      role: approvals.requiredRole,
      displayName: users.displayName,
    })
    .from(approvals)
    .leftJoin(users, eq(users.id, approvals.requiredApproverId))
    .where(
      inArray(
        approvals.lineItemId,
        items.map((item) => item.id),
      ),
    );

  // Who actually signed. The card is issued in the name of the person who
  // RESOLVED the approval, which is read from `approved_by` — set from the
  // server session — not from the role the policy asked for.
  const signed = await db
    .select({
      lineItemId: approvals.lineItemId,
      displayName: users.displayName,
      role: users.role,
    })
    .from(approvals)
    .innerJoin(users, eq(users.id, approvals.approvedBy))
    .where(
      and(
        inArray(
          approvals.lineItemId,
          items.map((item) => item.id),
        ),
        eq(approvals.status, 'approved'),
      ),
    );

  const signerByLineItem = new Map(signed.map((s) => [s.lineItemId, s]));

  const byLineItem = new Map<string, { role: (typeof rows)[number]['role']; displayName: string | null }[]>();
  for (const row of rows) {
    const list = byLineItem.get(row.lineItemId) ?? [];
    list.push({ role: row.role, displayName: row.displayName });
    byLineItem.set(row.lineItemId, list);
  }

  return items.map((item) => {
    const decision = resolvePolicy({
      amountCents: item.amountCents,
      reversible: item.reversible,
    });

    // Prefer the persisted approvers; fall back to the roles policy names, so a
    // plan renders correctly even before the spend phase has written approvals.
    const persisted = byLineItem.get(item.id);
    const approvers =
      persisted && persisted.length > 0
        ? decision.approverRoles.map(
            (role) =>
              persisted.find((entry) => entry.role === role) ?? { role, displayName: null },
          )
        : decision.approverRoles.map((role) => ({ role, displayName: null }));

    return {
      id: item.id,
      category: item.category,
      vendor: item.vendor,
      amountCents: item.amountCents,
      reversible: item.reversible,
      status: item.status,
      decision,
      approvers,
      card: toSpentCard(item, signerByLineItem.get(item.id)),
    };
  });
}

export interface InboxItem {
  approvalId: string;
  lineItemId: string;
  ruleName: string;
  category: string;
  vendor: string;
  amountCents: number;
  reversible: boolean;
  eventTitle: string;
  /** The other roles on this line item, so nobody wonders if they are last. */
  coApprovers: { role: (typeof approvals.$inferSelect)['requiredRole']; displayName: string | null; status: string }[];
}

/** Only the approvals routed to THIS person. The whole point of two windows. */
export async function getInbox(userId: string): Promise<InboxItem[]> {
  const mine = await db
    .select({
      approvalId: approvals.id,
      lineItemId: approvals.lineItemId,
      ruleName: approvals.ruleName,
      category: lineItems.category,
      vendor: lineItems.vendor,
      amountCents: lineItems.amountCents,
      reversible: lineItems.reversible,
      eventTitle: events.title,
    })
    .from(approvals)
    .innerJoin(lineItems, eq(lineItems.id, approvals.lineItemId))
    .innerJoin(events, eq(events.id, lineItems.eventId))
    .where(and(eq(approvals.requiredApproverId, userId), eq(approvals.status, 'pending')))
    .orderBy(desc(lineItems.amountCents));

  if (mine.length === 0) return [];

  const siblings = await db
    .select({
      lineItemId: approvals.lineItemId,
      role: approvals.requiredRole,
      status: approvals.status,
      approverId: approvals.requiredApproverId,
      displayName: users.displayName,
    })
    .from(approvals)
    .leftJoin(users, eq(users.id, approvals.requiredApproverId))
    .where(
      inArray(
        approvals.lineItemId,
        mine.map((row) => row.lineItemId),
      ),
    );

  return mine.map((row) => ({
    ...row,
    coApprovers: siblings
      .filter((s) => s.lineItemId === row.lineItemId && s.approverId !== userId)
      .map((s) => ({ role: s.role, displayName: s.displayName, status: s.status })),
  }));
}

/** Badge count for the identity bar. */
export async function getInboxCount(userId: string): Promise<number> {
  const rows = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.requiredApproverId, userId), eq(approvals.status, 'pending')));

  return rows.length;
}
