import { NextResponse } from 'next/server';

import { getActor } from '@/lib/actor';
import { auth0 } from '@/lib/auth0';
import {
  SLACK_CONNECTION,
  TokenExchangeError,
  describeSlackToken,
  getConnectionToken,
} from '@/lib/auth0-exchange';

/**
 * Diagnostic only — build-notes gotcha #10. Run this the moment a Slack account
 * is connected, BEFORE building the demo beat on it.
 *
 *   kind: "user" → chat.postMessage is attributed to the human. Beat 7 works.
 *   kind: "bot"  → the message is authored by the app. Take the fallback beat.
 *
 * Never available in production: it reports token metadata, and there is no
 * reason to expose that beyond a laptop.
 */
export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const actor = await getActor();
  if (!actor) {
    return NextResponse.json({ error: 'Log in first' }, { status: 401 });
  }

  const session = await auth0.getSession();
  const refreshToken = session?.tokenSet.refreshToken;
  if (!refreshToken) {
    return NextResponse.json(
      {
        error:
          'No refresh token on the session. AUTH0_SCOPE must include offline_access, and the session predates it — log out and back in.',
      },
      { status: 400 },
    );
  }

  try {
    const token = await getConnectionToken(refreshToken, SLACK_CONNECTION);
    const probe = await describeSlackToken(token.accessToken);
    return NextResponse.json({
      actor: { name: actor.displayName, role: actor.role },
      exchange: { ok: true, scope: token.scope, expiresIn: token.expiresIn },
      slack: probe,
      verdict:
        probe.kind === 'user'
          ? 'USER token — posting as the approver works'
          : probe.kind === 'bot'
            ? 'BOT token — posting as the approver is NOT possible, take the fallback beat'
            : `auth.test failed: ${probe.error}`,
    });
  } catch (err) {
    if (err instanceof TokenExchangeError) {
      return NextResponse.json(
        {
          error: err.message,
          hint:
            err.httpStatus === 403
              ? 'Token Vault grant type missing on the Application'
              : err.httpStatus === 401
                ? 'Refresh token rotation ON in Auth0, or the Purpose toggle was never set to Connected Accounts, or no Slack identity is linked to this user'
                : undefined,
        },
        { status: 502 },
      );
    }
    throw err;
  }
}
