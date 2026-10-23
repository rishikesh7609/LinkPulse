import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { clickEvents, links, type LinkRecord } from '../db/schema.js';
import { ShortCodeConflictError } from './errors.js';

export type CreateLinkRecord = {
  ownerId: string;
  shortCode: string;
  destinationUrl: string;
  expiresAt: Date | null;
};

export type LinkPage = {
  items: LinkRecord[];
  total: number;
};

export type LinkUpdate = { destinationUrl?: string; expiresAt?: Date | null };
export type ClicksByDate = { date: string; clicks: number };
export type TopLink = {
  linkId: string;
  shortCode: string;
  destinationUrl: string;
  totalClicks: number;
};

export interface LinkRepository {
  create(input: CreateLinkRecord): Promise<LinkRecord>;
  findById(id: string, ownerId: string): Promise<LinkRecord | undefined>;
  findByShortCode(shortCode: string): Promise<LinkRecord | undefined>;
  list(ownerId: string, limit: number, offset: number): Promise<LinkPage>;
  update(id: string, ownerId: string, patch: LinkUpdate): Promise<LinkRecord | undefined>;
  setActive(id: string, ownerId: string, isActive: boolean): Promise<LinkRecord | undefined>;
  deleteById(id: string, ownerId: string): Promise<string | undefined>;
  recordClick(linkId: string): Promise<void>;
  totalClicks(ownerId: string): Promise<number>;
  linkClickCount(linkId: string, ownerId: string): Promise<number>;
  clicksOverTime(from: Date, ownerId: string, linkId?: string): Promise<ClicksByDate[]>;
  topLinks(limit: number, from: Date, ownerId: string): Promise<TopLink[]>;
}

function isUniqueViolation(error: unknown, depth = 0): boolean {
  if (typeof error !== 'object' || error === null || depth > 4) {
    return false;
  }

  if ('code' in error && error.code === '23505') {
    return true;
  }

  // Drizzle wraps node-postgres errors in a DrizzleQueryError and stores the
  // original PostgreSQL error as `cause`.
  return 'cause' in error && isUniqueViolation(error.cause, depth + 1);
}

export class PostgresLinkRepository implements LinkRepository {
  async create(input: CreateLinkRecord): Promise<LinkRecord> {
    try {
      const [created] = await getDb().insert(links).values(input).returning();

      if (!created) {
        throw new Error('PostgreSQL did not return the created link.');
      }

      return created;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ShortCodeConflictError();
      }
      throw error;
    }
  }

  async findById(id: string, ownerId: string): Promise<LinkRecord | undefined> {
    const [record] = await getDb()
      .select()
      .from(links)
      .where(and(eq(links.id, id), eq(links.ownerId, ownerId)))
      .limit(1);
    return record;
  }

  async findByShortCode(shortCode: string): Promise<LinkRecord | undefined> {
    const [record] = await getDb()
      .select()
      .from(links)
      .where(eq(links.shortCode, shortCode))
      .limit(1);
    return record;
  }

  async list(ownerId: string, limit: number, offset: number): Promise<LinkPage> {
    const db = getDb();
    const [items, [totalRow]] = await Promise.all([
      db
        .select()
        .from(links)
        .where(eq(links.ownerId, ownerId))
        .orderBy(desc(links.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(links).where(eq(links.ownerId, ownerId)),
    ]);

    return { items, total: totalRow?.value ?? 0 };
  }

  async update(id: string, ownerId: string, patch: LinkUpdate): Promise<LinkRecord | undefined> {
    const [record] = await getDb()
      .update(links)
      .set(patch)
      .where(and(eq(links.id, id), eq(links.ownerId, ownerId)))
      .returning();
    return record;
  }

  async setActive(id: string, ownerId: string, isActive: boolean): Promise<LinkRecord | undefined> {
    const [record] = await getDb()
      .update(links)
      .set({ isActive })
      .where(and(eq(links.id, id), eq(links.ownerId, ownerId)))
      .returning();
    return record;
  }

  async deleteById(id: string, ownerId: string): Promise<string | undefined> {
    const [deleted] = await getDb()
      .delete(links)
      .where(and(eq(links.id, id), eq(links.ownerId, ownerId)))
      .returning({ shortCode: links.shortCode });
    return deleted?.shortCode;
  }

  async recordClick(linkId: string): Promise<void> {
    await getDb().insert(clickEvents).values({ linkId });
  }

  async totalClicks(ownerId: string): Promise<number> {
    const [result] = await getDb()
      .select({ value: count() })
      .from(clickEvents)
      .innerJoin(links, eq(clickEvents.linkId, links.id))
      .where(eq(links.ownerId, ownerId));
    return result?.value ?? 0;
  }

  async linkClickCount(linkId: string, ownerId: string): Promise<number> {
    const [result] = await getDb()
      .select({ value: count() })
      .from(clickEvents)
      .innerJoin(links, eq(clickEvents.linkId, links.id))
      .where(and(eq(clickEvents.linkId, linkId), eq(links.ownerId, ownerId)));
    return result?.value ?? 0;
  }

  async clicksOverTime(from: Date, ownerId: string, linkId?: string): Promise<ClicksByDate[]> {
    const bucket = sql`date_trunc('day', ${clickEvents.clickedAt} AT TIME ZONE 'UTC')`;
    const filters = and(
      gte(clickEvents.clickedAt, from),
      eq(links.ownerId, ownerId),
      ...(linkId ? [eq(clickEvents.linkId, linkId)] : []),
    );
    const results = await getDb()
      .select({
        date: sql<string>`to_char(${bucket}, 'YYYY-MM-DD')`,
        clicks: count(),
      })
      .from(clickEvents)
      .innerJoin(links, eq(clickEvents.linkId, links.id))
      .where(filters)
      .groupBy(bucket)
      .orderBy(bucket);
    return results;
  }

  async topLinks(limit: number, from: Date, ownerId: string): Promise<TopLink[]> {
    return getDb()
      .select({
        linkId: links.id,
        shortCode: links.shortCode,
        destinationUrl: links.destinationUrl,
        totalClicks: count(),
      })
      .from(clickEvents)
      .innerJoin(links, eq(clickEvents.linkId, links.id))
      .where(and(gte(clickEvents.clickedAt, from), eq(links.ownerId, ownerId)))
      .groupBy(links.id)
      .orderBy(desc(count()))
      .limit(limit);
  }
}
