import type { PillTone } from '@/components/StatusPill';

import type { LineItemStatus } from '../db/schema.ts';

/**
 * What the State column should say about one line item.
 *
 * `roles` means the pill names the approvers the rule routed to — the caller
 * renders them, because turning a `Role` into a label is a display concern.
 */
export type PlanRowState =
  | { pill: 'roles'; tone: 'halt' }
  | { pill: 'text'; tone: PillTone; label: string };

/**
 * The State column is a claim about what HAPPENED, so it is driven by `status`
 * first and by policy only where status leaves a genuine choice.
 *
 * This used to be `requiresApproval ? roles : 'Settled'`. But `requiresApproval`
 * is re-derived from the pure policy function on every render (see
 * `getPlanRows`), which is exactly what makes it useless as evidence: it is
 * true of a line item nobody has touched and true of one charged an hour ago.
 * The sub-$200 rows therefore rendered a green SETTLED the moment the agent
 * finished PLANNING — eight purchases reported as complete before the spend
 * phase had been run at all, and before a single `approvals` row existed. The
 * page asserted the demo's whole payload had already happened, which then made
 * an empty `/inbox` look like a routing bug rather than a step not yet taken.
 *
 * `status` is the only field that records anything. A row is settled when the
 * harness settled it, not when policy declined to ask a human about it.
 */
export function planRowState(row: {
  status: LineItemStatus;
  requiresApproval: boolean;
}): PlanRowState {
  switch (row.status) {
    case 'charged':
      return { pill: 'text', tone: 'ok', label: 'Charged' };
    case 'declined':
      // Previously fell through to the roles pill and read as still blocked on
      // a human who had already answered — and kept the row in the header's
      // "awaiting a human" count forever.
      return { pill: 'text', tone: 'stop', label: 'Declined' };
    case 'auto_approved':
      return { pill: 'text', tone: 'ok', label: 'Settled' };
    default:
      break;
  }

  // `proposed`, `awaiting_approval`, and the unused `approved`. A gated row
  // that has not reached the money yet keeps previewing its approvers — naming
  // them before the `approvals` row exists is deliberate, see `getPlanRows`.
  if (row.requiresApproval) return { pill: 'roles', tone: 'halt' };

  // Auto-approved by rule, but nothing has run it. The Rule column already
  // says which rule; this column's job is to admit no money has moved.
  return { pill: 'text', tone: 'idle', label: 'Proposed' };
}

/** True while a row is still waiting on a person. Drives tint, order, and count. */
export function isAwaitingHuman(row: {
  status: LineItemStatus;
  requiresApproval: boolean;
}): boolean {
  return planRowState(row).pill === 'roles';
}
