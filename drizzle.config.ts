import { defineConfig } from 'drizzle-kit';

// drizzle-kit doesn't read .env.local the way Next does.
try {
  process.loadEnvFile('.env.local');
} catch {
  // fall through to whatever is already in the environment
}

// Migrations go over the direct (unpooled) connection; the app uses the pooled one.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!url) {
  throw new Error('DATABASE_URL_UNPOOLED (or DATABASE_URL) is not set — see .env.example');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
});
