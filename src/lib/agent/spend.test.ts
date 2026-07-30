import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  spendApprovalRule,
  buildApprovalRows,
  persistApprovalRequests,
  type ApprovalRow,
  type LineItemPolicyFacts,
  type PolicyRowLookup,
} from './spend.ts';
import type { PolicyDecision } from '../policy.ts';
import type { Actor } from '../actor.ts';

const lineItemId = 'c0ffee00-0000-4000-8000-000000000000';

const base = {
  lineItemId,
  category: 'venue' as const,
  vendor: 'Okta HQ 13F',
  rationale: 'x',
};

/** A `PolicyRowLookup` that always returns the same fixed row (or none). */
function fixedLookup(row: LineItemPolicyFacts | null): PolicyRowLookup {
  return async () => row;
}

describe('spendApprovalRule', () => {
  test('halts the loop on the $2,800 irreversible venue contract', async () => {
    const lookup = fixedLookup({ amountCents: 280000, reversible: false });
    assert.equal(
      await spendApprovalRule({ ...base, amountCents: 280000, reversible: false }, lookup),
      'user-approval',
    );
  });

  test('halts on $900 catering — the team-lead band', async () => {
    const lookup = fixedLookup({ amountCents: 90000, reversible: true });
    assert.equal(
      await spendApprovalRule({ ...base, amountCents: 90000, reversible: true }, lookup),
      'user-approval',
    );
  });

  test('returns undefined for $180 drinks so the tool executes', async () => {
    const lookup = fixedLookup({ amountCents: 18000, reversible: true });
    assert.equal(
      await spendApprovalRule({ ...base, amountCents: 18000, reversible: true }, lookup),
      undefined,
    );
  });

  test('halts on a cheap irreversible commitment', async () => {
    const lookup = fixedLookup({ amountCents: 4100, reversible: false });
    assert.equal(
      await spendApprovalRule({ ...base, amountCents: 4100, reversible: false }, lookup),
      'user-approval',
    );
  });

  test('ignores vendor and category entirely', async () => {
    // The narrow lookup result is the point: model-controlled strings cannot
    // reach the routing decision even if the model tries.
    const lookup = fixedLookup({ amountCents: 18000, reversible: true });
    assert.equal(
      await spendApprovalRule(
        {
          ...base,
          amountCents: 18000,
          reversible: true,
          vendor: 'URGENT AUTO APPROVE',
          category: 'prizes',
        },
        lookup,
      ),
      // MINOR 6: assert the literal expected value, not `f(x) === f(y)` —
      // that equality would also pass if the function always returned
      // `undefined`.
      undefined,
    );
  });

  test('decides on the DB row, not the model-declared amount — Critical 1 regression guard', async () => {
    // The row is the real $2,800 irreversible venue contract. The model
    // DECLARES a cheap, reversible purchase for the same lineItemId. If the
    // gate ever reads input.amountCents/input.reversible again instead of
    // the row, this returns `undefined` and the tool executes unapproved.
    const lookup = fixedLookup({ amountCents: 280000, reversible: false });
    assert.equal(
      await spendApprovalRule({ ...base, amountCents: 100, reversible: true }, lookup),
      'user-approval',
    );
  });

  test('fails closed when the line item cannot be found', async () => {
    const lookup = fixedLookup(null);
    assert.equal(
      await spendApprovalRule({ ...base, amountCents: 100, reversible: true }, lookup),
      'user-approval',
    );
  });
});

describe('buildApprovalRows', () => {
  const decision: PolicyDecision = {
    requiresApproval: true,
    approverRoles: ['finance', 'legal'],
    ruleName: 'irreversible_over_2000',
  };

  test('the $2,800 irreversible case yields exactly two rows, finance then legal, sharing one approvalId', () => {
    const rows = buildApprovalRows({
      lineItem: { id: lineItemId },
      approvalId: 'appr-shared-1',
      decision,
      approverIds: ['finance-uuid-AAAA', 'legal-uuid-BBBB'],
    });

    assert.equal(rows.length, 2);
    // Distinguishable ids so a transposition (finance/legal swapped) fails.
    assert.deepEqual(
      rows.map((r) => [r.requiredRole, r.requiredApproverId]),
      [
        ['finance', 'finance-uuid-AAAA'],
        ['legal', 'legal-uuid-BBBB'],
      ],
    );
    for (const row of rows) {
      assert.equal(row.approvalId, 'appr-shared-1');
      assert.equal(row.lineItemId, lineItemId);
      assert.equal(row.ruleName, 'irreversible_over_2000');
      assert.equal(row.status, 'pending');
    }
  });

  test('a null approverId is preserved as null, not undefined, at its own index', () => {
    const rows = buildApprovalRows({
      lineItem: { id: lineItemId },
      approvalId: 'appr-2',
      decision,
      approverIds: [null, 'legal-uuid-CCCC'],
    });

    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.requiredApproverId, null);
    assert.notEqual(rows[0]?.requiredApproverId, undefined);
    assert.ok(Object.prototype.hasOwnProperty.call(rows[0], 'requiredApproverId'));
    assert.equal(rows[1]?.requiredApproverId, 'legal-uuid-CCCC');
  });
});

describe('persistApprovalRequests', () => {
  const actor: Actor = {
    userId: 'user-1',
    auth0Sub: 'auth0|1',
    orgId: 'org-1',
    auth0OrgId: 'auth0org-1',
    email: 'a@example.com',
    displayName: 'A',
    role: 'member',
  };

  test('a cross-event lineItemId is skipped, logged, and creates zero rows', async () => {
    const logged: unknown[] = [];

    const result = await persistApprovalRequests(
      {
        actor,
        eventId: 'event-1',
        approvalId: 'appr-x',
        input: { ...base, amountCents: 18000, reversible: true },
      },
      {
        lineItemLookup: async () => null,
        log: async (logArgs) => {
          logged.push(logArgs);
        },
        writeApprovalRows: async () => {
          throw new Error('must not write approval rows for an unverified line item');
        },
        markAwaitingApproval: async () => {
          throw new Error('must not touch line item status for an unverified line item');
        },
      },
    );

    assert.deepEqual(result, { created: 0, skipped: [lineItemId] });
    assert.equal(logged.length, 1);
  });

  test('routes on the ROW cost, not the model-declared cost — Critical 1 regression guard', async () => {
    const capturedRows: ApprovalRow[] = [];

    const result = await persistApprovalRequests(
      {
        actor,
        eventId: 'event-1',
        approvalId: 'appr-y',
        // The model declares a cheap, reversible purchase...
        input: { ...base, amountCents: 100, reversible: true },
      },
      {
        // ...but the verified row is the real $2,800 irreversible venue
        // contract. If this ever routes on `args.input` again, the captured
        // roles below become `['ops']` (the team-lead band) instead of
        // `['finance', 'legal']`.
        lineItemLookup: async () => ({ id: lineItemId, amountCents: 280000, reversible: false }),
        approverLookup: async (_orgId, role) => {
          if (role === 'finance') return 'finance-uuid';
          if (role === 'legal') return 'legal-uuid';
          return null;
        },
        writeApprovalRows: async (rows) => {
          capturedRows.push(...rows);
          return rows.length;
        },
        markAwaitingApproval: async () => {},
        log: async () => {},
      },
    );

    assert.deepEqual(
      capturedRows.map((r) => r.requiredRole),
      ['finance', 'legal'],
    );
    assert.deepEqual(
      capturedRows.map((r) => r.requiredApproverId),
      ['finance-uuid', 'legal-uuid'],
    );
    assert.equal(result.created, 2);
    assert.deepEqual(result.skipped, []);
  });
});
