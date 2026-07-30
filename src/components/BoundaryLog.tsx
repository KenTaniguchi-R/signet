import type { BoundaryEntry } from '@/lib/queries';

/**
 * Invariant 6, made pointable.
 *
 * `activity` keeps what the model supplied and what the harness resolved in
 * two separate columns. Rendering them side by side turns "nothing on the
 * right came from the left" from a claim into something a judge can read off
 * the screen.
 *
 * One entry is featured at full size — the dual-approval one, because it is
 * where the difference matters most — and the rest are compact. Rendering six
 * full panels would push the plan table off screen, which is the same mistake
 * the policy trace made before it was compacted.
 */

/** Keys the model could never have supplied. These carry the argument. */
const IDENTITY_KEYS = new Set(['approverIds', 'requiredRoles', 'orgId', 'createdBy', 'approvedBy']);

const KIND_LABEL: Record<string, string> = {
  plan_generated: 'Plan generated',
  approval_required: 'Approval required',
  approval_granted: 'Approval granted',
  rejected_unknown_line_item: 'Rejected, unknown line item',
  spend: 'Spend executed',
};

function label(kind: string): string {
  return KIND_LABEL[kind] ?? kind.replace(/[._]/g, ' ');
}

function render(value: unknown, names: Record<string, string> = {}): string {
  if (typeof value === 'string') return names[value] ?? value;
  if (Array.isArray(value)) return value.map((v) => render(v, names)).join('  +  ');
  return JSON.stringify(value) ?? String(value);
}

export function BoundaryLog({
  entries,
  names,
}: {
  entries: BoundaryEntry[];
  names: Record<string, string>;
}) {
  if (entries.length === 0) return null;

  // The dual-approval entry is the sharpest example: two names on the right,
  // none on the left. Fall back to any approval, then to anything at all.
  const featured =
    entries.find(
      (e) =>
        e.kind === 'approval_required' &&
        Array.isArray(e.harnessInjected?.requiredRoles) &&
        (e.harnessInjected.requiredRoles as unknown[]).length > 1,
    ) ??
    entries.find((e) => e.kind === 'approval_required') ??
    entries[0];

  const rest = entries.filter((e) => e.id !== featured.id);

  return (
    <section className="overflow-hidden rounded-sm border border-rule bg-surface">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-rule px-5 py-4">
        <h2 className="font-serif text-xl tracking-[-0.01em]">The boundary</h2>
        <p className="text-sm text-ink-muted">
          What the model said, against what the harness resolved. Nothing in the right column came
          from the left.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-px bg-rule md:grid-cols-2">
        <Side
          heading="What the model proposed"
          column="payload_json"
          data={featured.payload}
          names={names}
          rule="ink-faint"
          note="The tool schema has no field for an approver, an org, or a token. A model emitting arbitrary conforming JSON still cannot name a person."
        />
        <Side
          heading="What the harness resolved"
          column="harness_injected_json"
          data={featured.harnessInjected}
          names={names}
          rule="accent"
          note="Every one of these was read from the policy table and the database, after the fact."
        />
      </div>

      {rest.length > 0 && (
        <ul className="divide-y divide-rule-soft border-t border-rule">
          {rest.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-2.5 font-mono text-[0.8125rem]"
            >
              <span className="tnum text-[0.6875rem] text-ink-faint">
                {entry.createdAt.toISOString().slice(11, 19)}
              </span>
              <span className="text-ink">{label(entry.kind)}</span>
              {entry.actorName && <span className="text-ink-muted">{entry.actorName}</span>}
              {entry.harnessInjected?.ruleName ? (
                <span className="ml-auto text-ink-faint">
                  {render(entry.harnessInjected.ruleName, names)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Side({
  heading,
  column,
  data,
  names,
  rule,
  note,
}: {
  heading: string;
  column: string;
  data: Record<string, unknown> | null;
  names: Record<string, string>;
  rule: 'accent' | 'ink-faint';
  note: string;
}) {
  const isHarness = rule === 'accent';

  return (
    <div
      className={`flex flex-col gap-3 bg-surface p-5 ${
        isHarness ? 'shadow-[inset_0_2px_0_var(--color-accent)]' : 'shadow-[inset_0_2px_0_var(--color-ink-faint)]'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint">
          {heading}
        </span>
        <span className="font-mono text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint">
          {column}
        </span>
      </div>

      <dl className="flex flex-col gap-1.5 overflow-x-auto font-mono text-[0.8125rem] leading-relaxed">
        {data ? (
          Object.entries(data).map(([key, value]) => {
            // The accent appears here and nowhere else on this panel: these are
            // the fields whose provenance is the entire security argument.
            const carries = isHarness && IDENTITY_KEYS.has(key);
            return (
              <div key={key} className="flex flex-wrap gap-x-2">
                <dt className={carries ? 'font-semibold text-accent' : 'text-ink'}>{key}</dt>
                <dd className={carries ? 'text-accent' : 'text-ink-muted'}>
                  {render(value, names).slice(0, 200)}
                </dd>
              </div>
            );
          })
        ) : (
          <span className="text-ink-faint">null</span>
        )}
      </dl>

      <p className="mt-auto max-w-[46ch] font-sans text-[0.8125rem] leading-relaxed text-ink-faint">
        {note}
      </p>
    </div>
  );
}
