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
    // Deliberately no "use most of the budget" nudge. Asking for high
    // utilisation pushed the total straight through the ceiling instead:
    // 78% unprompted, then 101% and 114% with the nudge, across gpt-4.1.
    // Underspending is a worse plan; overspending is a broken one.
    `- Leaving part of the budget unspent is acceptable. Exceeding it is not.`,
    ``,
    `How this kind of event actually works:`,
    `- The room is booked with a signed facility agreement and a`,
    `  non-refundable deposit. That commitment cannot be unwound once made,`,
    `  and the venue is the largest single cost in the plan by a wide margin.`,
    `- Food, drink, equipment rental, printed material and consumables are`,
    `  ordinary purchases that can be cancelled or returned close to the day.`,
    `- Mark an item irreversible only when it is a commitment you genuinely`,
    `  could not walk away from. Most line items are not.`,
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
