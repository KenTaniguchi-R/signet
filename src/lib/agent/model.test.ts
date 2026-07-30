import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SIGNET_MODEL_ID, resolveModelId } from './model.ts';

describe('model pin', () => {
  test('does not point at a model this account cannot serve', () => {
    // Verified against /v1/models on 2026-07-30: this key tops out at gpt-4.1.
    // build-notes 4.4 hardcodes gpt-5, which would 404 mid-demo.
    assert.ok(
      !SIGNET_MODEL_ID.startsWith('gpt-5'),
      `${SIGNET_MODEL_ID} is not available on this account's key`,
    );
  });

  test('resolveModelId defaults to gpt-4.1 when env is not set', () => {
    const result = resolveModelId({});
    assert.equal(result, 'gpt-4.1');
  });

  test('resolveModelId is overridable by env var', () => {
    const result = resolveModelId({ SIGNET_MODEL_ID: 'gpt-4-turbo' });
    assert.equal(result, 'gpt-4-turbo');
  });
});
