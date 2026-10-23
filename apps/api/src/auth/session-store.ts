import { createHash } from 'node:crypto';
import session from 'express-session';
import { eq, lt } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { authSessions } from '../db/schema.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function hashSessionId(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}

export class PostgresSessionStore extends session.Store {
  get(sid: string, callback: (error: unknown, session?: session.SessionData | null) => void): void {
    void (async () => {
      const db = getDb();
      const idHash = hashSessionId(sid);
      const [record] = await db
        .select()
        .from(authSessions)
        .where(eq(authSessions.idHash, idHash))
        .limit(1);
      if (!record) return callback(null, null);
      if (record.expiresAt.getTime() <= Date.now()) {
        await db.delete(authSessions).where(eq(authSessions.idHash, idHash));
        return callback(null, null);
      }
      callback(null, record.session as session.SessionData);
    })().catch((error: unknown) => callback(error));
  }

  set(sid: string, value: session.SessionData, callback?: (error?: unknown) => void): void {
    const maxAge = value.cookie.maxAge ?? value.cookie.originalMaxAge ?? SESSION_TTL_MS;
    const expiresAt = value.cookie.expires
      ? new Date(value.cookie.expires)
      : new Date(Date.now() + maxAge);
    const serialized = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    void getDb()
      .insert(authSessions)
      .values({ idHash: hashSessionId(sid), session: serialized, expiresAt })
      .onConflictDoUpdate({
        target: authSessions.idHash,
        set: { session: serialized, expiresAt },
      })
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }

  destroy(sid: string, callback?: (error?: unknown) => void): void {
    void getDb()
      .delete(authSessions)
      .where(eq(authSessions.idHash, hashSessionId(sid)))
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }

  touch(sid: string, value: session.SessionData, callback?: (error?: unknown) => void): void {
    const maxAge = value.cookie.maxAge ?? value.cookie.originalMaxAge ?? SESSION_TTL_MS;
    const expiresAt = value.cookie.expires
      ? new Date(value.cookie.expires)
      : new Date(Date.now() + maxAge);
    void getDb()
      .update(authSessions)
      .set({ expiresAt })
      .where(eq(authSessions.idHash, hashSessionId(sid)))
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }

  async removeExpired(): Promise<void> {
    await getDb().delete(authSessions).where(lt(authSessions.expiresAt, new Date()));
  }
}
