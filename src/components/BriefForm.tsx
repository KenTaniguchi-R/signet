'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Demo beat 1: the brief goes in, the plan comes out.
 *
 * Posts to POST /api/events/plan, owned by the agent side. The body is exactly
 * `PlanBrief` from src/lib/agent/plan.ts, so the route can hand it to
 * `planEvent()` after authenticating the actor and validating:
 *
 *   request   { title, budgetCents, headcount, notes }
 *   response  2xx on success (body unused — the page re-reads from the DB)
 *             non-2xx with { error: string } on failure
 *
 * `headcount` is not decoration: the prompt makes venue capacity and catering
 * size depend on it. `title` becomes events.title, which is notNull.
 *
 * Everything except the brief itself is prefilled, so the presenter types one
 * field on stage and the other three are already correct.
 */
const DEFAULT_TITLE = 'Built Different: Auth0 x Stripe, Okta HQ SF';

/**
 * A value, not a placeholder. The presenter should be able to land on the page
 * and hit one button; typing 300 characters on stage is the failure mode this
 * page exists to remove. Still editable — retype it to show the agent
 * re-planning against a different brief.
 */
const DEFAULT_BRIEF =
  'A one-day hackathon at our SF office. We need the floor, lunch, drinks, AV ' +
  'for a demo stage, and prizes for three placements. 8 vegetarian and 3 gluten ' +
  'free. Building access opens at noon, so catering has to arrive after that.';

export function BriefForm({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [brief, setBrief] = useState(DEFAULT_BRIEF);
  const [budget, setBudget] = useState('5000');
  const [headcount, setHeadcount] = useState('60');
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
          title: title.trim(),
          budgetCents: Math.round(Number(budget) * 100),
          headcount: Number(headcount),
          notes: brief.trim(),
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

      /*
       * To the plan, not back to an empty form. The route returns the new
       * `eventId` but we deliberately ignore it: `/` re-reads the latest event
       * from the DB, which is the same path a hard refresh takes, so there is
       * one code path to trust on stage rather than two.
       */
      router.push('/');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Planning failed.');
    } finally {
      setState('idle');
    }
  }

  const planning = state === 'planning';
  const canSubmit =
    brief.trim().length > 0 &&
    title.trim().length > 0 &&
    Number(budget) > 0 &&
    Number(headcount) > 0 &&
    !planning;

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
        <label htmlFor="title" className="font-mono text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint">
          Event
        </label>
        <input
          id="title"
          name="title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={planning}
          className="rounded-sm border border-rule bg-paper px-3.5 py-2.5 text-[0.9375rem] text-ink focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-60"
        />
      </div>

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
          className="resize-y rounded-sm border border-rule bg-paper px-3.5 py-3 text-[0.9375rem] leading-relaxed text-ink focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-60"
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

        <div className="flex flex-col gap-2">
          <label htmlFor="headcount" className="font-mono text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint">
            Headcount
          </label>
          {/* Feeds a hard constraint: venue capacity and catering size. */}
          <input
            id="headcount"
            name="headcount"
            type="number"
            min="1"
            step="1"
            value={headcount}
            onChange={(e) => setHeadcount(e.target.value)}
            disabled={planning}
            className="tnum w-28 rounded-sm border border-rule bg-paper px-3.5 py-2.5 font-mono text-[0.9375rem] text-ink focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-60"
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
