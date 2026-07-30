import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPlanPrompt } from './plan.ts';

const brief = {
  title: 'Built Different hackathon',
  budgetCents: 500000,
  headcount: 50,
  notes: '8 vegetarian, 3 gluten-free',
};

describe('buildPlanPrompt', () => {
  test('states the budget in dollars, not raw cents', () => {
    const prompt = buildPlanPrompt(brief);
    assert.ok(prompt.includes('$5,000'), 'budget must be human-readable');
    assert.ok(!prompt.includes('500000'), 'raw cents confuse the model');
  });

  test('carries the constraints that make this a planning problem', () => {
    const prompt = buildPlanPrompt(brief);
    assert.ok(prompt.includes('50'), 'headcount drives venue capacity');
    assert.ok(prompt.includes('8 vegetarian, 3 gluten-free'));
  });

  test('never tells the model who approves anything', () => {
    const prompt = buildPlanPrompt(brief).toLowerCase();
    for (const word of ['approver', 'finance', 'legal', 'ops role', 'sato']) {
      assert.ok(
        !prompt.includes(word),
        `prompt must not mention "${word}" — routing is the harness's job`,
      );
    }
  });

  test('omits the notes line entirely when there are no notes', () => {
    const prompt = buildPlanPrompt({ ...brief, notes: undefined });
    assert.ok(!prompt.includes('Additional constraints'));
  });
});
