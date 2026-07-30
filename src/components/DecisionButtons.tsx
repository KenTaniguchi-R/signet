'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

interface Props {
  approvalId: string;
  approverName: string;
}

/**
 * Note that neither handler sends an identity. The body is empty — the server
 * resolves who is approving from the session. A crafted request cannot name
 * someone else.
 */
export function DecisionButtons({ approvalId, approverName }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(action: 'approve' | 'decline') {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/approvals/${approvalId}/${action}`, { method: 'POST' });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          body && typeof body === 'object' && 'error' in body
            ? String((body as { error: unknown }).error)
            : `Request failed (${res.status})`;
        setError(message);
        return;
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null || pending;

  return (
    <div className="flex flex-col gap-2 pt-0.5">
      <div className="flex gap-2.5">
        {/*
          The label names the person. "Approve" alone is ambiguous on a shared
          screen, and whose authority is being exercised is the entire point.
        */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => send('approve')}
          className="rounded-sm bg-accent px-4.5 py-2.5 text-[0.8125rem] font-semibold text-white transition-transform active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-55"
        >
          {busy === 'approve' ? 'Signing…' : `Approve as ${approverName}`}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => send('decline')}
          className="rounded-sm border border-rule px-4.5 py-2.5 text-[0.8125rem] font-semibold text-ink-muted transition-transform active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-55"
        >
          {busy === 'decline' ? 'Declining…' : 'Decline'}
        </button>
      </div>
      {error && <p className="font-mono text-[0.75rem] text-halt">{error}</p>}
    </div>
  );
}
