import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { planRowState } from './plan-state.ts';

/**
 * The State column's spec. The rule under test is the one the plan page got
 * wrong: `requiresApproval` is re-derived from a pure function, so it says
 * nothing about whether anything has HAPPENED. Only `status` does.
 */

describe('planRowState - before the spend phase runs', () => {
  test('a sub-$200 row that has not been executed is not settled', () => {
    const state = planRowState({ status: 'proposed', requiresApproval: false });

    assert.deepEqual(state, { pill: 'text', tone: 'idle', label: 'Proposed' });
  });

  test('a gated row that has not been executed previews its approvers', () => {
    const state = planRowState({ status: 'proposed', requiresApproval: true });

    assert.deepEqual(state, { pill: 'roles', tone: 'halt' });
  });
});

describe('planRowState - after the spend phase runs', () => {
  test('an auto-approved row is settled', () => {
    const state = planRowState({ status: 'auto_approved', requiresApproval: false });

    assert.deepEqual(state, { pill: 'text', tone: 'ok', label: 'Settled' });
  });

  test('a row waiting on a human still names the roles it is waiting on', () => {
    const state = planRowState({ status: 'awaiting_approval', requiresApproval: true });

    assert.deepEqual(state, { pill: 'roles', tone: 'halt' });
  });

  test('a charged row reads as charged, not as blocked', () => {
    const state = planRowState({ status: 'charged', requiresApproval: true });

    assert.deepEqual(state, { pill: 'text', tone: 'ok', label: 'Charged' });
  });

  test('a declined row reads as declined, not as still awaiting a human', () => {
    const state = planRowState({ status: 'declined', requiresApproval: true });

    assert.deepEqual(state, { pill: 'text', tone: 'stop', label: 'Declined' });
  });
});
