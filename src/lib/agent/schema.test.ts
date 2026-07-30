import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IDENTITY_FIELDS,
  lineItemIntent,
  planOutput,
  spendInput,
} from './schema.ts';

describe('lineItemIntent', () => {
  test('accepts a well-formed line item', () => {
    const parsed = lineItemIntent.parse({
      category: 'venue',
      vendor: 'Okta HQ 13F',
      amountCents: 280000,
      reversible: false,
      rationale: 'Capacity 60 exceeds the 50-person headcount.',
    });

    assert.equal(parsed.amountCents, 280000);
    assert.equal(parsed.reversible, false);
  });

  test('strips an injected approverId rather than passing it through', () => {
    const parsed = lineItemIntent.parse({
      category: 'venue',
      vendor: 'Okta HQ 13F',
      amountCents: 280000,
      reversible: false,
      rationale: 'x',
      approverId: 'c0ffee00-0000-4000-8000-000000000000',
    });

    assert.equal('approverId' in parsed, false);
  });

  test('rejects a fractional amount', () => {
    assert.equal(
      lineItemIntent.safeParse({
        category: 'drinks',
        vendor: 'Bevmo',
        amountCents: 1999.5,
        reversible: true,
        rationale: 'x',
      }).success,
      false,
    );
  });

  test('rejects a zero or negative amount', () => {
    for (const amountCents of [0, -100]) {
      assert.equal(
        lineItemIntent.safeParse({
          category: 'drinks',
          vendor: 'Bevmo',
          amountCents,
          reversible: true,
          rationale: 'x',
        }).success,
        false,
        `amountCents=${amountCents} must not parse`,
      );
    }
  });

  test('rejects an unknown category', () => {
    assert.equal(
      lineItemIntent.safeParse({
        category: 'bribes',
        vendor: 'x',
        amountCents: 100,
        reversible: true,
        rationale: 'x',
      }).success,
      false,
    );
  });
});

describe('invariant 2 - the schema cannot express an identity', () => {
  // Walk the shape rather than JSON.stringify-ing it: Zod schema objects hold
  // internal references that stringify to {} or throw on a cycle, which would
  // make this guard silently pass on everything.
  function collectKeys(schema: unknown, seen = new Set<string>()): Set<string> {
    const shape = (schema as { shape?: Record<string, unknown> })?.shape;
    if (shape) {
      for (const [key, child] of Object.entries(shape)) {
        seen.add(key);
        collectKeys(child, seen);
      }
    }
    const element = (schema as { element?: unknown })?.element;
    if (element) collectKeys(element, seen);
    return seen;
  }

  test('no identity field appears in any model-facing schema', () => {
    for (const schema of [lineItemIntent, planOutput, spendInput]) {
      const keys = collectKeys(schema);
      for (const field of IDENTITY_FIELDS) {
        assert.ok(
          !keys.has(field),
          `${field} must never appear in a model-facing schema`,
        );
      }
    }
  });

  test('the key walker actually sees nested keys', () => {
    // Guards the guard: if collectKeys returned an empty set the test above
    // would pass vacuously.
    assert.ok(collectKeys(planOutput).has('amountCents'));
  });

  test('lineItemIntent exposes exactly the five intended keys', () => {
    assert.deepEqual(Object.keys(lineItemIntent.shape).sort(), [
      'amountCents',
      'category',
      'rationale',
      'reversible',
      'vendor',
    ]);
  });
});

describe('spendInput', () => {
  test('adds lineItemId and nothing else', () => {
    const extra = Object.keys(spendInput.shape).filter(
      (k) => !(k in lineItemIntent.shape),
    );
    assert.deepEqual(extra, ['lineItemId']);
  });

  test('rejects a lineItemId that is not a uuid', () => {
    assert.equal(
      spendInput.safeParse({
        lineItemId: 'not-a-uuid',
        category: 'venue',
        vendor: 'x',
        amountCents: 100,
        reversible: true,
        rationale: 'x',
      }).success,
      false,
    );
  });
});

describe('planOutput', () => {
  test('requires at least one line item', () => {
    assert.equal(
      planOutput.safeParse({ summary: 'empty', lineItems: [] }).success,
      false,
    );
  });
});
