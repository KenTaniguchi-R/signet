import type { Role } from '@/db';
import type { PolicyDecision } from '@/lib/policy';

import { ROLE_LABEL, SEAL_INK } from './Seal';

export interface TraceApprover {
  role: Role;
  displayName: string | null;
}

/**
 * Why this line item stopped, on one line.
 *
 * Inline rather than behind a disclosure, because judges are told the router is
 * the product and the button is not, so the reasoning has to be readable
 * without anyone clicking. But it stays to a SINGLE line: a four-row block was
 * tried first and three of them pushed the settled rows off screen, which
 * destroys the beat this table exists for (nine settle, three halt, one frame).
 *
 * The trailing note is the demo sentence: these names came from the policy
 * table server-side, and the model has no field that could have named them.
 */
export function PolicyTrace({
  decision,
  approvers,
}: {
  decision: PolicyDecision;
  approvers: TraceApprover[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-r-sm border-l-[3px] border-halt bg-halt-tint py-1.5 pl-3 pr-2 font-mono text-[0.8125rem]">
      <span className="text-halt">{decision.ruleName}</span>
      <span aria-hidden="true" className="text-halt">
        &rarr;
      </span>

      {approvers.map((approver, index) => (
        <span key={approver.role} className="flex items-center gap-3">
          {index > 0 && (
            <span aria-hidden="true" className="text-halt">
              +
            </span>
          )}
          <span className={`${SEAL_INK[approver.role]} inline-flex items-center gap-1.5`}>
            <span
              aria-hidden="true"
              className="h-[7px] w-[7px] shrink-0 rounded-full border-[1.5px] border-current"
            />
            <span className="text-ink">
              {approver.displayName ?? 'no user holds this role'}, {ROLE_LABEL[approver.role]}
            </span>
          </span>
        </span>
      ))}

      <span className="ml-auto pl-2 text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint">
        Resolved server side
      </span>
    </div>
  );
}
