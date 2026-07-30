import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { announceSpend, buildAnnouncement, type AnnouncementFacts } from './slack.ts';

const FACTS: AnnouncementFacts = {
  approverName: 'Ken Taniguchi',
  approverRole: 'finance',
  vendor: 'Okta HQ San Francisco',
  category: 'venue',
  amountCents: 250_000,
  ruleName: 'irreversible_over_2000',
  cardLast4: '4242',
  simulated: false,
};

describe('buildAnnouncement', () => {
  it('names the human, the role and the rule that fired', () => {
    const text = buildAnnouncement(FACTS);
    assert.match(text, /Ken Taniguchi/);
    assert.match(text, /finance/);
    assert.match(text, /irreversible_over_2000/);
  });

  it('formats the amount as dollars, not cents', () => {
    assert.match(buildAnnouncement(FACTS), /\$2,500\.00/);
    assert.doesNotMatch(buildAnnouncement(FACTS), /250000/);
  });

  it('states when the card is simulated rather than hiding it', () => {
    const text = buildAnnouncement({ ...FACTS, simulated: true });
    assert.match(text, /simulated card/i);
  });

  it('does not claim a real card when there is one', () => {
    assert.doesNotMatch(buildAnnouncement(FACTS), /simulated/i);
  });

  it('omits the card clause entirely when no card was shown', () => {
    const text = buildAnnouncement({ ...FACTS, cardLast4: null });
    assert.doesNotMatch(text, /card ending/i);
  });
});

describe('announceSpend — degrades, never throws', () => {
  it('skips with a reason when no channel is configured', async () => {
    const out = await announceSpend({ refreshToken: 'rt', channel: undefined, facts: FACTS });
    assert.equal(out.posted, false);
    assert.match(out.posted === false ? out.reason : '', /SLACK_CHANNEL_ID/);
  });

  it('skips with a reason when the session carries no refresh token', async () => {
    const out = await announceSpend({ refreshToken: null, channel: 'C123', facts: FACTS });
    assert.equal(out.posted, false);
    assert.match(out.posted === false ? out.reason : '', /refresh token/i);
  });
});
