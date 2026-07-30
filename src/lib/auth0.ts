import { Auth0Client } from '@auth0/nextjs-auth0/server';

/**
 * Org-scoped Auth0 client.
 *
 * `organization` is pinned here, in server code, so every login is scoped to the
 * Signet org. Nothing on the request path — not the client, not the model — gets
 * to choose which organization a user authenticates into.
 *
 * Requires the Auth0 Application's Organizations tab to allow "Organization
 * Members"; otherwise /authorize returns
 * `invalid_request: parameter organization is not allowed for this client`.
 */
export const auth0 = new Auth0Client({
  authorizationParameters: {
    scope: process.env.AUTH0_SCOPE,
    organization: process.env.AUTH0_ORG_ID,
  },
  /**
   * Mounts GET /auth/connect — the Connected Accounts flow that links a
   * third-party account into Token Vault. Off by default in v4, which 404s the
   * route rather than erroring, so the cause is not obvious.
   */
  enableConnectAccountEndpoint: true,
});
