/**
 * RFC 8693 token exchange against Auth0 Token Vault.
 *
 * Called directly rather than through `@auth0/ai-vercel`, for two reasons: its
 * peer range is `ai: ^5 || ^6` and would fight ai@7, and its Token Vault helper
 * only exchanges for the *currently logged-in* user — which breaks the premise
 * the moment the approver is not the caller.
 *
 * INVARIANT 5 — call this AFTER an approval resolves, never at proposal time.
 * An approval can sit for minutes; a token fetched early is expired by the time
 * it is used and 401s with no useful message. Do not cache the result.
 */

export class TokenExchangeError extends Error {
  constructor(
    readonly connection: string,
    readonly httpStatus: number,
    readonly detail?: string,
  ) {
    super(
      `Token Vault exchange failed for "${connection}" (HTTP ${httpStatus})` +
        (detail ? `: ${detail}` : ''),
    );
    this.name = 'TokenExchangeError';
  }
}

/** The only connection in scope. It is `sign-in-with-slack`, never `slack`. */
export const SLACK_CONNECTION = 'sign-in-with-slack';

export interface ConnectionToken {
  accessToken: string;
  scope: string;
  expiresIn: number;
}

/**
 * Exchanges an Auth0 refresh token for a third-party access token.
 *
 * @param refreshToken the APPROVER's Auth0 refresh token — requires
 *   `offline_access`, which AUTH0_SCOPE already requests
 * @param connection e.g. {@link SLACK_CONNECTION}
 */
export async function getConnectionToken(
  refreshToken: string,
  connection: string = SLACK_CONNECTION,
): Promise<ConnectionToken> {
  const domain = process.env.AUTH0_DOMAIN;
  const clientId = process.env.AUTH0_CLIENT_ID;
  const clientSecret = process.env.AUTH0_CLIENT_SECRET;
  if (!domain || !clientId || !clientSecret) {
    throw new Error('AUTH0_DOMAIN, AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET must all be set');
  }

  const res = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:
        'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
      requested_token_type: 'http://auth0.com/oauth/token-type/federated-connection-access-token',
      subject_token: refreshToken,
      connection,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    // 403 → the Token Vault grant type is not enabled on the Application.
    // 401 → refresh token rotation left ON in Auth0, or the Purpose toggle
    //       ("Connected Accounts for Token Vault") was never flipped, or no
    //       user identity matches `connection`.
    const detail = await res.text().catch(() => '');
    throw new TokenExchangeError(connection, res.status, detail.slice(0, 300));
  }

  const body = (await res.json()) as {
    access_token: string;
    scope?: string;
    expires_in?: number;
  };
  return {
    accessToken: body.access_token,
    scope: body.scope ?? '',
    expiresIn: body.expires_in ?? 0,
  };
}

/**
 * Identifies what kind of Slack token came back.
 *
 * "Post as the approver" only works with a USER token. If Slack hands back a
 * bot token (`bot_id` present) the message is authored by the app, not the
 * human, and the demo beat has to change. Check this before building on it.
 */
export async function describeSlackToken(accessToken: string): Promise<{
  ok: boolean;
  kind: 'user' | 'bot' | 'unknown';
  userId?: string;
  teamId?: string;
  error?: string;
}> {
  const res = await fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = (await res.json()) as {
    ok: boolean;
    user_id?: string;
    team_id?: string;
    bot_id?: string;
    error?: string;
  };
  if (!body.ok) return { ok: false, kind: 'unknown', error: body.error };
  return {
    ok: true,
    kind: body.bot_id ? 'bot' : 'user',
    userId: body.user_id,
    teamId: body.team_id,
  };
}

/** Posts a message. With a user token, Slack attributes it to that human. */
export async function postSlackMessage(args: {
  accessToken: string;
  channel: string;
  text: string;
}): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel: args.channel, text: args.text }),
  });
  const body = (await res.json()) as { ok: boolean; ts?: string; error?: string };
  return body;
}
