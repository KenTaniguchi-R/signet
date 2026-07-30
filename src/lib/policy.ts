import type { Role } from '../db/schema.ts';

/**
 * The policy router.
 *
 * A pure function, deliberately. It takes the two facts about a purchase that
 * determine authority and returns which ROLES must sign off. It never resolves
 * a role to a person: that mapping lives in the `users` table and is done by
 * the harness (invariant 2). A model that fully controls this input still
 * cannot name its own approver, because there is no field here to name one in.
 */

/** Team-lead band opens here. Below this, spend is logged and auto-approved. */
const TEAM_LEAD_FLOOR_CENTS = 20_000; // $200
/** Above this, finance and legal are both required. */
const DUAL_APPROVAL_CEILING_CENTS = 200_000; // $2,000

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

  if (amountCents > DUAL_APPROVAL_CEILING_CENTS) {
    return {
      requiresApproval: true,
      approverRoles: ['finance', 'legal'],
      ruleName: reversible ? 'over_2000_finance_legal' : 'irreversible_over_2000',
    };
  }

  if (amountCents >= TEAM_LEAD_FLOOR_CENTS) {
    return {
      requiresApproval: true,
      // An irreversible commitment always pulls legal in, whatever it costs.
      approverRoles: reversible ? ['ops'] : ['ops', 'legal'],
      ruleName: reversible ? 'band_200_2000_team_lead' : 'irreversible_band_200_2000',
    };
  }

  if (!reversible) {
    return {
      requiresApproval: true,
      approverRoles: ['legal'],
      ruleName: 'irreversible_requires_legal',
    };
  }

  return {
    requiresApproval: false,
    approverRoles: [],
    ruleName: 'auto_approve_under_200',
  };
}
