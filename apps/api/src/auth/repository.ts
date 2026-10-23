import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { users, type UserRecord } from '../db/schema.js';

export class EmailAlreadyRegisteredError extends Error {}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '23505') return true;
  return 'cause' in error && isUniqueViolation(error.cause);
}

export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | undefined>;
  findById(id: string): Promise<UserRecord | undefined>;
  create(email: string, passwordHash: string): Promise<UserRecord>;
}

export class PostgresUserRepository implements UserRepository {
  async findByEmail(email: string): Promise<UserRecord | undefined> {
    const [record] = await getDb().select().from(users).where(eq(users.email, email)).limit(1);
    return record;
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    const [record] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
    return record;
  }

  async create(email: string, passwordHash: string): Promise<UserRecord> {
    try {
      const [record] = await getDb().insert(users).values({ email, passwordHash }).returning();
      if (!record) throw new Error('PostgreSQL did not return the created user.');
      return record;
    } catch (error) {
      if (isUniqueViolation(error)) throw new EmailAlreadyRegisteredError();
      throw error;
    }
  }
}
