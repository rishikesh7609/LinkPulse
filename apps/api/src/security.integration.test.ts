import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { createClient } from 'redis';
import { afterAll, describe, expect, it } from 'vitest';
import { AnalyticsService } from './analytics/service.js';
import { PostgresSessionStore } from './auth/session-store.js';
import { PostgresUserRepository } from './auth/repository.js';
import { createApp } from './app.js';
import { RedisLinkCache } from './cache/link-cache.js';
import { requireRedisUrl } from './config/runtime.js';
import { getDb, getPool } from './db/client.js';
import { authSessions, links, users } from './db/schema.js';
import { PostgresLinkRepository, type LinkRepository } from './links/repository.js';
import { LinkService } from './links/service.js';
import { closeRateLimitRedis, createRateLimiters } from './security/rate-limit.js';
import { eq, sql } from 'drizzle-orm';

const enabled = process.env.LINKPULSE_INTEGRATION === '1';

function forwardedAgent(app: ReturnType<typeof createApp>, ip: string) {
  const agent = request.agent(app);
  return {
    get: (path: string) => agent.get(path).set('x-forwarded-for', ip),
    post: (path: string) => agent.post(path).set('x-forwarded-for', ip),
    patch: (path: string) => agent.patch(path).set('x-forwarded-for', ip),
    delete: (path: string) => agent.delete(path).set('x-forwarded-for', ip),
  };
}

describe.skipIf(!enabled)('PostgreSQL and Redis security integration', () => {
  let redisClient: ReturnType<typeof createClient> | undefined;

  afterAll(async () => {
    await closeRateLimitRedis();
    if (redisClient?.isOpen) await redisClient.quit();
  });

  it('keeps authenticated ownership, sessions, redirect cache, analytics, and failure fallback aligned', async () => {
    redisClient = createClient({ url: requireRedisUrl() });
    await redisClient.connect();
    expect(await redisClient.ping()).toBe('PONG');
    const schemaRows = await getPool().query<{ table_name: string; column_name: string | null }>(
      `select required.table_name, required.column_name
       from (values
         ('users', null::text),
         ('auth_sessions', null::text),
         ('links', 'owner_id')
       ) as required(table_name, column_name)
       where to_regclass('public.' || required.table_name) is not null
         and (required.column_name is null or exists (
           select 1 from information_schema.columns c
           where c.table_schema = 'public'
             and c.table_name = required.table_name
             and c.column_name = required.column_name
         ))`,
    );
    expect(schemaRows.rows).toHaveLength(3);
    const indexRows = await getPool().query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = 'public'
         and indexname = any($1::text[])`,
      [['users_email_unique', 'auth_sessions_expires_at_idx', 'links_owner_created_idx']],
    );
    expect(indexRows.rows.map((row) => row.indexname).sort()).toEqual(
      ['auth_sessions_expires_at_idx', 'links_owner_created_idx', 'users_email_unique'].sort(),
    );
    const constraintRows = await getPool().query<{ conname: string }>(
      `select conname from pg_constraint where conname = any($1::text[])`,
      [['users_email_normalized', 'links_owner_id_users_id_fk']],
    );
    expect(constraintRows.rows.map((row) => row.conname).sort()).toEqual(
      ['links_owner_id_users_id_fk', 'users_email_normalized'].sort(),
    );

    const userRepo = new PostgresUserRepository();
    const linkRepo = new PostgresLinkRepository();
    let databaseCodeLookups = 0;
    const instrumentedRepo = new Proxy(linkRepo, {
      get(target, property, receiver) {
        if (property === 'findByShortCode') {
          return async (code: string) => {
            databaseCodeLookups += 1;
            return target.findByShortCode(code);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as LinkRepository;
    const cache = new RedisLinkCache(requireRedisUrl());
    const app = createApp(
      new LinkService(instrumentedRepo, process.env.PUBLIC_BASE_URL, cache),
      new AnalyticsService(instrumentedRepo, process.env.PUBLIC_BASE_URL),
      {
        userRepository: userRepo,
        sessionStore: new PostgresSessionStore(),
        sessionSecret: randomBytes(48).toString('base64url'),
        trustProxyHops: 1,
        rateLimiters: createRateLimiters(true, {
          windowMs: 60_000,
          authMax: 100,
          createMax: 100,
          redirectMax: 100,
          analyticsMax: 100,
        }),
      },
    );
    const readiness = await request(app).get('/api/health/ready');
    expect(readiness.status).toBe(200);
    expect(readiness.body).toMatchObject({ status: 'ready', database: 'ok', redis: 'ok' });

    const mainIp = `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
    const agent = forwardedAgent(app, mainIp);
    const userIds: string[] = [];
    const testCodes: string[] = [];
    const testIps: string[] = [mainIp];
    const oldRedisUrl = process.env.REDIS_URL;
    try {
      const csrf = await agent.get('/api/auth/csrf');
      const email = `integration-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const registration = await agent
        .post('/api/auth/register')
        .set('x-csrf-token', csrf.body.csrfToken as string)
        .send({ email, password });
      expect(registration.status).toBe(201);
      const userId = registration.body.data.id as string;
      let csrfToken = registration.body.csrfToken as string;
      userIds.push(userId);
      const storedSessions = await getDb()
        .select()
        .from(authSessions)
        .where(sql`${authSessions.session}->>'userId' = ${userId}`);
      expect(storedSessions.length).toBeGreaterThan(0);
      expect(storedSessions.every((row) => /^[a-f0-9]{64}$/.test(row.idHash))).toBe(true);
      expect(JSON.stringify(storedSessions[0]?.session)).not.toContain(registration.body.csrfToken);

      const code = `int-${randomUUID().slice(0, 8)}`;
      testCodes.push(code);
      const created = await agent
        .post('/api/links')
        .set('x-csrf-token', csrfToken)
        .send({ destinationUrl: 'https://example.com/integration-first', alias: code });
      expect(created.status).toBe(201);
      const cacheKey = `linkpulse:short-code:${code}`;
      await redisClient.del(cacheKey);

      const firstRedirect = await agent.get(`/${code}`);
      expect(firstRedirect.status).toBe(302);
      expect(await redisClient.exists(cacheKey)).toBe(1);
      expect(databaseCodeLookups).toBe(1);
      const secondRedirect = await agent.get(`/${code}`);
      expect(secondRedirect.status).toBe(302);
      expect(databaseCodeLookups).toBe(1);

      const edited = await agent
        .patch(`/api/links/${created.body.data.id}`)
        .set('x-csrf-token', csrfToken)
        .send({ destinationUrl: 'https://example.com/integration-updated' });
      expect(edited.status).toBe(200);
      expect(await redisClient.exists(cacheKey)).toBe(0);
      expect((await agent.get(`/${code}`)).headers.location).toBe(
        'https://example.com/integration-updated',
      );
      expect((await agent.get('/api/analytics/total')).body.data.totalClicks).toBe(3);

      const deactivated = await agent
        .patch(`/api/links/${created.body.data.id}/status`)
        .set('x-csrf-token', csrfToken)
        .send({ isActive: false });
      expect(deactivated.status).toBe(200);
      expect(await redisClient.exists(cacheKey)).toBe(0);
      expect((await agent.get(`/${code}`)).status).toBe(410);
      const reactivated = await agent
        .patch(`/api/links/${created.body.data.id}/status`)
        .set('x-csrf-token', csrfToken)
        .send({ isActive: true });
      expect(reactivated.status).toBe(200);
      expect((await agent.get(`/${code}`)).status).toBe(302);
      const deleted = await agent
        .delete(`/api/links/${created.body.data.id}`)
        .set('x-csrf-token', csrfToken);
      expect(deleted.status).toBe(204);
      expect(await redisClient.exists(cacheKey)).toBe(0);
      expect((await agent.get(`/${code}`)).status).toBe(404);

      const otherIp = `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
      testIps.push(otherIp);
      const other = forwardedAgent(app, otherIp);
      const otherCsrf = await other.get('/api/auth/csrf');
      const otherRegistration = await other
        .post('/api/auth/register')
        .set('x-csrf-token', otherCsrf.body.csrfToken as string)
        .send({
          email: `integration-${randomUUID()}@example.test`,
          password: randomBytes(24).toString('base64url'),
        });
      expect(otherRegistration.status).toBe(201);
      userIds.push(otherRegistration.body.data.id as string);
      expect((await other.get(`/api/links/${created.body.data.id}`)).status).toBe(404);
      expect((await other.get('/api/analytics/total')).body.data.totalClicks).toBe(0);

      const limitedApp = createApp(
        new LinkService(instrumentedRepo, process.env.PUBLIC_BASE_URL, cache),
        new AnalyticsService(instrumentedRepo, process.env.PUBLIC_BASE_URL),
        {
          userRepository: userRepo,
          sessionStore: new PostgresSessionStore(),
          sessionSecret: randomBytes(48).toString('base64url'),
          trustProxyHops: 1,
          rateLimiters: createRateLimiters(true, {
            windowMs: 60_000,
            authMax: 10,
            createMax: 1,
            redirectMax: 100,
            analyticsMax: 100,
          }),
        },
      );
      const limitedAgent = request.agent(limitedApp);
      const forwardedIp = `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
      testIps.push(forwardedIp);
      const limitedCsrf = await limitedAgent
        .get('/api/auth/csrf')
        .set('x-forwarded-for', forwardedIp);
      const limitedRegistration = await limitedAgent
        .post('/api/auth/register')
        .set('x-forwarded-for', forwardedIp)
        .set('x-csrf-token', limitedCsrf.body.csrfToken as string)
        .send({
          email: `integration-${randomUUID()}@example.test`,
          password: randomBytes(24).toString('base64url'),
        });
      expect(limitedRegistration.status).toBe(201);
      userIds.push(limitedRegistration.body.data.id as string);
      const rateLimitedCode = `lim-${randomUUID().slice(0, 8)}`;
      testCodes.push(rateLimitedCode);
      const firstCreate = await limitedAgent
        .post('/api/links')
        .set('x-forwarded-for', forwardedIp)
        .set('x-csrf-token', limitedRegistration.body.csrfToken as string)
        .send({ destinationUrl: 'https://example.com/rate-limited', alias: rateLimitedCode });
      expect(firstCreate.status).toBe(201);
      const overLimit = await limitedAgent
        .post('/api/links')
        .set('x-forwarded-for', forwardedIp)
        .set('x-csrf-token', limitedRegistration.body.csrfToken as string)
        .send({
          destinationUrl: 'https://example.com/rate-limited-too',
          alias: `${rateLimitedCode}2`,
        });
      expect(overLimit.status).toBe(429);

      const expirationCode = `exp-${randomUUID().slice(0, 8)}`;
      testCodes.push(expirationCode);
      const expiresAt = new Date(Date.now() + 2_500).toISOString();
      const expiring = await agent
        .post('/api/links')
        .set('x-csrf-token', csrfToken)
        .send({ destinationUrl: 'https://example.com/expiring', alias: expirationCode, expiresAt });
      expect(expiring.status).toBe(201);
      const expiringKey = `linkpulse:short-code:${expirationCode}`;
      expect((await agent.get(`/${expirationCode}`)).status).toBe(302);
      expect(await redisClient.ttl(expiringKey)).toBeLessThanOrEqual(3);
      await new Promise((resolve) => setTimeout(resolve, 2_700));
      expect((await agent.get(`/${expirationCode}`)).status).toBe(410);

      process.env.REDIS_URL = 'redis://127.0.0.1:1';
      await closeRateLimitRedis();
      const downResponse = await agent.get('/api/analytics/total');
      expect(downResponse.status).toBe(503);
      if (oldRedisUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = oldRedisUrl;
      await closeRateLimitRedis();
      expect((await agent.get('/api/analytics/total')).status).toBe(200);

      const loggedOut = await agent.post('/api/auth/logout').set('x-csrf-token', csrfToken);
      expect(loggedOut.status).toBe(204);
      expect((await agent.get('/api/auth/me')).status).toBe(401);
      const refreshedCsrf = await agent.get('/api/auth/csrf');
      const loggedBackIn = await agent
        .post('/api/auth/login')
        .set('x-csrf-token', refreshedCsrf.body.csrfToken as string)
        .send({ email, password });
      expect(loggedBackIn.status).toBe(200);
      expect(loggedBackIn.body.csrfToken).not.toBe(refreshedCsrf.body.csrfToken);
      csrfToken = loggedBackIn.body.csrfToken as string;

      await getDb()
        .update(authSessions)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(sql`${authSessions.session}->>'userId' = ${userId}`);
      expect((await agent.get('/api/auth/me')).status).toBe(401);
    } finally {
      if (oldRedisUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = oldRedisUrl;
      await closeRateLimitRedis();
      for (const userId of userIds) {
        for (const testCode of testCodes) await cache.invalidate(testCode);
        await getDb().delete(links).where(eq(links.ownerId, userId));
        await getDb()
          .delete(authSessions)
          .where(sql`${authSessions.session}->>'userId' = ${userId}`);
        await getDb().delete(users).where(eq(users.id, userId));
      }
      await cache.close();
      if (redisClient?.isReady) {
        for await (const key of redisClient.scanIterator({ MATCH: 'linkpulse:limit:*' })) {
          if (testIps.some((ip) => key.includes(ip))) await redisClient.del(key);
        }
      }
      if (redisClient?.isOpen) await redisClient.quit();
    }
  }, 30_000);
});
