import { ToolLoopAgent, isStepCount, tool } from 'ai';
import { and, eq } from 'drizzle-orm';

import { approvals, db, events, lineItems, type Role } from '../../db/index.ts';
import { logActivity } from '../activity.ts';
import { resolvePolicy, type PolicyDecision } from '../policy.ts';
import { resolveApprovers, dbApproverLookup, type ApproverLookup } from '../policy-router.ts';
import type { Actor } from '../actor.ts';
import { signetModel } from './model.ts';
import { type SpendInput, spendInput } from './schema.ts';

/**
 * What the gate and the persist path both need to know about a line item to
 * route it: its real cost and reversibility. Nothing the model said about
 * itself — see CRITICAL 1.
 */
export interface LineItemPolicyFacts {
  amountCents: number;
  reversible: boolean;
}

/**
 * Looks up a line item's authoritative policy-relevant facts by id only (no
 * event/org scope — the gate runs before we necessarily trust anything about
 * scope, and its job is narrower than the persist path's: source real numbers
 * instead of the model's). Injectable, following the `ApproverLookup` pattern
 * in `policy-router.ts`.
 */
export type PolicyRowLookup = (lineItemId: string) => Promise<LineItemPolicyFacts | null>;

const defaultPolicyRowLookup: PolicyRowLookup = async (lineItemId) => {
  const [row] = await db
    .select({ amountCents: lineItems.amountCents, reversible: lineItems.reversible })
    .from(lineItems)
    .where(eq(lineItems.id, lineItemId))
    .limit(1);
  return row ?? null;
};

/**
 * The gate. Policy decides WHETHER a human is needed; it never decides who.
 *
 * CRITICAL 1 fix: this used to run `resolvePolicy` on `input.amountCents` /
 * `input.reversible` — numbers the MODEL wrote into its own tool call. A
 * model that declares a $2,800 irreversible contract as "$900, reversible"
 * would route to the wrong (weaker) approval band, or under $200 skip
 * approval entirely. The row in the database is the only trustworthy source
 * for what a line item actually costs; the model only gets to point at one
 * by id. An id that doesn't resolve fails closed (requires approval) rather
 * than falling back to the model's numbers.
 */
export async function spendApprovalRule(
  input: SpendInput,
  lookup: PolicyRowLookup = defaultPolicyRowLookup,
): Promise<'user-approval' | undefined> {
  const row = await lookup(input.lineItemId);
  if (!row) return 'user-approval';

  const { requiresApproval } = resolvePolicy({
    amountCents: row.amountCents,
    reversible: row.reversible,
  });
  return requiresApproval ? 'user-approval' : undefined;
}

const spendTool = tool({
  description:
    'Commit to one planned line item. Call once per item. ' +
    'If a call is not approved, do not retry it.',
  inputSchema: spendInput,
  execute: async (input: SpendInput) => {
    // CRITICAL 2: this used to write `status: 'auto_approved'` right here,
    // constrained only by `lineItems.id` — no event, no org. A hallucinated
    // or cross-tenant id would silently flip someone else's row. execute()
    // has no event/org boundary available to check against, so the
    // authoritative, event-scoped write now happens in `runSpendPhase` (the
    // 'tool-result' branch there) after this call returns and eventId is in
    // scope. This function intentionally does not touch the database.
    return `Committed ${input.vendor} for ${input.amountCents} cents.`;
  },
});

export function buildSpendAgent() {
  const secret = process.env.SIGNET_TOOL_APPROVAL_SECRET;
  if (!secret) {
    // Defence in depth, not the boundary. Our approvals row is what decides
    // who was allowed to approve, so a missing secret must not break the demo.
    console.warn(
      'SIGNET_TOOL_APPROVAL_SECRET is not set — approval requests will be unsigned.',
    );
  }

  return new ToolLoopAgent({
    model: signetModel(),
    tools: { spend: spendTool },
    // Wrapped rather than passed directly: the SDK calls this with
    // `(input, options)`, and `options` is not a `PolicyRowLookup` — passing
    // `spendApprovalRule` itself would hand our lookup parameter a value it
    // can't call. The wrapper drops `options` and lets the default DB lookup
    // apply.
    toolApproval: { spend: (input: SpendInput) => spendApprovalRule(input) },
    stopWhen: isStepCount(30),
    ...(secret ? { experimental_toolApprovalSecret: secret } : {}),
    // v7's ToolLoopAgentSettings has no `system` field — that's `instructions`.
    instructions:
      'You commit planned purchases by calling the spend tool once per line ' +
      'item, using the lineItemId given to you. When a call is not approved, ' +
      'do not retry it.',
  });
}

/** One `approvals` row, shaped for insertion. */
export interface ApprovalRow {
  lineItemId: string;
  approvalId: string;
  requiredRole: Role;
  requiredApproverId: string | null;
  ruleName: string;
  status: 'pending';
}

/**
 * Pure. Turns a policy decision plus resolved approver ids into insertable
 * rows — one per required role, all sharing one `approvalId` (the AI SDK
 * tool-approval handle they resume together). `approverIds[i]` pairs with
 * `decision.approverRoles[i]` by index; a `null` (role unfilled in this org)
 * is written as `null`, never dropped or coerced to `undefined` — see
 * `resolveApprovers` in `policy-router.ts` for why a null is meaningful.
 */
export function buildApprovalRows(args: {
  lineItem: { id: string };
  approvalId: string;
  decision: PolicyDecision;
  approverIds: (string | null)[];
}): ApprovalRow[] {
  return args.decision.approverRoles.map((role, i) => ({
    lineItemId: args.lineItem.id,
    approvalId: args.approvalId,
    requiredRole: role,
    requiredApproverId: args.approverIds[i] ?? null,
    ruleName: args.decision.ruleName,
    status: 'pending' as const,
  }));
}

/**
 * Looks up a line item's id and policy facts, scoped to the event in scope.
 * Injectable, following the `ApproverLookup` pattern — lets the persist path
 * be tested without a database.
 */
export type LineItemRowLookup = (
  lineItemId: string,
  eventId: string,
) => Promise<({ id: string } & LineItemPolicyFacts) | null>;

const defaultLineItemRowLookup: LineItemRowLookup = async (lineItemId, eventId) => {
  const [row] = await db
    .select({
      id: lineItems.id,
      amountCents: lineItems.amountCents,
      reversible: lineItems.reversible,
    })
    .from(lineItems)
    .where(and(eq(lineItems.id, lineItemId), eq(lineItems.eventId, eventId)))
    .limit(1);
  return row ?? null;
};

const defaultWriteApprovalRows = async (rows: ApprovalRow[]): Promise<number> => {
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(approvals)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: approvals.id });
  return inserted.length;
};

const defaultMarkAwaitingApproval = async (lineItemId: string): Promise<void> => {
  await db
    .update(lineItems)
    .set({ status: 'awaiting_approval' })
    .where(eq(lineItems.id, lineItemId));
};

/** Injectable collaborators for {@link persistApprovalRequests}. Tests supply these to run without a database. */
export interface PersistApprovalRequestsDeps {
  lineItemLookup?: LineItemRowLookup;
  approverLookup?: ApproverLookup;
  writeApprovalRows?: (rows: ApprovalRow[]) => Promise<number>;
  markAwaitingApproval?: (lineItemId: string) => Promise<void>;
  log?: typeof logActivity;
}

/**
 * Writes one `approvals` row per required role for a single halted tool call.
 * The only model-supplied value that reaches the DB is `lineItemId`, and only
 * after it is verified to belong to `eventId` — a hallucinated or cross-event
 * id is skipped and logged, never trusted.
 */
export async function persistApprovalRequests(
  args: {
    actor: Actor;
    eventId: string;
    approvalId: string;
    input: SpendInput;
  },
  deps: PersistApprovalRequestsDeps = {},
): Promise<{ created: number; skipped: string[] }> {
  const lineItemLookup = deps.lineItemLookup ?? defaultLineItemRowLookup;
  const writeApprovalRows = deps.writeApprovalRows ?? defaultWriteApprovalRows;
  const markAwaitingApproval = deps.markAwaitingApproval ?? defaultMarkAwaitingApproval;
  const log = deps.log ?? logActivity;

  const skipped: string[] = [];

  // The model supplied this id. Verify it belongs to the event in scope
  // before trusting it — a hallucinated or cross-event id is dropped.
  const lineItem = await lineItemLookup(args.input.lineItemId, args.eventId);

  if (!lineItem) {
    await log({
      eventId: args.eventId,
      kind: 'rejected_unknown_line_item',
      payload: args.input,
      harnessInjected: { reason: 'lineItemId not in this event' },
    });
    skipped.push(args.input.lineItemId);
    return { created: 0, skipped };
  }

  // CRITICAL 1 fix: routing runs on the VERIFIED ROW's cost and
  // reversibility, never on `args.input`. The model can point at a line item
  // by id; it cannot talk its way into a cheaper approval band by declaring
  // a different amount or reversibility for that same id.
  const decision = resolvePolicy({
    amountCents: lineItem.amountCents,
    reversible: lineItem.reversible,
  });

  const approverIds = await resolveApprovers(
    args.actor.orgId,
    decision.approverRoles,
    deps.approverLookup ?? dbApproverLookup,
  );

  const rows = buildApprovalRows({
    lineItem,
    approvalId: args.approvalId,
    decision,
    approverIds,
  });

  // IMPORTANT 4 fix: count what `.onConflictDoNothing()` actually inserted
  // (via `.returning()`), not the number of rows attempted. A replayed call
  // hits the unique (lineItemId, requiredRole) index and inserts nothing —
  // `approvalsCreated` is what the demo shows, so it must reflect that.
  const created = await writeApprovalRows(rows);

  await markAwaitingApproval(lineItem.id);

  await log({
    eventId: args.eventId,
    kind: 'approval_required',
    payload: args.input,
    harnessInjected: {
      approverIds,
      orgId: args.actor.orgId,
      ruleName: decision.ruleName,
      requiredRoles: decision.approverRoles,
    },
  });

  return { created, skipped };
}

export async function runSpendPhase(args: {
  actor: Actor;
  eventId: string;
}): Promise<{ approvalsCreated: number; autoApproved: number }> {
  // IMPORTANT 3 fix: tie eventId to actor.orgId before touching anything
  // else. Without this, line items are scoped by eventId while approvers are
  // resolved from actor.orgId with nothing joining the two — an eventId from
  // another org would resolve approvers from the wrong roster. Fail closed.
  const [event] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.id, args.eventId), eq(events.orgId, args.actor.orgId)))
    .limit(1);

  if (!event) {
    throw new Error(`Event ${args.eventId} does not belong to org ${args.actor.orgId}`);
  }

  const items = await db
    .select()
    .from(lineItems)
    .where(eq(lineItems.eventId, args.eventId));

  const agent = buildSpendAgent();
  const messages = [
    {
      role: 'user' as const,
      content:
        'Commit each of these line items by calling the spend tool once ' +
        'per item:\n' +
        items
          .map(
            (i) =>
              `- lineItemId=${i.id} category=${i.category} vendor=${i.vendor} ` +
              `amountCents=${i.amountCents} reversible=${i.reversible}`,
          )
          .join('\n'),
    },
  ];

  const result = await agent.generate({ messages });

  let approvalsCreated = 0;

  for (const part of result.content) {
    if (part.type === 'tool-result') {
      // CRITICAL 2 fix: the auto-approve write, scoped to the event in scope.
      // A cross-event/cross-tenant lineItemId matches zero rows here and is
      // logged instead of silently flipping someone else's line item.
      const committed = spendInput.parse(part.input);
      const rows = await db
        .update(lineItems)
        .set({ status: 'auto_approved' })
        .where(
          and(
            eq(lineItems.id, committed.lineItemId),
            eq(lineItems.eventId, args.eventId),
          ),
        )
        .returning({ id: lineItems.id });

      if (rows.length === 0) {
        await logActivity({
          eventId: args.eventId,
          kind: 'rejected_unknown_line_item',
          payload: committed,
          harnessInjected: { reason: 'lineItemId not in this event (auto-approve path)' },
        });
      }
      continue;
    }

    if (part.type !== 'tool-approval-request' || part.isAutomatic) continue;

    // MINOR 7 fix: validate rather than cast. The SDK validates upstream
    // against `spendInput` already, but this is a policy-relevant path and
    // the guarantee should be stated locally, not assumed from elsewhere.
    const input = spendInput.parse(part.toolCall.input);

    const { created } = await persistApprovalRequests({
      actor: args.actor,
      eventId: args.eventId,
      approvalId: part.approvalId,
      input,
    });
    approvalsCreated += created;
  }

  await db
    .update(events)
    .set({ messagesJson: result.responseMessages as never })
    .where(eq(events.id, args.eventId));

  // Count from the DB, not by subtracting from items.length. The loop halts at
  // the first step containing an approval request, so items the model never
  // reached are neither auto-approved nor pending — subtraction would report
  // them as committed money that never moved.
  const autoApprovedRows = await db
    .select({ id: lineItems.id })
    .from(lineItems)
    .where(
      and(eq(lineItems.eventId, args.eventId), eq(lineItems.status, 'auto_approved')),
    );

  return { approvalsCreated, autoApproved: autoApprovedRows.length };
}
