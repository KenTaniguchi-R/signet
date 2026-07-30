import type { NextRequest } from 'next/server';

import { auth0 } from '@/lib/auth0';

/**
 * Next.js 16 renamed Middleware to Proxy. The Auth0 SDK method is still called
 * `middleware` — only the Next-side file and function name changed.
 *
 * Mounts /auth/login, /auth/logout, /auth/callback, /auth/profile,
 * /auth/access-token, /auth/connect and /auth/backchannel-logout.
 */
export async function proxy(request: NextRequest) {
  return auth0.middleware(request);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)'],
};
