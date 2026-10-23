import { randomUUID } from 'node:crypto';
import request from 'supertest';
import session from 'express-session';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { ShortCodeConflictError } from './links/errors.js';
import type { CreateLinkRecord, LinkPage, LinkRepository } from './links/repository.js';
import { LinkService } from './links/service.js';
import type { LinkRecord } from './db/schema.js';
import type { LinkCache } from './cache/link-cache.js';
import { linkCacheTtlSeconds } from './cache/link-cache.js';
import { AnalyticsService } from './analytics/service.js';
import type { ClicksByDate, LinkUpdate, TopLink } from './links/repository.js';
import type { UserRepository } from './auth/repository.js';
import type { UserRecord } from './db/schema.js';
import { createRateLimiters } from './security/rate-limit.js';
import { EmailAlreadyRegisteredError } from './auth/repository.js';

// Test-only repository. Production always uses PostgresLinkRepository.
class TestLinkRepository implements LinkRepository {
  private readonly records = new Map<string, LinkRecord>();
  readonly clickEvents: { linkId: string; clickedAt: Date }[] = [];
  shortCodeLookups = 0;

  async create(input: CreateLinkRecord): Promise<LinkRecord> {
    if ([...this.records.values()].some((record) => record.shortCode === input.shortCode)) {
      throw new ShortCodeConflictError();
    }
    const record: LinkRecord = {
      id: randomUUID(),
      ownerId: input.ownerId,
      shortCode: input.shortCode,
      destinationUrl: input.destinationUrl,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      isActive: true,
    };
    this.records.set(record.id, record);
    return record;
  }

  async findById(id: string, ownerId: string): Promise<LinkRecord | undefined> {
    const record = this.records.get(id);
    return record?.ownerId === ownerId ? record : undefined;
  }

  async findByShortCode(shortCode: string): Promise<LinkRecord | undefined> {
    this.shortCodeLookups += 1;
    return [...this.records.values()].find((record) => record.shortCode === shortCode);
  }

  async list(ownerId: string, limit: number, offset: number): Promise<LinkPage> {
    const items = [...this.records.values()]
      .filter((record) => record.ownerId === ownerId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return { items: items.slice(offset, offset + limit), total: items.length };
  }

  async update(id: string, ownerId: string, patch: LinkUpdate): Promise<LinkRecord | undefined> {
    const record = this.records.get(id);
    if (!record || record.ownerId !== ownerId) return undefined;
    const updated = { ...record, ...patch };
    this.records.set(id, updated);
    return updated;
  }

  async setActive(id: string, ownerId: string, isActive: boolean): Promise<LinkRecord | undefined> {
    const record = this.records.get(id);
    if (!record || record.ownerId !== ownerId) return undefined;
    const updated = { ...record, isActive };
    this.records.set(id, updated);
    return updated;
  }

  async deleteById(id: string, ownerId: string): Promise<string | undefined> {
    const record = this.records.get(id);
    if (!record || record.ownerId !== ownerId) return undefined;
    this.records.delete(id);
    for (let i = this.clickEvents.length - 1; i >= 0; i -= 1) {
      if (this.clickEvents[i]?.linkId === id) this.clickEvents.splice(i, 1);
    }
    return record.shortCode;
  }

  async recordClick(linkId: string): Promise<void> {
    this.clickEvents.push({ linkId, clickedAt: new Date() });
  }

  async totalClicks(ownerId: string): Promise<number> {
    return this.clickEvents.filter((event) => this.records.get(event.linkId)?.ownerId === ownerId)
      .length;
  }

  async linkClickCount(linkId: string, ownerId: string): Promise<number> {
    return this.clickEvents.filter(
      (event) => event.linkId === linkId && this.records.get(linkId)?.ownerId === ownerId,
    ).length;
  }

  async clicksOverTime(from: Date, ownerId: string, linkId?: string): Promise<ClicksByDate[]> {
    const buckets = new Map<string, number>();
    for (const event of this.clickEvents) {
      if (
        event.clickedAt < from ||
        (linkId && event.linkId !== linkId) ||
        this.records.get(event.linkId)?.ownerId !== ownerId
      )
        continue;
      const date = event.clickedAt.toISOString().slice(0, 10);
      buckets.set(date, (buckets.get(date) ?? 0) + 1);
    }
    return [...buckets]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, clicks]) => ({ date, clicks }));
  }

  async topLinks(limit: number, from: Date, ownerId: string): Promise<TopLink[]> {
    const totals = new Map<string, number>();
    for (const event of this.clickEvents) {
      if (event.clickedAt >= from && this.records.get(event.linkId)?.ownerId === ownerId)
        totals.set(event.linkId, (totals.get(event.linkId) ?? 0) + 1);
    }
    return [...totals]
      .map(([linkId, totalClicks]) => {
        const record = this.records.get(linkId);
        return record
          ? {
              linkId,
              shortCode: record.shortCode,
              destinationUrl: record.destinationUrl,
              totalClicks,
            }
          : undefined;
      })
      .filter((row): row is TopLink => row !== undefined)
      .sort((a, b) => b.totalClicks - a.totalClicks)
      .slice(0, limit);
  }

  seed(record: Partial<LinkRecord> & Pick<LinkRecord, 'shortCode' | 'destinationUrl'>): LinkRecord {
    const seeded: LinkRecord = {
      id: record.id ?? randomUUID(),
      ownerId: record.ownerId ?? null,
      shortCode: record.shortCode,
      destinationUrl: record.destinationUrl,
      createdAt: record.createdAt ?? new Date(),
      expiresAt: record.expiresAt ?? null,
      isActive: record.isActive ?? true,
    };
    this.records.set(seeded.id, seeded);
    return seeded;
  }
}

class TestUserRepository implements UserRepository {
  readonly records = new Map<string, UserRecord>();

  async findByEmail(email: string): Promise<UserRecord | undefined> {
    return [...this.records.values()].find((user) => user.email === email);
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    return this.records.get(id);
  }

  async create(email: string, passwordHash: string): Promise<UserRecord> {
    if (await this.findByEmail(email)) {
      throw new EmailAlreadyRegisteredError();
    }
    const record: UserRecord = { id: randomUUID(), email, passwordHash, createdAt: new Date() };
    this.records.set(record.id, record);
    return record;
  }
}

function makeTestApp(
  repository: TestLinkRepository,
  cache?: LinkCache,
  limits: Partial<{
    authMax: number;
    createMax: number;
    redirectMax: number;
    analyticsMax: number;
  }> = {},
) {
  return createApp(
    new LinkService(repository, 'http://short.test', cache),
    new AnalyticsService(repository, 'http://short.test'),
    {
      userRepository: new TestUserRepository(),
      sessionStore: new session.MemoryStore(),
      sessionSecret: randomUUID().replaceAll('-', '').repeat(2),
      distributedRateLimits: false,
      trustProxyHops: 0,
      rateLimiters: createRateLimiters(false, {
        windowMs: 60_000,
        authMax: limits.authMax ?? 100,
        createMax: limits.createMax ?? 100,
        redirectMax: limits.redirectMax ?? 100,
        analyticsMax: limits.analyticsMax ?? 100,
      }),
    },
  );
}

async function signedInClient(
  app: ReturnType<typeof createApp>,
  email = `${randomUUID()}@example.test`,
) {
  const agent = request.agent(app);
  const csrfResponse = await agent.get('/api/auth/csrf');
  const password = randomUUID() + randomUUID();
  const registered = await agent
    .post('/api/auth/register')
    .set('x-csrf-token', csrfResponse.body.csrfToken as string)
    .send({ email, password });
  if (registered.status !== 201)
    throw new Error(`Test account setup failed (${registered.status}).`);
  let csrfToken = registered.body.csrfToken as string;
  return {
    userId: registered.body.data.id as string,
    agent,
    get: (path: string) => agent.get(path),
    post: (path: string) => agent.post(path).set('x-csrf-token', csrfToken),
    patch: (path: string) => agent.patch(path).set('x-csrf-token', csrfToken),
    delete: (path: string) => agent.delete(path).set('x-csrf-token', csrfToken),
    setCsrf: (token: string) => {
      csrfToken = token;
    },
  };
}

class TestLinkCache implements LinkCache {
  readonly records = new Map<string, LinkRecord>();
  readonly invalidations: string[] = [];

  async get(shortCode: string): Promise<LinkRecord | undefined> {
    return this.records.get(shortCode);
  }

  async set(shortCode: string, record: LinkRecord): Promise<void> {
    this.records.set(shortCode, record);
  }

  async invalidate(shortCode: string): Promise<void> {
    this.invalidations.push(shortCode);
    this.records.delete(shortCode);
  }
}

describe('Link API', () => {
  let repository: TestLinkRepository;
  let testApp: ReturnType<typeof createApp>;
  let cache: TestLinkCache;
  let client: Awaited<ReturnType<typeof signedInClient>>;

  beforeEach(async () => {
    repository = new TestLinkRepository();
    cache = new TestLinkCache();
    testApp = makeTestApp(repository, cache);
    client = await signedInClient(testApp);
  });

  it('creates a link and returns its generated short URL', async () => {
    const response = await client.post('/api/links').send({
      destinationUrl: 'https://example.com/articles?id=42',
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      shortUrl: expect.stringMatching(/^http:\/\/short\.test\/[A-Za-z0-9_-]{8}$/),
      destinationUrl: 'https://example.com/articles?id=42',
      isActive: true,
      expiresAt: null,
    });
    expect(response.body.data.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it.each(['not a url', 'javascript:alert(1)', 'ftp://example.com/file'])(
    'rejects unsafe or invalid URL %s',
    async (destinationUrl) => {
      const response = await client.post('/api/links').send({ destinationUrl });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_DESTINATION_URL');
    },
  );

  it('rejects destinations containing embedded credentials', async () => {
    const response = await client
      .post('/api/links')
      .send({ destinationUrl: 'https://user:password@example.com/private' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_DESTINATION_URL');
  });

  it('returns a conflict for a duplicate custom alias', async () => {
    const payload = { destinationUrl: 'https://example.com', alias: 'launch' };
    expect((await client.post('/api/links').send(payload)).status).toBe(201);

    const duplicate = await client.post('/api/links').send(payload);

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('ALIAS_TAKEN');
  });

  it('retrieves a link by ID and lists links with pagination', async () => {
    const first = await client
      .post('/api/links')
      .send({ destinationUrl: 'https://example.com/one', alias: 'first' });
    await client
      .post('/api/links')
      .send({ destinationUrl: 'https://example.com/two', alias: 'second' });

    const retrieved = await client.get(`/api/links/${first.body.data.id}`);
    const page = await client.get('/api/links?page=2&limit=1');

    expect(retrieved.status).toBe(200);
    expect(retrieved.body.data.shortCode).toBe('first');
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.pagination).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });
  });

  it('redirects an active, unexpired short code', async () => {
    const created = await client
      .post('/api/links')
      .send({ destinationUrl: 'https://example.com/landing', alias: 'landing' });

    const response = await client.get('/landing');

    expect(created.status).toBe(201);
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('https://example.com/landing');
    expect(repository.clickEvents).toHaveLength(1);
  });

  it('uses the short-code cache after a miss and invalidates it after edits', async () => {
    const created = await client
      .post('/api/links')
      .send({ destinationUrl: 'https://example.com/first', alias: 'cache-check' });

    expect((await client.get('/cache-check')).status).toBe(302);
    expect((await client.get('/cache-check')).status).toBe(302);
    expect(repository.shortCodeLookups).toBe(1);
    expect(cache.records.has('cache-check')).toBe(true);

    const edited = await client
      .patch(`/api/links/${created.body.data.id}`)
      .send({ destinationUrl: 'https://example.com/updated' });
    expect(edited.status).toBe(200);
    expect(cache.records.has('cache-check')).toBe(false);

    const redirected = await client.get('/cache-check');
    expect(redirected.status).toBe(302);
    expect(redirected.headers.location).toBe('https://example.com/updated');
    expect(repository.shortCodeLookups).toBe(2);
  });

  it('invalidates cached links when deactivated or deleted', async () => {
    const created = await client
      .post('/api/links')
      .send({ destinationUrl: 'https://example.com/cache-lifecycle', alias: 'cache-life' });
    const id = created.body.data.id as string;
    await client.get('/cache-life');

    const deactivated = await client.patch(`/api/links/${id}/status`).send({ isActive: false });
    expect(deactivated.status).toBe(200);
    expect(cache.records.has('cache-life')).toBe(false);
    expect((await client.get('/cache-life')).status).toBe(410);
    expect(cache.records.has('cache-life')).toBe(false);
    expect(repository.clickEvents).toHaveLength(1);

    await client.patch(`/api/links/${id}/status`).send({ isActive: true });
    await client.get('/cache-life');
    expect((await client.delete(`/api/links/${id}`)).status).toBe(204);
    expect(cache.records.has('cache-life')).toBe(false);
    expect((await client.get('/cache-life')).status).toBe(404);
  });

  it('returns actual click totals, daily counts, top links, and per-link analytics', async () => {
    const first = await client
      .post('/api/links')
      .send({ destinationUrl: 'https://example.com/analytics-first', alias: 'analytics-a' });
    const second = await client
      .post('/api/links')
      .send({ destinationUrl: 'https://example.com/analytics-second', alias: 'analytics-b' });
    await client.get('/analytics-a');
    await client.get('/analytics-a');
    await client.get('/analytics-b');
    await client.get('/not-recorded');

    expect((await client.get('/api/analytics/total')).body.data.totalClicks).toBe(3);
    const series = await client.get('/api/analytics/timeseries?days=30');
    expect(series.body.data.points).toHaveLength(1);
    expect(series.body.data.points[0].clicks).toBe(3);
    const top = await client.get('/api/analytics/top?days=30');
    expect(top.body.data[0]).toMatchObject({
      linkId: first.body.data.id,
      shortCode: 'analytics-a',
      totalClicks: 2,
    });
    const perLink = await client.get(`/api/analytics/links/${second.body.data.id}`);
    expect(perLink.body.data).toMatchObject({ linkId: second.body.data.id, totalClicks: 1 });
  });

  it('does not record click events for expired or deactivated links', async () => {
    repository.seed({
      ownerId: client.userId,
      shortCode: 'expired',
      destinationUrl: 'https://example.com/expired',
      expiresAt: new Date(Date.now() - 60_000),
    });
    repository.seed({
      ownerId: client.userId,
      shortCode: 'disabled',
      destinationUrl: 'https://example.com/disabled',
      isActive: false,
    });

    expect((await client.get('/expired')).status).toBe(410);
    expect((await client.get('/disabled')).status).toBe(410);
    expect(repository.clickEvents).toHaveLength(0);
  });

  it('bounds cache TTL by link expiration', () => {
    const record = repository.seed({
      ownerId: client.userId,
      shortCode: 'ttl-check',
      destinationUrl: 'https://example.com/ttl',
      expiresAt: new Date(Date.now() + 10_000),
    });
    expect(linkCacheTtlSeconds(record)).toBeLessThanOrEqual(10);
    expect(linkCacheTtlSeconds({ ...record, expiresAt: null })).toBe(60);
  });

  it('falls back to PostgreSQL when cache operations throw', async () => {
    const unavailableCache: LinkCache = {
      get: async () => {
        throw new Error('cache unavailable');
      },
      set: async () => {
        throw new Error('cache unavailable');
      },
      invalidate: async () => {
        throw new Error('cache unavailable');
      },
    };
    const resilientApp = makeTestApp(repository, unavailableCache);
    const resilientClient = await signedInClient(resilientApp);
    await resilientClient
      .post('/api/links')
      .send({ destinationUrl: 'https://example.com/cache-down', alias: 'cache-down' });

    const redirect = await request(resilientApp).get('/cache-down');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe('https://example.com/cache-down');
    expect(repository.clickEvents).toHaveLength(1);
  });

  it('returns JSON 404 for a missing short code', async () => {
    const response = await client.get('/missing-code');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('LINK_NOT_FOUND');
  });

  it('does not redirect expired or deactivated links', async () => {
    repository.seed({
      ownerId: client.userId,
      shortCode: 'expired',
      destinationUrl: 'https://example.com/old',
      expiresAt: new Date(Date.now() - 60_000),
    });
    repository.seed({
      ownerId: client.userId,
      shortCode: 'paused',
      destinationUrl: 'https://example.com/paused',
      isActive: false,
    });

    const expired = await client.get('/expired');
    const inactive = await client.get('/paused');

    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe('LINK_EXPIRED');
    expect(inactive.status).toBe(410);
    expect(inactive.body.error.code).toBe('LINK_INACTIVE');
    expect(cache.records.has('expired')).toBe(false);
    expect(cache.records.has('paused')).toBe(false);
  });

  it('requires a session for management APIs but keeps redirects public', async () => {
    const created = await client.post('/api/links').send({
      destinationUrl: 'https://example.com/public-access',
      alias: 'public-access',
    });
    const anonymous = request(testApp);

    expect((await anonymous.get('/api/links')).status).toBe(401);
    const redirect = await anonymous.get('/public-access');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe('https://example.com/public-access');
    expect((await anonymous.get(`/api/links/${created.body.data.id}`)).status).toBe(401);
  });

  it('isolates link operations and analytics between users', async () => {
    const other = await signedInClient(testApp);
    const ownLink = await client.post('/api/links').send({
      destinationUrl: 'https://example.com/owned-a',
      alias: 'owned-a',
    });
    const otherLink = await other.post('/api/links').send({
      destinationUrl: 'https://example.com/owned-b',
      alias: 'owned-b',
    });
    await client.get('/owned-a');
    await other.get('/owned-b');

    expect((await client.get('/api/links')).body.pagination.total).toBe(1);
    expect((await other.get('/api/links')).body.pagination.total).toBe(1);
    expect((await client.get(`/api/links/${otherLink.body.data.id}`)).status).toBe(404);
    expect(
      (
        await client.patch(`/api/links/${otherLink.body.data.id}`).send({
          destinationUrl: 'https://example.com/stolen',
        })
      ).status,
    ).toBe(404);
    expect(
      (await client.patch(`/api/links/${otherLink.body.data.id}/status`).send({ isActive: false }))
        .status,
    ).toBe(404);
    expect((await client.delete(`/api/links/${otherLink.body.data.id}`)).status).toBe(404);
    expect((await client.get(`/api/analytics/links/${otherLink.body.data.id}`)).status).toBe(404);
    expect((await client.get('/api/analytics/total')).body.data.totalClicks).toBe(1);
    expect((await other.get('/api/analytics/total')).body.data.totalClicks).toBe(1);
    expect((await other.get(`/api/links/${ownLink.body.data.id}`)).status).toBe(404);
  });

  it('does not let an unauthorized owner action invalidate or change another owner cache', async () => {
    const other = await signedInClient(testApp);
    const saved = await other.post('/api/links').send({
      destinationUrl: 'https://example.com/cache-owner',
      alias: 'cache-owner',
    });
    await other.get('/cache-owner');
    const response = await client
      .patch(`/api/links/${saved.body.data.id}/status`)
      .send({ isActive: false });

    expect(response.status).toBe(404);
    expect(cache.records.get('cache-owner')?.destinationUrl).toBe(
      'https://example.com/cache-owner',
    );
    expect((await request(testApp).get('/cache-owner')).status).toBe(302);
  });
});

describe('Authentication and request protection', () => {
  it('does not load a browser session before the public redirect rate limiter', async () => {
    const repository = new TestLinkRepository();
    repository.seed({
      shortCode: 'public-cookie',
      destinationUrl: 'https://example.com/public-cookie',
    });
    const store = new session.MemoryStore();
    const getSession = vi.spyOn(store, 'get');
    const testApp = createApp(
      new LinkService(repository, 'http://short.test'),
      new AnalyticsService(repository, 'http://short.test'),
      {
        userRepository: new TestUserRepository(),
        sessionStore: store,
        sessionSecret: randomUUID().replaceAll('-', '').repeat(2),
        distributedRateLimits: false,
        trustProxyHops: 0,
        rateLimiters: createRateLimiters(false),
      },
    );
    const csrfResponse = await request(testApp).get('/api/auth/csrf');
    const sessionCookie = csrfResponse.headers['set-cookie'][0]?.split(';')[0];
    expect(sessionCookie).toBeDefined();

    getSession.mockClear();
    const redirect = await request(testApp).get('/public-cookie').set('cookie', sessionCookie!);

    expect(redirect.status).toBe(302);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('hashes passwords, rotates the session on sign-in, and invalidates it on logout', async () => {
    const repository = new TestLinkRepository();
    const users = new TestUserRepository();
    const testApp = createApp(
      new LinkService(repository, 'http://short.test'),
      new AnalyticsService(repository, 'http://short.test'),
      {
        userRepository: users,
        sessionStore: new session.MemoryStore(),
        sessionSecret: randomUUID().replaceAll('-', '').repeat(2),
        distributedRateLimits: false,
        trustProxyHops: 0,
        rateLimiters: createRateLimiters(false),
      },
    );
    const agent = request.agent(testApp);
    const csrf = await agent.get('/api/auth/csrf');
    const password = `${randomUUID()}${randomUUID()}`;
    const email = `${randomUUID()}@example.test`;
    const registration = await agent
      .post('/api/auth/register')
      .set('x-csrf-token', csrf.body.csrfToken as string)
      .send({ email, password });

    expect(registration.status).toBe(201);
    expect(registration.headers['set-cookie']).toBeDefined();
    expect(registration.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(registration.headers['set-cookie'][0]).toContain('SameSite=Lax');
    expect(users.records.get(registration.body.data.id)?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(users.records.get(registration.body.data.id)?.passwordHash).not.toBe(password);
    expect((await agent.get('/api/auth/me')).body.data.email).toBe(email);

    const duplicateRegistration = await agent
      .post('/api/auth/register')
      .set('x-csrf-token', registration.body.csrfToken as string)
      .send({ email, password });
    const invalidRegistration = await agent
      .post('/api/auth/register')
      .set('x-csrf-token', registration.body.csrfToken as string)
      .send({ email: 'invalid-email', password: 'short' });
    expect(duplicateRegistration.status).toBe(400);
    expect(invalidRegistration.status).toBe(400);
    expect(duplicateRegistration.body).toEqual(invalidRegistration.body);

    const badPassword = await agent
      .post('/api/auth/login')
      .set('x-csrf-token', registration.body.csrfToken as string)
      .send({ email, password: 'incorrect-password-value' });
    const unknownAccount = await agent
      .post('/api/auth/login')
      .set('x-csrf-token', registration.body.csrfToken as string)
      .send({ email: `unknown-${email}`, password: 'incorrect-password-value' });
    expect(badPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    expect(unknownAccount.body).toEqual(badPassword.body);

    const loggedIn = await agent
      .post('/api/auth/login')
      .set('x-csrf-token', registration.body.csrfToken as string)
      .send({ email, password });
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.body.csrfToken).not.toBe(registration.body.csrfToken);
    const loggedOut = await agent
      .post('/api/auth/logout')
      .set('x-csrf-token', loggedIn.body.csrfToken as string);
    expect(loggedOut.status).toBe(204);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects state changes without a valid CSRF token', async () => {
    const testApp = makeTestApp(new TestLinkRepository());
    const agent = request.agent(testApp);
    await agent.get('/api/auth/csrf');
    const response = await agent.post('/api/auth/register').send({
      email: `${randomUUID()}@example.test`,
      password: `${randomUUID()}${randomUUID()}`,
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_INVALID');
  });

  it('uses security headers and enforces the JSON body size limit', async () => {
    const testApp = makeTestApp(new TestLinkRepository());
    const health = await request(testApp).get('/api/health');
    expect(health.headers['x-powered-by']).toBeUndefined();
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['x-frame-options']).toBe('SAMEORIGIN');

    const agent = request.agent(testApp);
    const csrf = await agent.get('/api/auth/csrf');
    const oversized = await agent
      .post('/api/auth/register')
      .set('x-csrf-token', csrf.body.csrfToken as string)
      .send({ email: `${randomUUID()}@example.test`, password: 'a'.repeat(17_000) });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error.code).toBe('REQUEST_TOO_LARGE');
  });

  it('sets Secure session cookies behind a trusted HTTPS proxy in production', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const testApp = createApp(
        new LinkService(new TestLinkRepository(), 'https://short.test'),
        new AnalyticsService(new TestLinkRepository(), 'https://short.test'),
        {
          userRepository: new TestUserRepository(),
          sessionStore: new session.MemoryStore(),
          sessionSecret: randomUUID().replaceAll('-', '').repeat(2),
          distributedRateLimits: false,
          trustProxyHops: 1,
          rateLimiters: createRateLimiters(false),
        },
      );
      const response = await request(testApp)
        .get('/api/auth/csrf')
        .set('x-forwarded-proto', 'https');
      expect(response.status).toBe(200);
      expect(response.headers['set-cookie'][0]).toContain('Secure');
      expect(response.headers['strict-transport-security']).toBeDefined();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('returns 429 from login, creation, analytics, and public redirect limits', async () => {
    const repository = new TestLinkRepository();
    const testApp = makeTestApp(repository, undefined, {
      authMax: 2,
      createMax: 1,
      redirectMax: 1,
      analyticsMax: 1,
    });
    const agent = await signedInClient(testApp);
    const saved = await agent.post('/api/links').send({
      destinationUrl: 'https://example.com/rate-limited',
      alias: 'rate-limited',
    });
    expect(saved.status).toBe(201);
    const secondCreate = await agent.post('/api/links').send({
      destinationUrl: 'https://example.com/second',
      alias: 'second-limit',
    });
    expect(secondCreate.status).toBe(429);
    expect((await agent.get('/api/analytics/total')).status).toBe(200);
    const analyticsLimit = await agent.get('/api/analytics/total');
    expect(analyticsLimit.status).toBe(429);
    expect(
      (await request(testApp).get('/rate-limited').set('x-forwarded-for', '198.51.100.10')).status,
    ).toBe(302);
    const redirectLimit = await request(testApp)
      .get('/rate-limited')
      .set('x-forwarded-for', '203.0.113.20');
    expect(redirectLimit.status).toBe(429);

    const authApp = makeTestApp(new TestLinkRepository(), undefined, { authMax: 2 });
    const authAgent = request.agent(authApp);
    const csrf = await authAgent.get('/api/auth/csrf');
    const loginAttempt = () =>
      authAgent
        .post('/api/auth/login')
        .set('x-csrf-token', csrf.body.csrfToken as string)
        .send({ email: 'missing@example.test', password: `${randomUUID()}${randomUUID()}` });
    expect((await loginAttempt()).status).toBe(401);
    const rateLimitedLogin = await loginAttempt();
    expect(rateLimitedLogin.status).toBe(429);
  });
});

describe('GET /api/health', () => {
  it('returns the API health status', async () => {
    const healthApp = makeTestApp(new TestLinkRepository());
    const response = await request(healthApp).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', service: 'linkpulse-api' });
  });
});
