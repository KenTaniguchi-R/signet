'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Demo beat 1: the brief goes in, the plan comes out.
 *
 * Posts to POST /api/events/plan, owned by the agent side. Contract:
 *
 *   request   { brief: string, budgetCents: number }
 *   response  2xx on success (body unused — the page re-reads from the DB)
 *             non-2xx with { error: string } on failure
 *
 * The event title is derived server-side from `planOutput.summary` rather than
 * typed here, because every field on this form is a field the presenter has to
 * fill in live on stage.
 */
export function BriefForm({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [brief, setBrief] = useState('');
  const [budget, setBudget] = useState('5000');
  const [state, setState] = useState<'idle' | 'planning'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setState('planning');

    try {
      const response = await fetch('/api/events/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brief: brief.trim(),
          budgetCents: Math.round(Number(budget) * 100),
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(
          body?.error ??
            (response.status === 404
              ? 'POST /api/events/plan does not exist yet.'
              : `Planning failed (${response.status}).`),
        );
      }

      setBrief('');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Planning failed.');
    } finally {
      setState('idle');
    }
  }

  const planning = state === 'planning';
  const canSubmit = brief.trim().length > 0 && Number(budget) > 0 && !planning;

  return (
    <form
      onSubmit={onSubmit}
      className={`flex flex-col gap-4 rounded-sm border border-rule bg-surface ${
        compact ? 'p-5' : 'px-6 py-7'
      }`}
    >
      {!compact && (
        <div className="flex flex-col gap-1.5">
          <h2 className="font-serif text-2xl tracking-[-0.01em]">What are you planning?</h2>
          <p className="max-w-[58ch] text-sm leading-relaxed text-ink-muted">
            The agent decomposes this into line items under the budget. Anything a policy rule
            stops is routed to the person who holds authority over it.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <label htmlFor="brief" className="font-mono text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint">
          Brief
        </label>
        <textarea
          id="brief"
          name="brief"
          rows={compact ? 3 : 4}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          disabled={planning}
          placeholder="A one-day hackathon for 60 people at our SF office. Need the floor, lunch, drinks, AV for a demo stage, and prizes for three placements. 8 vegetarian, 3 gluten free."
          className="resize-y rounded-sm border border-rule bg-paper px-3.5 py-3 text-[0.9375rem] leading-relaxed text-ink placeholder:text-ink-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-60"
        />
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="budget" className="font-mono text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint">
            Budget (USD)
          </label>
          <input
            id="budget"
            name="budget"
            type="number"
            min="1"
            step="1"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            disabled={planning}
            className="tnum w-36 rounded-sm border border-rule bg-paper px-3.5 py-2.5 font-mono text-[0.9375rem] text-ink focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-60"
          />
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-sm bg-accent px-5 py-2.5 text-[0.8125rem] font-semibold text-white transition-transform active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          {planning ? 'Planning…' : 'Plan this'}
        </button>

        {/*
          Inline pending text, never a skeleton grid. During a live demo a
          shimmering placeholder is indistinguishable from a hang.
        */}
        {planning && (
          <span className="font-mono text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint">
            The model is allocating the budget
          </span>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-r-sm border-l-[3px] border-stop bg-stop-tint px-3.5 py-2.5 font-mono text-[0.8125rem] text-stop"
        >
          {error}
        </p>
      )}
    </form>
  );
}
