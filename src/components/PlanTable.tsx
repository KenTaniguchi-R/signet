import type { LineItemStatus } from '@/db';
import { formatCategory, formatCents } from '@/lib/format';
import type { PolicyDecision } from '@/lib/policy';

import { PolicyTrace, type TraceApprover } from './PolicyTrace';
import { ROLE_LABEL } from './Seal';
import { StatusPill } from './StatusPill';

export interface PlanRow {
  id: string;
  category: string;
  vendor: string;
  amountCents: number;
  reversible: boolean;
  status: LineItemStatus;
  decision: PolicyDecision;
  approvers: TraceApprover[];
}

/**
 * Twelve rows, not twelve cards.
 *
 * The beat is seeing nine settle and three halt in a single frame; cards force
 * a scroll and lose it. Halted rows sort to the top and carry both a tinted
 * ground and an ochre stripe, because colour alone will not survive a badly
 * calibrated projector.
 */
export function PlanTable({
  rows,
  title,
  budgetCents,
}: {
  rows: PlanRow[];
  title: string;
  budgetCents: number;
}) {
  const halted = rows.filter((row) => row.decision.requiresApproval);
  const settled = rows.filter((row) => !row.decision.requiresApproval);
  const ordered = [...halted, ...settled];
  const total = rows.reduce((sum, row) => sum + row.amountCents, 0);
  const overBudget = total > budgetCents;

  return (
    <section className="overflow-hidden rounded-sm border border-rule bg-surface">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5 border-b border-rule px-5 py-4">
        <h2 className="font-serif text-xl tracking-[-0.01em]">{title}</h2>
        <span className="font-mono text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint">
          {rows.length} line items · {halted.length} awaiting a human
        </span>
        <span className="ml-auto font-mono text-sm tnum">
          <span className="text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint">
            Budget{' '}
          </span>
          <span className={overBudget ? 'text-stop' : 'text-ink'}>{formatCents(total)}</span>
          <span className="text-ink-faint"> / {formatCents(budgetCents)}</span>
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse">
          <thead>
            <tr>
              {['Line item', 'Vendor', 'Amount', 'Rule', 'State'].map((heading) => (
                <th
                  key={heading}
                  scope="col"
                  className={`border-b border-rule px-3 pb-2.5 pt-3 font-mono text-[0.6875rem] font-normal uppercase tracking-[0.13em] text-ink-faint ${
                    heading === 'Amount' ? 'text-right' : 'text-left'
                  }`}
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.map((row, index) => (
              <PlanRowGroup key={row.id} row={row} index={index} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PlanRowGroup({ row, index }: { row: PlanRow; index: number }) {
  const isHalted = row.decision.requiresApproval;
  const cell = `border-b border-rule-soft px-3 py-2.5 align-baseline ${
    isHalted ? 'bg-halt-tint' : ''
  }`;

  return (
    <>
      <tr className="row-settle" style={{ animationDelay: `${index * 0.04}s` }}>
        <td className={`${cell} ${isHalted ? 'shadow-[inset_3px_0_0_var(--color-halt)]' : ''}`}>
          {/*
            line_items has no label column, so the category carries the name.
            The model already emits `rationale` and it has nowhere to land —
            flagged to the schema owner.
          */}
          <span className="text-ink">{formatCategory(row.category)}</span>
          {!row.reversible && (
            <span className="block text-[0.8125rem] text-halt">Irreversible commitment</span>
          )}
        </td>
        <td className={`${cell} text-[0.8125rem] text-ink-muted`}>{row.vendor}</td>
        <td className={`${cell} text-right font-mono text-[0.8125rem] tnum`}>
          {formatCents(row.amountCents)}
        </td>
        <td
          className={`${cell} font-mono text-[0.6875rem] ${isHalted ? 'text-halt' : 'text-ink-faint'}`}
        >
          {row.decision.ruleName}
        </td>
        <td className={cell}>
          {isHalted ? (
            <StatusPill tone="halt">
              {row.decision.approverRoles.map((role) => ROLE_LABEL[role]).join(' + ')}
            </StatusPill>
          ) : (
            <StatusPill tone="ok">Settled</StatusPill>
          )}
        </td>
      </tr>

      {isHalted && (
        <tr className="row-settle" style={{ animationDelay: `${index * 0.04 + 0.02}s` }}>
          <td colSpan={5} className="border-b border-rule-soft bg-halt-tint px-3 pb-2.5">
            <PolicyTrace decision={row.decision} approvers={row.approvers} />
          </td>
        </tr>
      )}
    </>
  );
}
