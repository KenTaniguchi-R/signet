import { SignedOut } from '@/app/SignedOut';
import { BriefForm } from '@/components/BriefForm';
import { IdentityBar } from '@/components/IdentityBar';
import { resolveActor } from '@/lib/dev-actor';
import { getInboxCount } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * Demo beat 1 opens here. The brief is a real value on the form rather than a
 * placeholder, so the presenter submits instead of types — but it stays
 * editable, so a judge asking "what if it were a different event?" gets an
 * answer live rather than a promise.
 */
export default async function NewEventPage() {
  const resolved = await resolveActor();
  if (!resolved) return <SignedOut />;
  const { actor, viaFallback } = resolved;

  const inboxCount = await getInboxCount(actor.userId);

  return (
    <>
      <IdentityBar
        actor={actor}
        active="new"
        inboxCount={inboxCount}
        viaFallback={viaFallback}
      />

      <main className="mx-auto flex w-full max-w-[1120px] flex-1 flex-col gap-5 px-6 py-10">
        <BriefForm />
      </main>
    </>
  );
}
