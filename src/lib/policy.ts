import type { Role } from '../db/schema.ts';

/**
 * The policy router.
 *
 * A pure function, deliberately. It takes the two facts about a purchase that
 * determine authority and returns which ROLES must sign off. It never resolves
 * a role to a person: that mapping lives in the `users` table and is done by
 * the harness (invariant 2). A model that fully controls this input still
 * cannot name its own approver, because there is no field here to name one in.
 *
 * DEMO CONFIGURATION — every gated band routes to `finance`, and no band draws
 * a co-signer. The presenter runs the whole demo from one session, and the 403
 * in `approvals.ts` is role-based: an approval routed to `ops` or `legal` is
 * unclearable by a finance session, and there is no way to be two people at
 * once. Routing everything to one role is what makes the demo un-blockable.
 *
 * What this costs: the routing DIMENSION is degenerate here — every gated rule
 * returns the same role, so "routes to whoever holds authority" is narrated
 * rather than shown. The GATING dimension is unaffected and is what the demo
 * actually displays: three items halt, nine auto-approve, and the band that
 * fired is named in the audit log.
 *
 * To restore multi-role routing, give the gated branches their real roles back
 * — `['finance', 'legal']` over the ceiling, `['ops']` in the band, `['legal']`
 * for a sub-band irreversible — and rename the rules to match. Nothing else in
 * the codebase needs to change: the co-approval gate in `approvals.ts` and the
 * multi-role plumbing in `policy-router.ts` are intact and still tested.
 */

/** Approval band opens here. Below this, spend is logged and auto-approved. */
const TEAM_LEAD_FLOOR_CENTS = 20_000; // $200
/** Above this, the purchase is a contract-scale commitment rather than a buy. */
const APPROVAL_CEILING_CENTS = 200_000; // $2,000

export interface PolicyInput {
  amountCents: number;
  reversible: boolean;
}

export interface PolicyDecision {
  requiresApproval: boolean;
  /** Every role listed must approve. Order is the order they are asked. */
  approverRoles: Role[];
  /** The rule that fired. Written to `activity.harness_injected_json`. */
  ruleName: string;
}

export function resolvePolicy({ amountCents, reversible }: PolicyInput): PolicyDecision {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new RangeError(`amountCents must be a non-negative integer, received ${amountCents}`);
  }

  if (amountCents > APPROVAL_CEILING_CENTS) {
    return {
      requiresApproval: true,
      approverRoles: ['finance'],
      ruleName: reversible ? 'over_2000_finance' : 'irreversible_over_2000',
    };
  }

  if (amountCents >= TEAM_LEAD_FLOOR_CENTS) {
    return {
      requiresApproval: true,
      approverRoles: ['finance'],
      ruleName: reversible ? 'band_200_2000_finance' : 'irreversible_band_200_2000',
    };
  }

  // An irreversible commitment needs a signature whatever it costs — an
  // unwindable $40 is a smaller risk than a $40 nobody can claw back.
  if (!reversible) {
    return {
      requiresApproval: true,
      approverRoles: ['finance'],
      ruleName: 'irreversible_requires_finance',
    };
  }

  return {
    requiresApproval: false,
    approverRoles: [],
    ruleName: 'auto_approve_under_200',
  };
}
