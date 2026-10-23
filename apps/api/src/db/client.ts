import '../config/load-env.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

let pool: Pool | undefined;

export function getDb() {
  return drizzle(getPool(), { schema });
}

export function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to use link persistence.');
  }

  pool ??= new Pool({ connectionString });
  return pool;
}

export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
