import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePolicy } from './policy.ts';

/**
 * The policy router is the product. These tests are the spec:
 *
 *   < $200 reversible      auto-approve, logged only
 *   $200 - $2,000          finance
 *   > $2,000               finance
 *   irreversible           finance, regardless of amount
 *
 * The bands still decide WHETHER a purchase halts; in this demo configuration
 * they all resolve to the same role, because the presenter runs the demo from a
 * single finance session and an approval routed elsewhere would be unclearable.
 * See the header of `policy.ts` for what that costs and how to undo it.
 */

describe('resolvePolicy - amount bands', () => {
  test('under $200 auto-approves with no approver', () => {
    const rule = resolvePolicy({ amountCents: 4100, reversible: true });

    assert.equal(rule.requiresApproval, false);
    assert.deepEqual(rule.approverRoles, []);
    assert.equal(rule.ruleName, 'auto_approve_under_200');
  });

  test('exactly $200 crosses out of auto-approve', () => {
    const rule = resolvePolicy({ amountCents: 20000, reversible: true });

    assert.equal(rule.requiresApproval, true);
    assert.deepEqual(rule.approverRoles, ['finance']);
    assert.equal(rule.ruleName, 'band_200_2000_finance');
  });

  test('exactly $2,000 is still the band, not the ceiling rule', () => {
    const rule = resolvePolicy({ amountCents: 200000, reversible: true });

    assert.deepEqual(rule.approverRoles, ['finance']);
    assert.equal(rule.ruleName, 'band_200_2000_finance');
  });

  test('one cent over $2,000 crosses the ceiling', () => {
    const rule = resolvePolicy({ amountCents: 200001, reversible: true });

    assert.equal(rule.requiresApproval, true);
    assert.deepEqual(rule.approverRoles, ['finance']);
    assert.equal(rule.ruleName, 'over_2000_finance');
  });
});

describe('resolvePolicy - irreversible commitments', () => {
  test('irreversible still halts below the auto-approve threshold', () => {
    const rule = resolvePolicy({ amountCents: 4100, reversible: false });

    assert.equal(rule.requiresApproval, true);
    assert.deepEqual(rule.approverRoles, ['finance']);
    assert.equal(rule.ruleName, 'irreversible_requires_finance');
  });

  test('irreversible inside the band names its own rule', () => {
    const rule = resolvePolicy({ amountCents: 164000, reversible: false });

    assert.deepEqual(rule.approverRoles, ['finance']);
    assert.equal(rule.ruleName, 'irreversible_band_200_2000');
  });

  test('the venue contract routes to finance', () => {
    const rule = resolvePolicy({ amountCents: 280000, reversible: false });

    assert.equal(rule.requiresApproval, true);
    assert.deepEqual(rule.approverRoles, ['finance']);
    assert.equal(rule.ruleName, 'irreversible_over_2000');
  });
});

describe('resolvePolicy - the demo must not be blockable', () => {
  /*
   * The load-bearing property of this configuration.
   *
   * `approvals.ts` rejects with 403 unless the actor is the named approver OR
   * the actor's role equals the approval's required role. The presenter holds
   * exactly one role, so any gated item routed to a different role is
   * permanently stuck mid-demo with no recovery. These two tests fail the
   * moment someone reintroduces a second role or a co-signer.
   */
  const DEMO_ROLE = 'finance';

  test('every gated band routes to the presenter, and to nobody else', () => {
    const amounts = [0, 4100, 19999, 20000, 199999, 200000, 200001, 280000];

    for (const amountCents of amounts) {
      for (const reversible of [true, false]) {
        const rule = resolvePolicy({ amountCents, reversible });
        if (!rule.requiresApproval) continue;

        assert.deepEqual(
          rule.approverRoles,
          [DEMO_ROLE],
          `${amountCents} (reversible=${reversible}) routes somewhere the presenter cannot clear`,
        );
      }
    }
  });

  test('no band draws a co-signer', () => {
    // One signature completes a line item. A second required role would mean a
    // second login, which is the thing this configuration exists to avoid.
    const amounts = [4100, 20000, 164000, 200001, 280000];

    for (const amountCents of amounts) {
      for (const reversible of [true, false]) {
        const { approverRoles } = resolvePolicy({ amountCents, reversible });
        assert.ok(
          approverRoles.length <= 1,
          `${amountCents} (reversible=${reversible}) needs ${approverRoles.length} signatures`,
        );
      }
    }
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
