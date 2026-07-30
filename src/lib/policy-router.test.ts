import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { NoApproverForRoleError } from './policy-router.ts';

describe('NoApproverForRoleError', () => {
  test('names the role and the org so the failure is actionable on stage', () => {
    const err = new NoApproverForRoleError('legal', 'org-uuid-1');

    assert.ok(err.message.includes('legal'));
    assert.ok(err.message.includes('org-uuid-1'));
    assert.equal(err.role, 'legal');
    assert.equal(err.name, 'NoApproverForRoleError');
  });

  test('is an Error subclass so route handlers can catch it by type', () => {
    assert.ok(new NoApproverForRoleError('finance', 'o') instanceof Error);
  });
});
