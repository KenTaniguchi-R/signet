import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

import * as schema from './schema.ts';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set — see .env.example');
}

/** Node runtime only. Use from route handlers and server components. */
export const db = drizzle(neon(connectionString), { schema });

export * from './schema.ts';
