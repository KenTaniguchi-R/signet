import { SignedOut } from '@/app/SignedOut';
import { DecisionButtons } from '@/components/DecisionButtons';
import { IdentityBar } from '@/components/IdentityBar';
import { ROLE_LABEL, SEAL_INK } from '@/components/Seal';
import { StatusPill } from '@/components/StatusPill';
import { formatCategory, formatCents } from '@/lib/format';
import { resolveActor } from '@/lib/dev-actor';
import { getInbox, type InboxItem } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const actor = await resolveActor();
  if (!actor) return <SignedOut />;

  const items = await getInbox(actor.userId);

  return (
    <>
      <IdentityBar actor={actor} active="inbox" inboxCount={items.length} />

      <main className="mx-auto flex w-full max-w-[820px] flex-1 flex-col gap-4 px-6 py-10">
        <div className="flex items-baseline gap-3">
          <h1 className="font-serif text-2xl tracking-[-0.01em]">Awaiting you</h1>
          <span className="font-mono text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint">
            Routed to {actor.displayName}, {ROLE_LABEL[actor.role]}
          </span>
        </div>

        {items.length === 0 ? (
          <p className="rounded-sm border border-rule bg-surface px-6 py-14 text-center text-sm text-ink-muted">
            Nothing is waiting on you. Items routed to another role appear in their inbox, not
            yours.
          </p>
        ) : (
          items.map((item) => (
            <ApprovalCard key={item.approvalId} item={item} approverName={actor.displayName} />
          ))
        )}
      </main>
    </>
  );
}

function ApprovalCard({ item, approverName }: { item: InboxItem; approverName: string }) {
  return (
    <article className="flex flex-col gap-3.5 overflow-hidden rounded-sm border border-rule bg-surface p-5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-rule pb-3">
        <h2 className="font-serif text-xl tracking-[-0.01em]">
          {formatCategory(item.category)}, {item.vendor}
        </h2>
        <span className="ml-auto font-mono text-[1.125rem] tnum">
          {formatCents(item.amountCents)}
        </span>
      </div>

      <dl className="flex flex-col gap-2.5 rounded-r-sm border-l-[3px] border-halt bg-halt-tint px-4 py-3.5 font-mono text-[0.8125rem]">
        <Row label="Event">{item.eventTitle}</Row>
        <Row label="Rule">{item.ruleName}</Row>
        {!item.reversible && <Row label="Terms">irreversible commitment</Row>}
        {item.coApprovers.length > 0 && (
          <Row label="Also">
            {item.coApprovers.map((co) => (
              <span key={co.role} className="flex items-center gap-2">
                <span className={`${SEAL_INK[co.role]} inline-flex items-center gap-1.5`}>
                  <span
                    aria-hidden="true"
                    className="h-[7px] w-[7px] rounded-full border-[1.5px] border-current"
                  />
                  <span className="text-ink">
                    {co.displayName ?? 'unassigned'}, {ROLE_LABEL[co.role]}
                  </span>
                </span>
                <StatusPill tone={co.status === 'approved' ? 'ok' : 'halt'}>{co.status}</StatusPill>
              </span>
            ))}
          </Row>
        )}
      </dl>

      <DecisionButtons approvalId={item.approvalId} approverName={approverName} />
    </article>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <dt className="min-w-[74px] text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint">
        {label}
      </dt>
      <dd className="flex flex-wrap items-center gap-3 text-ink">{children}</dd>
    </div>
  );
}
