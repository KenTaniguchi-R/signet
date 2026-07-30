import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildActivityRow } from './activity.ts';

describe('buildActivityRow', () => {
  test('payload lands in payloadJson and harnessInjected in harnessInjectedJson', () => {
    // Use distinguishable objects so a swap would fail the test
    const payloadData = { from: 'model', value: 'payload' };
    const harnessData = { from: 'harness', value: 'injected' };

    const row = buildActivityRow({
      eventId: 'event-1',
      kind: 'spend',
      payload: payloadData,
      harnessInjected: harnessData,
    });

    assert.deepEqual(row.payloadJson, payloadData);
    assert.deepEqual(row.harnessInjectedJson, harnessData);
  });

  test('omitting payload yields null, not undefined', () => {
    const row = buildActivityRow({
      eventId: 'event-1',
      kind: 'spend',
    });

    assert.equal(row.payloadJson, null);
  });

  test('omitting harnessInjected yields null, not undefined', () => {
    const row = buildActivityRow({
      eventId: 'event-1',
      kind: 'spend',
    });

    assert.equal(row.harnessInjectedJson, null);
  });

  test('omitting actorUserId yields null', () => {
    const row = buildActivityRow({
      eventId: 'event-1',
      kind: 'spend',
    });

    assert.equal(row.actorUserId, null);
  });

  test('actorUserId null coalesces to null', () => {
    const row = buildActivityRow({
      eventId: 'event-1',
      kind: 'spend',
      actorUserId: null,
    });

    assert.equal(row.actorUserId, null);
  });

  test('eventId and kind pass through unchanged', () => {
    const row = buildActivityRow({
      eventId: 'event-abc-123',
      kind: 'approval_granted',
      actorUserId: 'user-xyz',
    });

    assert.equal(row.eventId, 'event-abc-123');
    assert.equal(row.kind, 'approval_granted');
    assert.equal(row.actorUserId, 'user-xyz');
  });

  test('payload and harnessInjected are not swapped', () => {
    // This test catches the specific bug of swapping the two columns
    const payloadData = { type: 'from_model' };
    const harnessData = { type: 'from_server' };

    const row = buildActivityRow({
      eventId: 'event-1',
      kind: 'spend',
      payload: payloadData,
      harnessInjected: harnessData,
    });

    // If the assignment was swapped, this would fail
    assert.equal((row.payloadJson as Record<string, string>).type, 'from_model');
    assert.equal((row.harnessInjectedJson as Record<string, string>).type, 'from_server');
  });
});
