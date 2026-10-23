import './src/config/load-env.js';
import { defineConfig } from 'drizzle-kit';
import { requireDatabaseUrl } from './src/config/runtime.js';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: requireDatabaseUrl(),
  },
});
