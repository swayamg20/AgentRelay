import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const dbUrl = process.env.RELAY_DATABASE_URL;
if (!dbUrl) {
  throw new Error('RELAY_DATABASE_URL is required for drizzle-kit operations');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: dbUrl },
  strict: true,
  verbose: true,
});
