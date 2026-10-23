import { createClient, type RedisClientType } from 'redis';
import type { LinkRecord } from '../db/schema.js';

export interface LinkCache {
  get(shortCode: string): Promise<LinkRecord | undefined>;
  set(shortCode: string, record: LinkRecord, ttlSeconds: number): Promise<void>;
  invalidate(shortCode: string): Promise<void>;
  close?(): Promise<void>;
}

const CACHE_KEY_PREFIX = 'linkpulse:short-code:';
const DEFAULT_REDIS_TTL_SECONDS = 60;

export function linkCacheTtlSeconds(record: LinkRecord, now = Date.now()): number {
  if (!record.expiresAt) return DEFAULT_REDIS_TTL_SECONDS;
  const remainingMs = record.expiresAt.getTime() - now;
  if (remainingMs <= 0) return 0;
  return Math.min(DEFAULT_REDIS_TTL_SECONDS, Math.ceil(remainingMs / 1000));
}

function deserializeLink(value: string): LinkRecord | undefined {
  try {
    const parsed = JSON.parse(value) as Omit<LinkRecord, 'createdAt' | 'expiresAt'> & {
      createdAt: string;
      expiresAt: string | null;
    };
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.shortCode !== 'string' ||
      typeof parsed.destinationUrl !== 'string' ||
      typeof parsed.isActive !== 'boolean'
    ) {
      return undefined;
    }
    const createdAt = new Date(parsed.createdAt);
    const expiresAt = parsed.expiresAt ? new Date(parsed.expiresAt) : null;
    if (Number.isNaN(createdAt.getTime()) || (expiresAt && Number.isNaN(expiresAt.getTime()))) {
      return undefined;
    }
    return { ...parsed, createdAt, expiresAt };
  } catch {
    return undefined;
  }
}

export class RedisLinkCache implements LinkCache {
  private client: RedisClientType | undefined;
  private connecting: Promise<RedisClientType | undefined> | undefined;

  constructor(private readonly redisUrl = process.env.REDIS_URL) {}

  async get(shortCode: string): Promise<LinkRecord | undefined> {
    const client = await this.readyClient();
    if (!client) return undefined;
    try {
      const value = await client.get(`${CACHE_KEY_PREFIX}${shortCode}`);
      return value ? deserializeLink(value) : undefined;
    } catch {
      return undefined;
    }
  }

  async set(shortCode: string, record: LinkRecord, ttlSeconds: number): Promise<void> {
    if (ttlSeconds < 1) return;
    const client = await this.readyClient();
    if (!client) return;
    try {
      await client.set(`${CACHE_KEY_PREFIX}${shortCode}`, JSON.stringify(record), {
        EX: ttlSeconds,
      });
    } catch {
      // Cache write failures are intentionally non-fatal; PostgreSQL remains authoritative.
    }
  }

  async invalidate(shortCode: string): Promise<void> {
    const client = await this.readyClient();
    if (!client) return;
    try {
      await client.del(`${CACHE_KEY_PREFIX}${shortCode}`);
    } catch {
      // Cache invalidation failures are bounded by the TTL and checked against PostgreSQL data.
    }
  }

  async close(): Promise<void> {
    if (this.client?.isOpen) {
      await this.client.quit().catch(() => undefined);
    }
    this.client = undefined;
  }

  private async readyClient(): Promise<RedisClientType | undefined> {
    if (!this.redisUrl) return undefined;
    if (!this.client) {
      this.client = createClient({
        url: this.redisUrl,
        socket: { connectTimeout: 1000, reconnectStrategy: false },
      });
      this.client.on('error', () => undefined);
    }
    if (this.client.isReady) return this.client;
    if (!this.connecting) {
      const client = this.client;
      this.connecting = (client.isOpen ? Promise.resolve(undefined) : client.connect())
        .then(() => client)
        .catch(() => undefined)
        .finally(() => {
          this.connecting = undefined;
        });
    }
    return this.connecting;
  }
}
