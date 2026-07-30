import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NoApproverForRoleError,
  resolveApprovers,
  requireApprover,
  type ApproverLookup,
} from './policy-router.ts';
import type { Role } from '../db/schema.ts';

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

describe('resolveApprovers with injected lookup', () => {
  test('preserves order: roles array pairs with output ids by index', async () => {
    // Use ids that make a transposition visibly fail
    const lookup: ApproverLookup = async (orgId, role) => {
      const map: Record<Role, string> = {
        finance: 'id-100',
        legal: 'id-200',
        ops: 'id-300',
        member: 'id-400',
      };
      return map[role] ?? null;
    };

    const roles: Role[] = ['finance', 'legal', 'ops'];
    const ids = await resolveApprovers('org-1', roles, lookup);

    assert.deepEqual(ids, ['id-100', 'id-200', 'id-300']);
  });

  test('nulls preserve position; does not compact the array', async () => {
    let callCount = 0;
    const lookup: ApproverLookup = async (orgId, role) => {
      callCount++;
      // Return null for 'legal' only
      if (role === 'legal') return null;
      return `id-for-${role}`;
    };

    const roles: Role[] = ['finance', 'legal', 'ops'];
    const ids = await resolveApprovers('org-1', roles, lookup);

    // The null must be at index 1, not compacted away
    assert.deepEqual(ids, ['id-for-finance', null, 'id-for-ops']);
    assert.equal(callCount, 3);
  });

  test('never throws when a role is unfilled', async () => {
    const lookup: ApproverLookup = async () => null; // Always returns null
    const roles: Role[] = ['finance', 'legal', 'ops'];

    // Must not throw
    const ids = await resolveApprovers('org-1', roles, lookup);

    assert.deepEqual(ids, [null, null, null]);
  });

  test('returns empty array for empty roles without calling lookup', async () => {
    let called = false;
    const lookup: ApproverLookup = async () => {
      called = true;
      return 'id-1';
    };

    const ids = await resolveApprovers('org-1', [], lookup);

    assert.deepEqual(ids, []);
    assert.equal(called, false);
  });

  test('calls lookup for each role in order', async () => {
    const callOrder: Role[] = [];
    const lookup: ApproverLookup = async (orgId, role) => {
      callOrder.push(role);
      return `id-${role}`;
    };

    const roles: Role[] = ['legal', 'ops', 'finance'];
    await resolveApprovers('org-1', roles, lookup);

    assert.deepEqual(callOrder, ['legal', 'ops', 'finance']);
  });
});

describe('the tenant boundary', () => {
  // FIX 2: `dbApproverLookup`'s `eq(users.orgId, orgId)` predicate is what
  // stops org A's approvals routing to org B's finance user — but there is
  // no DB in unit tests, so this cannot exercise the real Drizzle query.
  // NOTE: the predicate inside `dbApproverLookup` itself still needs an
  // integration test (one that hits a real or test database) to be covered
  // end to end. What this test CAN prove without a database is the half of
  // the boundary that lives in the calling code: that `resolveApprovers`
  // and `requireApprover` pass `orgId` through to the lookup unchanged,
  // rather than dropping it, swapping it, or substituting some other value.
  // If either function stopped forwarding `orgId` faithfully,
  // `dbApproverLookup`'s org filter would be given the wrong org and every
  // existing test in this file — which all inject an `ApproverLookup` that
  // ignores its `orgId` argument — would stay green.
  test('passes orgId through to the lookup unchanged — the tenant boundary', async () => {
    const calls: { orgId: string; role: Role }[] = [];
    const lookup: ApproverLookup = async (orgId, role) => {
      calls.push({ orgId, role });
      return `id-for-${orgId}-${role}`;
    };

    const roles: Role[] = ['finance', 'legal', 'ops'];
    await resolveApprovers('org-tenant-A', roles, lookup);

    assert.deepEqual(calls, [
      { orgId: 'org-tenant-A', role: 'finance' },
      { orgId: 'org-tenant-A', role: 'legal' },
      { orgId: 'org-tenant-A', role: 'ops' },
    ]);

    calls.length = 0;
    await requireApprover('org-tenant-B', 'legal', lookup);

    assert.deepEqual(calls, [{ orgId: 'org-tenant-B', role: 'legal' }]);
  });
});

describe('requireApprover with injected lookup', () => {
  test('returns the id when lookup succeeds', async () => {
    const lookup: ApproverLookup = async () => 'approver-uuid';
    const id = await requireApprover('org-1', 'finance', lookup);

    assert.equal(id, 'approver-uuid');
  });

  test('throws NoApproverForRoleError when lookup returns null', async () => {
    const lookup: ApproverLookup = async () => null;

    try {
      await requireApprover('org-1', 'finance', lookup);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof NoApproverForRoleError);
      assert.equal((err as NoApproverForRoleError).role, 'finance');
    }
  });

  test('error includes the role and org for debugging on stage', async () => {
    const lookup: ApproverLookup = async () => null;

    try {
      await requireApprover('org-staging-uuid', 'legal', lookup);
      assert.fail('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      assert.ok(message.includes('legal'));
      assert.ok(message.includes('org-staging-uuid'));
    }
  });
});
