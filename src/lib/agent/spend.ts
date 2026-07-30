import { ToolLoopAgent, isStepCount, tool } from 'ai';
import { and, eq } from 'drizzle-orm';

import { approvals, db, events, lineItems } from '../../db/index.ts';
import { logActivity } from '../activity.ts';
import { resolvePolicy } from '../policy.ts';
import { resolveApprovers } from '../policy-router.ts';
import type { Actor } from '../actor.ts';
import { signetModel } from './model.ts';
import { type SpendInput, spendInput } from './schema.ts';

/**
 * The gate. Policy decides WHETHER a human is needed; it never decides who.
 * Destructured explicitly — resolvePolicy's input is deliberately narrow, and
 * passing the whole tool input would let a future field leak into routing.
 */
export function spendApprovalRule(input: SpendInput): 'user-approval' | undefined {
  const { requiresApproval } = resolvePolicy({
    amountCents: input.amountCents,
    reversible: input.reversible,
  });
  return requiresApproval ? 'user-approval' : undefined;
}

const spendTool = tool({
  description:
    'Commit to one planned line item. Call once per item. ' +
    'If a call is not approved, do not retry it.',
  inputSchema: spendInput,
  execute: async (input: SpendInput) => {
    // Reached only for items policy auto-approved. Execution (Issuing card,
    // Slack post, meter event) is a later chunk of work.
    await db
      .update(lineItems)
      .set({ status: 'auto_approved' })
      .where(eq(lineItems.id, input.lineItemId));

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
    toolApproval: { spend: spendApprovalRule },
    stopWhen: isStepCount(30),
    ...(secret ? { experimental_toolApprovalSecret: secret } : {}),
    // v7's ToolLoopAgentSettings has no `system` field — that's `instructions`.
    instructions:
      'You commit planned purchases by calling the spend tool once per line ' +
      'item, using the lineItemId given to you. When a call is not approved, ' +
      'do not retry it.',
  });
}

/**
 * Writes one `approvals` row per required role for a single halted tool call.
 * The only model-supplied value that reaches the DB is `lineItemId`, and only
 * after it is verified to belong to `eventId` — a hallucinated or cross-event
 * id is skipped and logged, never trusted.
 */
export async function persistApprovalRequests(args: {
  actor: Actor;
  eventId: string;
  approvalId: string;
  input: SpendInput;
}): Promise<{ created: number; skipped: string[] }> {
  const skipped: string[] = [];

  // The model supplied this id. Verify it belongs to the event in scope
  // before trusting it — a hallucinated or cross-event id is dropped.
  const [lineItem] = await db
    .select()
    .from(lineItems)
    .where(
      and(eq(lineItems.id, args.input.lineItemId), eq(lineItems.eventId, args.eventId)),
    )
    .limit(1);

  if (!lineItem) {
    await logActivity({
      eventId: args.eventId,
      kind: 'rejected_unknown_line_item',
      payload: args.input,
      harnessInjected: { reason: 'lineItemId not in this event' },
    });
    skipped.push(args.input.lineItemId);
    return { created: 0, skipped };
  }

  const decision = resolvePolicy({
    amountCents: args.input.amountCents,
    reversible: args.input.reversible,
  });

  const approverIds = await resolveApprovers(args.actor.orgId, decision.approverRoles);

  let created = 0;

  for (const [i, role] of decision.approverRoles.entries()) {
    await db
      .insert(approvals)
      .values({
        lineItemId: lineItem.id,
        approvalId: args.approvalId,
        requiredRole: role,
        requiredApproverId: approverIds[i] ?? null,
        ruleName: decision.ruleName,
        status: 'pending',
      })
      .onConflictDoNothing();
    created += 1;
  }

  await db
    .update(lineItems)
    .set({ status: 'awaiting_approval' })
    .where(eq(lineItems.id, lineItem.id));

  await logActivity({
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
    if (part.type !== 'tool-approval-request' || part.isAutomatic) continue;

    const input = part.toolCall.input as SpendInput;

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
