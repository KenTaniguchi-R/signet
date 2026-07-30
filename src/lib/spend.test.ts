import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { simulateCard } from './spend.ts';

/**
 * The simulated card stands in for a real Issuing card while this Stripe
 * sandbox cannot create one. These tests pin the properties that keep it
 * honest and demo-safe — not its cosmetics.
 */
describe('simulateCard', () => {
  it('is deterministic in the line item id', () => {
    // A retry must show the SAME card, not appear to issue a second one.
    const a = simulateCard('11111111-2222-3333-4444-555555555555');
    const b = simulateCard('11111111-2222-3333-4444-555555555555');
    assert.deepEqual(a, b);
  });

  it('gives different line items different cards', () => {
    const a = simulateCard('11111111-2222-3333-4444-555555555555');
    const b = simulateCard('99999999-8888-7777-6666-555555555555');
    assert.notEqual(a.last4, b.last4);
  });

  it('always returns exactly four digits', () => {
    // Padding matters: a hash landing under 1000 must not render as "42".
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'line-item-0', 'x'.repeat(64)]) {
      const { last4 } = simulateCard(id);
      assert.match(last4, /^\d{4}$/, `bad last4 ${last4} for ${id}`);
    }
  });

  it('uses a stable expiry that does not drift with the clock', () => {
    // The card face must not change midway through a demo.
    assert.match(simulateCard('anything').exp, /^\d{2}\/\d{2}$/);
    assert.equal(simulateCard('anything').exp, simulateCard('other').exp);
  });
});
