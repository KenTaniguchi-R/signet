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

  /**
   * A planner that knows who approves what, or where the approval
   * thresholds sit, will plan around them — the entire point of routing
   * approval decisions through a separate, after-the-fact policy function
   * is that the model never gets a chance to game it. This list is the
   * only automated guard on that property, so widen it rather than trim
   * it: "approv" is a stem match that covers approve/approval/approver/
   * approved in one entry, and the rest cover synonyms for the gate
   * (sign-off, authorize, escalate), role names the policy table can
   * route to, and vocabulary a prompt author might reach for instead of
   * the word "approve" (threshold, limit requires).
   */
  const FORBIDDEN_ROUTING_WORDS = [
    'approv', // approve / approval / approver / approved
    'sign-off',
    'signoff',
    'authorize',
    'authorise',
    'escalate',
    'finance',
    'legal',
    'ops role',
    'team lead',
    'manager',
    'director',
    'cfo',
    'controller',
    'threshold',
    'limit requires',
    'sato',
  ];

  test('never tells the model who approves anything', () => {
    const prompt = buildPlanPrompt(brief).toLowerCase();
    for (const word of FORBIDDEN_ROUTING_WORDS) {
      assert.ok(
        !prompt.includes(word),
        `prompt must not mention "${word}" — routing is the harness's job`,
      );
    }
  });

  test('never reveals the dollar amounts that gate approval', () => {
    // The real policy bands sit at $200 and $2,000 (20000 / 200000 cents).
    // The prompt legitimately contains the *budget* ($5,000 for this
    // fixture) and the headcount, so this checks for the specific
    // threshold values rather than banning numbers outright.
    const prompt = buildPlanPrompt(brief);
    for (const leak of ['$200', '$2,000', '$2000', '20000', '200000']) {
      assert.ok(
        !prompt.includes(leak),
        `prompt must not mention "${leak}" — it reveals a policy threshold`,
      );
    }
  });

  test('omits the notes line entirely when there are no notes', () => {
    const prompt = buildPlanPrompt({ ...brief, notes: undefined });
    assert.ok(!prompt.includes('Additional constraints'));
  });
});
