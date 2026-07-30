import { BoundaryLog } from '@/components/BoundaryLog';
import { BriefForm } from '@/components/BriefForm';
import { IdentityBar } from '@/components/IdentityBar';
import { PlanTable } from '@/components/PlanTable';
import { resolveActor } from '@/lib/dev-actor';
import { getBoundaryLog, getInboxCount, getLatestEvent, getPlanRows } from '@/lib/queries';

import { SignedOut } from './SignedOut';

export const dynamic = 'force-dynamic';

export default async function PlanPage() {
  const resolved = await resolveActor();
  if (!resolved) return <SignedOut />;
  const { actor, viaFallback } = resolved;

  const [event, inboxCount] = await Promise.all([
    getLatestEvent(actor.orgId),
    getInboxCount(actor.userId),
  ]);
  const [rows, boundary] = event
    ? await Promise.all([getPlanRows(event.id), getBoundaryLog(event.id, actor.orgId)])
    : [[], { entries: [], names: {} }];

  return (
    <>
      <IdentityBar
        actor={actor}
        active="plan"
        inboxCount={inboxCount}
        viaFallback={viaFallback}
      />

      <main className="mx-auto flex w-full max-w-[1120px] flex-1 flex-col gap-5 px-6 py-10">
        {event && rows.length > 0 ? (
          <>
            <PlanTable rows={rows} title={event.title} budgetCents={event.budgetCents} />

            <BoundaryLog entries={boundary.entries} names={boundary.names} />

            {/* Native disclosure: no JS, and it stays shut during the demo. */}
            <details className="group">
              <summary className="w-fit cursor-pointer list-none rounded-sm px-2.5 py-1.5 font-mono text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                Plan another event
              </summary>
              <div className="pt-3">
                <BriefForm compact />
              </div>
            </details>
          </>
        ) : (
          <BriefForm />
        )}
      </main>
    </>
  );
}
