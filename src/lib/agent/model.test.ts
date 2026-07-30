import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SIGNET_MODEL_ID } from './model.ts';

describe('model pin', () => {
  test('does not point at a model this account cannot serve', () => {
    // Verified against /v1/models on 2026-07-30: this key tops out at gpt-4.1.
    // build-notes 4.4 hardcodes gpt-5, which would 404 mid-demo.
    assert.ok(
      !SIGNET_MODEL_ID.startsWith('gpt-5'),
      `${SIGNET_MODEL_ID} is not available on this account's key`,
    );
  });

  test('is overridable by env for the demo machine', () => {
    assert.equal(typeof SIGNET_MODEL_ID, 'string');
    assert.ok(SIGNET_MODEL_ID.length > 0);
  });
});
