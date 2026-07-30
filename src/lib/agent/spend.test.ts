import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EventNotInOrgError,
  spendApprovalRule,
  buildApprovalRows,
  persistApprovalRequests,
  type ApprovalRow,
  type LineItemPolicyFacts,
  type PolicyRowLookup,
  type PersistApprovalRequestsDeps,
} from './spend.ts';
import type { PolicyDecision } from '../policy.ts';
import type { Actor } from '../actor.ts';

describe('EventNotInOrgError', () => {
  test('is an Error subclass', () => {
    const err = new EventNotInOrgError('event-1', 'org-1');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof EventNotInOrgError);
  });

  test('sets the name property to EventNotInOrgError', () => {
    const err = new EventNotInOrgError('event-1', 'org-1');
    assert.equal(err.name, 'EventNotInOrgError');
  });

  test('includes eventId and orgId in the message', () => {
    const err = new EventNotInOrgError('event-abc', 'org-xyz');
    assert.ok(err.message.includes('event-abc'));
    assert.ok(err.message.includes('org-xyz'));
  });

  test('instanceof discriminates from a plain Error with the same message', () => {
    const typedErr = new EventNotInOrgError('event-1', 'org-1');
    const plainErr = new Error(`Event event-1 does not belong to org org-1`);

    assert.ok(typedErr instanceof EventNotInOrgError);
    assert.ok(!(plainErr instanceof EventNotInOrgError));
  });
});

const lineItemId = 'c0ffee00-0000-4000-8000-000000000000';

const base = {
  lineItemId,
  category: 'venue' as const,
  vendor: 'Okta HQ 13F',
  rationale: 'x',
};

/**
 * A `PolicyRowLookup` keyed on the id it is given, returning `row` only when
 * asked for `lineItemId` (the fixture's canonical id) and `null` for anything
 * else — including anything falsy/empty. FIX 4: the previous version ignored
 * its `lineItemId` argument entirely, so a gate that looked up the WRONG id
 * would still pass every test in this describe block; this version fails
 * closed on a wrong id the same way `defaultPolicyRowLookup` would.
 */
function fixedLookup(row: LineItemPolicyFacts | null): PolicyRowLookup {
  return async (requestedId) => (requestedId === lineItemId ? row : null);
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

  // FIX 4: renamed from "a cross-event lineItemId is skipped, logged, and
  // creates zero rows" — the injected `lineItemLookup` below returned `null`
  // unconditionally, without inspecting `eventId`, so the original test only
  // proved the null branch of `persistApprovalRequests` behaves correctly.
  // It said nothing about scoping: a lookup that ignored `eventId` entirely
  // (and so could leak a line item across events) would have passed just as
  // well. This version asserts the lookup actually receives the `eventId`
  // that was passed in, so a lookup that dropped or mangled the scope
  // argument would fail here even though it still returns `null`.
  test('an unverified lineItemId is skipped, logged, and creates zero rows — the lookup receives the scoping eventId', async () => {
    const logged: unknown[] = [];

    const result = await persistApprovalRequests(
      {
        actor,
        eventId: 'event-1',
        approvalId: 'appr-x',
        input: { ...base, amountCents: 18000, reversible: true },
      },
      {
        lineItemLookup: async (requestedLineItemId, requestedEventId) => {
          assert.equal(requestedLineItemId, lineItemId);
          assert.equal(requestedEventId, 'event-1');
          return null;
        },
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

  test('a verified row that does not actually require approval is logged and skipped, never written — Fix 3 fail-loud guard', async () => {
    // This branch should be unreachable in production: `persistApprovalRequests`
    // only runs after the tool-approval gate already halted on this same row,
    // which only happens when `resolvePolicy` said approval was required.
    // This test exercises it directly anyway, since it's easy to construct via
    // the injected `lineItemLookup` and it's the exact code this fix added.
    const logged: unknown[] = [];

    const result = await persistApprovalRequests(
      {
        actor,
        eventId: 'event-1',
        approvalId: 'appr-z',
        input: { ...base, amountCents: 100, reversible: true },
      },
      {
        // $1.00, reversible — well under the auto-approve floor.
        lineItemLookup: async () => ({ id: lineItemId, amountCents: 100, reversible: true }),
        log: async (logArgs) => {
          logged.push(logArgs);
        },
        writeApprovalRows: async () => {
          throw new Error('must not write approval rows when no approval is required');
        },
        markAwaitingApproval: async () => {
          throw new Error('must not touch line item status when no approval is required');
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

  test('a re-run after settlement does not regress a charged line item — Fix 1 regression guard', async () => {
    // No DB in unit tests, so `defaultMarkAwaitingApproval`'s
    // `eq(lineItems.status, 'proposed')` guard can't be exercised directly.
    // This models it with an in-memory store via the injected
    // `markAwaitingApproval`/`writeApprovalRows` seam: a status transition
    // only applies from `proposed`, and the approvals unique index means a
    // replay creates zero new rows for a role pair that already exists —
    // exactly the shape `onConflictDoNothing()` produces in production.
    let status: 'proposed' | 'awaiting_approval' | 'charged' = 'proposed';
    const existingRoles = new Set<string>();

    const deps: PersistApprovalRequestsDeps = {
      lineItemLookup: async () => ({ id: lineItemId, amountCents: 280000, reversible: false }),
      approverLookup: async (_orgId, role) => `${role}-uuid`,
      writeApprovalRows: async (rows) => {
        let created = 0;
        for (const row of rows) {
          if (!existingRoles.has(row.requiredRole)) {
            existingRoles.add(row.requiredRole);
            created++;
          }
        }
        return created;
      },
      markAwaitingApproval: async () => {
        if (status === 'proposed') status = 'awaiting_approval';
      },
      log: async () => {},
    };

    const args = {
      actor,
      eventId: 'event-1',
      approvalId: 'appr-rerun',
      input: { ...base, amountCents: 100, reversible: true }, // ignored — the row wins
    };

    // First run: finance and legal rows are created, the item moves to
    // awaiting_approval.
    const first = await persistApprovalRequests(args, deps);
    assert.equal(first.created, 2);
    assert.equal(status, 'awaiting_approval');

    // Finance and legal approve; the harness charges the item — external to
    // persistApprovalRequests, simulating `recordDecision`.
    status = 'charged';

    // Presenter re-runs the spend phase. The gate re-fires on the same
    // lineItemId; both (lineItemId, requiredRole) pairs already exist.
    const second = await persistApprovalRequests(args, deps);

    assert.equal(second.created, 0, 'the replay must not create duplicate approval rows');
    assert.equal(
      status,
      'charged',
      'a charged line item must not be flipped back to awaiting_approval by a gate replay',
    );
  });
});
