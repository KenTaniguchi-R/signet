import { IdentityBar } from '@/components/IdentityBar';
import { PlanTable } from '@/components/PlanTable';
import { resolveActor } from '@/lib/dev-actor';
import { getInboxCount, getLatestEvent, getPlanRows } from '@/lib/queries';

import { SignedOut } from './SignedOut';

export const dynamic = 'force-dynamic';

export default async function PlanPage() {
  const actor = await resolveActor();
  if (!actor) return <SignedOut />;

  const [event, inboxCount] = await Promise.all([
    getLatestEvent(actor.orgId),
    getInboxCount(actor.userId),
  ]);
  const rows = event ? await getPlanRows(event.id) : [];

  return (
    <>
      <IdentityBar actor={actor} active="plan" inboxCount={inboxCount} />

      <main className="mx-auto w-full max-w-[1120px] flex-1 px-6 py-10">
        {event && rows.length > 0 ? (
          <PlanTable rows={rows} title={event.title} budgetCents={event.budgetCents} />
        ) : (
          <EmptyPlan />
        )}
      </main>
    </>
  );
}

function EmptyPlan() {
  return (
    <section className="rounded-sm border border-rule bg-surface px-6 py-16 text-center">
      <h2 className="font-serif text-2xl tracking-[-0.01em]">Nothing planned yet</h2>
      <p className="mx-auto mt-2 max-w-[46ch] text-sm text-ink-muted">
        Describe an event and its budget, and the agent will decompose it into line items. Anything
        a policy rule stops appears here, awaiting a named person.
      </p>
      <p className="mt-6 font-mono text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint">
        npm run db:seed -- --with-plan
      </p>
    </section>
  );
}
