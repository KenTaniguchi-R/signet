'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

interface Props {
  eventId: string;
  /** How many line items are still `proposed` — i.e. the model has not been asked to commit them yet. */
  proposedCount: number;
}

interface SpendResult {
  approvalsCreated: number;
  autoApproved: number;
}

/**
 * Demo beat 2: the harness routes what the model proposed.
 *
 * Deliberately a SECOND click rather than a tail on `POST /api/events/plan`.
 * The gap between "the model wrote a plan" and "the harness decided who has to
 * sign" is the pitch; collapsing both into one button hides the boundary and
 * puts two sequential LLM calls behind a single press with nothing on screen.
 *
 *   POST /api/events/[id]/spend
 *   response  200 { approvalsCreated, autoApproved }
 *             non-2xx with { error: string }
 *
 * No body. Like `DecisionButtons`, this sends no identity — the route resolves
 * the actor from the session and the approvers from the policy table.
 *
 * Re-clicking is safe. The approvals insert is `onConflictDoNothing` and both
 * status transitions are guarded on `status = 'proposed'`
 * (src/lib/agent/spend.ts), so a replay writes nothing rather than regressing a
 * charged row.
 */
export function ExecuteSpend({ eventId, proposedCount }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SpendResult | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/events/${eventId}/spend`, { method: 'POST' });
      const body: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        const message =
          body && typeof body === 'object' && 'error' in body
            ? String((body as { error: unknown }).error)
            : `Request failed (${res.status})`;
        setError(message);
        return;
      }

      setResult(body as SpendResult);
      startTransition(() => router.refresh());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Network error');
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || pending;
  /*
   * The spend loop halts at the first step carrying an approval request, so the
   * model may not reach every item in one run (src/lib/agent/spend.ts:418).
   * Show the covered count against the proposed count rather than a bare "done"
   * — if they disagree, another click finishes the rest, and finding that out
   * here beats finding it out in an empty inbox.
   */
  const covered = result ? result.approvalsCreated + result.autoApproved : 0;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={disabled}
        onClick={run}
        className="rounded-sm bg-accent px-5 py-2.5 text-[0.8125rem] font-semibold text-white transition-transform active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? 'Routing…' : `Execute ${proposedCount} line items`}
      </button>

      {/* Inline pending text, never a skeleton — a shimmer reads as a hang on stage. */}
      {disabled && (
        <span className="font-mono text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint">
          The harness is resolving approvers
        </span>
      )}

      {!disabled && result && (
        <span className="font-mono text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint">
          {result.autoApproved} settled · {result.approvalsCreated} routed to a human
          {covered < proposedCount && ` · ${proposedCount - covered} not reached, run again`}
        </span>
      )}

      {error && (
        <p
          role="alert"
          className="w-full rounded-r-sm border-l-[3px] border-stop bg-stop-tint px-3.5 py-2.5 font-mono text-[0.8125rem] text-stop"
        >
          {error}
        </p>
      )}
    </div>
  );
}
