import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePolicy } from './policy.ts';

/**
 * The policy router is the product. These tests are the spec:
 *
 *   < $200                 auto-approve, logged only
 *   $200 - $2,000          team lead (ops)
 *   > $2,000               finance AND legal, both required
 *   irreversible           legal, regardless of amount
 */

describe('resolvePolicy - amount bands', () => {
  test('under $200 auto-approves with no approver', () => {
    const rule = resolvePolicy({ amountCents: 4100, reversible: true });

    assert.equal(rule.requiresApproval, false);
    assert.deepEqual(rule.approverRoles, []);
    assert.equal(rule.ruleName, 'auto_approve_under_200');
  });

  test('exactly $200 crosses into the team-lead band', () => {
    const rule = resolvePolicy({ amountCents: 20000, reversible: true });

    assert.equal(rule.requiresApproval, true);
    assert.deepEqual(rule.approverRoles, ['ops']);
    assert.equal(rule.ruleName, 'band_200_2000_team_lead');
  });

  test('exactly $2,000 is still the team lead, not finance', () => {
    const rule = resolvePolicy({ amountCents: 200000, reversible: true });

    assert.deepEqual(rule.approverRoles, ['ops']);
    assert.equal(rule.ruleName, 'band_200_2000_team_lead');
  });

  test('one cent over $2,000 requires finance and legal together', () => {
    const rule = resolvePolicy({ amountCents: 200001, reversible: true });

    assert.equal(rule.requiresApproval, true);
    assert.deepEqual(rule.approverRoles, ['finance', 'legal']);
    assert.equal(rule.ruleName, 'over_2000_finance_legal');
  });
});

describe('resolvePolicy - irreversible commitments', () => {
  test('irreversible pulls in legal even below the auto-approve threshold', () => {
    const rule = resolvePolicy({ amountCents: 4100, reversible: false });

    assert.equal(rule.requiresApproval, true);
    assert.deepEqual(rule.approverRoles, ['legal']);
    assert.equal(rule.ruleName, 'irreversible_requires_legal');
  });

  test('irreversible inside the team-lead band adds legal to the team lead', () => {
    const rule = resolvePolicy({ amountCents: 164000, reversible: false });

    assert.deepEqual(rule.approverRoles, ['ops', 'legal']);
    assert.equal(rule.ruleName, 'irreversible_band_200_2000');
  });

  test('the venue contract routes to finance and legal', () => {
    const rule = resolvePolicy({ amountCents: 280000, reversible: false });

    assert.equal(rule.requiresApproval, true);
    assert.deepEqual(rule.approverRoles, ['finance', 'legal']);
    assert.equal(rule.ruleName, 'irreversible_over_2000');
  });
});

describe('resolvePolicy - invariants', () => {
  test('never routes to the default member role', () => {
    const amounts = [0, 4100, 19999, 20000, 199999, 200000, 200001, 280000];

    for (const amountCents of amounts) {
      for (const reversible of [true, false]) {
        const rule = resolvePolicy({ amountCents, reversible });
        assert.ok(
          !rule.approverRoles.includes('member'),
          `member must never hold authority (${amountCents}, reversible=${reversible})`,
        );
      }
    }
  });

  test('returns roles only, never a resolved identity', () => {
    // Invariant 2: the router decides WHETHER and WHICH ROLE.
    // Mapping a role to a person is the harness's job, against the DB.
    // If someone adds approverId here, this test fails and they have to
    // explain why the identity is being decided outside the DB.
    const rule = resolvePolicy({ amountCents: 280000, reversible: false });

    assert.deepEqual(Object.keys(rule).sort(), [
      'approverRoles',
      'requiresApproval',
      'ruleName',
    ]);
  });

  test('is a pure function - same input, same result object', () => {
    const input = { amountCents: 280000, reversible: false } as const;

    assert.deepEqual(resolvePolicy(input), resolvePolicy(input));
  });
});

describe('resolvePolicy - malformed input', () => {
  test('rejects a negative amount rather than auto-approving it', () => {
    assert.throws(
      () => resolvePolicy({ amountCents: -500, reversible: true }),
      /amountCents/,
    );
  });

  test('rejects a fractional amount', () => {
    assert.throws(
      () => resolvePolicy({ amountCents: 1999.5, reversible: true }),
      /amountCents/,
    );
  });

  test('rejects a non-finite amount', () => {
    assert.throws(
      () => resolvePolicy({ amountCents: Number.NaN, reversible: true }),
      /amountCents/,
    );
  });
});
