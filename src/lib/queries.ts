import { and, desc, eq, inArray } from 'drizzle-orm';

import { approvals, db, events, lineItems, users } from '@/db';

import type { PlanRow } from '@/components/PlanTable';
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
