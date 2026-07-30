import {
  SLACK_CONNECTION,
  TokenExchangeError,
  describeSlackToken,
  getConnectionToken,
  postSlackMessage,
} from './auth0-exchange.ts';

/**
 * The vendor announcement, posted with a Token Vault credential obtained for
 * the approver.
 *
 * This is the only Token Vault action left in the build, and it is what makes
 * identity-chaining observable rather than asserted: the credential is fetched
 * by exchanging THAT approver's Auth0 refresh token at execution time.
 *
 * Whether the message is *authored* by the human depends on what Slack returns.
 * Verified 2026-07-30 against this tenant: Auth0's marketplace Slack connector
 * vaults the top-level (bot) token, because Slack nests user tokens under
 * `authed_user` and the connector's token handling does not read there. So the
 * post shows the app as author. `buildAnnouncement` says which case it is —
 * claiming "posted as the approver" when a bot token sent it would be a lie
 * printed in a public channel.
 *
 * INVARIANT 5 — the exchange happens HERE, on the settled path, never at
 * proposal time. An approval can sit for minutes; a token fetched when the
 * agent first proposed the spend would be expired by now. Nothing is cached.
 *
 * Failure is NON-FATAL by construction. The money has already moved by the time
 * this runs, and a Slack outage must not roll back a charge or fail the request.
 * Every outcome is reported, never thrown, so the caller can log it and move on.
 */

export type SlackOutcome =
  | { posted: false; reason: string }
  | { posted: true; kind: 'user' | 'bot'; ts?: string; slackUserId?: string };

export interface AnnouncementFacts {
  approverName: string;
  approverRole: string;
  vendor: string;
  category: string;
  amountCents: number;
  ruleName: string;
  /** Last four of the card the money rode, when there was a card. */
  cardLast4: string | null;
  /** True when the card face is a stand-in. Stated in the message, never hidden. */
  simulated: boolean;
  /**
   * What kind of Slack token actually sent this, from `auth.test`. Defaults to
   * `'bot'` — the conservative claim — so an unset value can never overstate.
   */
  postedAs?: 'user' | 'bot';
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Composes the message. Pure, so the wording is unit-testable without a token.
 *
 * The text deliberately names the policy rule that fired. The point of the post
 * is not "a purchase happened" — it is "this specific human, holding this
 * specific role, released this specific commitment, under a named rule".
 */
export function buildAnnouncement(facts: AnnouncementFacts): string {
  const card = facts.cardLast4
    ? ` on a virtual card ending ${facts.cardLast4}${facts.simulated ? ' (simulated card — sandbox)' : ''}`
    : '';

  // Only a user token is attributed to the human by Slack. With a bot token the
  // author is the app, and the message must say so rather than imply otherwise.
  const provenance =
    facts.postedAs === 'user'
      ? `Posted as ${facts.approverName}, via Auth0 Token Vault.`
      : `Posted via Auth0 Token Vault, using a credential exchanged for ${facts.approverName}'s identity. Slack attributes app-level tokens to the app, so this message shows Signet as the author.`;

  return [
    `Approved and purchased: *${facts.vendor}* — ${dollars(facts.amountCents)} (${facts.category}).`,
    `Signed off by ${facts.approverName} (${facts.approverRole}) under policy rule \`${facts.ruleName}\`${card}.`,
    provenance,
  ].join('\n');
}

/**
 * Exchanges the approver's Auth0 refresh token for their Slack token and posts.
 *
 * @param refreshToken the APPROVER's Auth0 refresh token. Today this comes from
 *   the approving session, which works because the approver is the person
 *   pressing the button. A background agent acting for an absent approver needs
 *   the stored-token path (`users.encrypted_refresh_token`), which is unbuilt —
 *   see the known limitations in AGENTS.md.
 */
export async function announceSpend(args: {
  refreshToken: string | null | undefined;
  channel: string | undefined;
  facts: AnnouncementFacts;
}): Promise<SlackOutcome> {
  const { refreshToken, channel, facts } = args;

  if (!channel) {
    return { posted: false, reason: 'SLACK_CHANNEL_ID is not set' };
  }
  if (!refreshToken) {
    return {
      posted: false,
      reason:
        'No refresh token on the approving session — AUTH0_SCOPE must include offline_access, and the session must post-date it',
    };
  }

  let accessToken: string;
  try {
    ({ accessToken } = await getConnectionToken(refreshToken, SLACK_CONNECTION));
  } catch (err) {
    if (err instanceof TokenExchangeError) {
      return { posted: false, reason: err.message };
    }
    throw err;
  }

  // Which kind of token came back decides what the demo can honestly claim.
  // A bot token posts as the app; only a user token is attributed to the human.
  const probe = await describeSlackToken(accessToken);
  if (!probe.ok) {
    return { posted: false, reason: `slack auth.test failed: ${probe.error}` };
  }

  const res = await postSlackMessage({
    accessToken,
    channel,
    // The probe result decides the wording, so the claim in the channel can
    // never be stronger than the token that carried it.
    text: buildAnnouncement({ ...facts, postedAs: probe.kind === 'user' ? 'user' : 'bot' }),
  });

  if (!res.ok) {
    return { posted: false, reason: `slack chat.postMessage failed: ${res.error}` };
  }

  return { posted: true, kind: probe.kind === 'bot' ? 'bot' : 'user', ts: res.ts, slackUserId: probe.userId };
}
