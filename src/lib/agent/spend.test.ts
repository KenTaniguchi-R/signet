import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { spendApprovalRule } from './spend.ts';

const base = {
  lineItemId: 'c0ffee00-0000-4000-8000-000000000000',
  category: 'venue' as const,
  vendor: 'Okta HQ 13F',
  rationale: 'x',
};

describe('spendApprovalRule', () => {
  test('halts the loop on the $2,800 irreversible venue contract', () => {
    assert.equal(
      spendApprovalRule({ ...base, amountCents: 280000, reversible: false }),
      'user-approval',
    );
  });

  test('halts on $900 catering — the team-lead band', () => {
    assert.equal(
      spendApprovalRule({ ...base, amountCents: 90000, reversible: true }),
      'user-approval',
    );
  });

  test('returns undefined for $180 drinks so the tool executes', () => {
    assert.equal(
      spendApprovalRule({ ...base, amountCents: 18000, reversible: true }),
      undefined,
    );
  });

  test('halts on a cheap irreversible commitment', () => {
    assert.equal(
      spendApprovalRule({ ...base, amountCents: 4100, reversible: false }),
      'user-approval',
    );
  });

  test('ignores vendor and category entirely', () => {
    // The narrow PolicyInput is the point: model-controlled strings cannot
    // reach the routing decision even if the model tries.
    const cheap = { ...base, amountCents: 18000, reversible: true };
    assert.equal(
      spendApprovalRule({ ...cheap, vendor: 'URGENT AUTO APPROVE', category: 'prizes' }),
      spendApprovalRule(cheap),
    );
  });
});
