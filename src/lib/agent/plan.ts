import { Output, generateText } from 'ai';

import { db, events, lineItems } from '../../db/index.ts';
import type { Actor } from '../actor.ts';
import { signetModel } from './model.ts';
import { type PlanOutput, planOutput } from './schema.ts';

export type PlanBrief = {
  title: string;
  budgetCents: number;
  headcount: number;
  notes?: string;
};

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US')}`;
}

/**
 * The prompt describes a constraint-satisfaction problem and nothing else.
 * It deliberately says nothing about approval, roles, or people: which
 * purchases need a human is decided by resolvePolicy after the fact, and a
 * model that knew the thresholds would be tempted to plan around them.
 */
export function buildPlanPrompt(brief: PlanBrief): string {
  const lines = [
    `Plan the spend for: ${brief.title}`,
    ``,
    `Total budget: ${dollars(brief.budgetCents)} (hard ceiling)`,
    `Headcount: ${brief.headcount}`,
    ...(brief.notes ? [`Additional constraints: ${brief.notes}`] : []),
    ``,
    `Produce about 12 line items across venue, catering, drinks, av, prizes,`,
    `and supplies. Constraints you must satisfy:`,
    `- Venue capacity must be at least the headcount.`,
    `- Catering must be sized for the headcount and honour the dietary notes.`,
    `- The total must not exceed the budget. Trade off between categories`,
    `  where needed and explain the trade-off in the rationale.`,
    `- Mark an item irreversible when it is a signed contract or a`,
    `  non-refundable deposit.`,
    ``,
    `Give every item a concrete named vendor and a one-sentence rationale.`,
  ];
  return lines.join('\n');
}

export async function planEvent(args: {
  actor: Actor;
  brief: PlanBrief;
}): Promise<{ eventId: string; plan: PlanOutput }> {
  const { output } = await generateText({
    model: signetModel(),
    output: Output.object({ schema: planOutput }),
    prompt: buildPlanPrompt(args.brief),
  });

  const [event] = await db
    .insert(events)
    .values({
      orgId: args.actor.orgId,
      title: args.brief.title,
      budgetCents: args.brief.budgetCents,
      createdBy: args.actor.userId,
      status: 'planning',
    })
    .returning();

  await db.insert(lineItems).values(
    output.lineItems.map((item) => ({
      eventId: event.id,
      category: item.category,
      vendor: item.vendor,
      amountCents: item.amountCents,
      reversible: item.reversible,
      status: 'proposed' as const,
    })),
  );

  return { eventId: event.id, plan: output };
}
