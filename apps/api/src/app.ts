import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { sql } from 'drizzle-orm';
import { ApiError } from './links/errors.js';
import { PostgresLinkRepository } from './links/repository.js';
import { LinkService } from './links/service.js';
import { createLinksRouter } from './routes/links.js';
import { RedisLinkCache } from './cache/link-cache.js';
import { AnalyticsService } from './analytics/service.js';
import { createAnalyticsRouter } from './routes/analytics.js';
import { requireCsrf, requireUser } from './auth/middleware.js';
import { AuthenticationService } from './auth/service.js';
import { PostgresUserRepository, type UserRepository } from './auth/repository.js';
import { PostgresSessionStore } from './auth/session-store.js';
import { createAuthRouter } from './routes/auth.js';
import {
  requireDatabaseUrl,
  requireSessionSecret,
  resolveTrustProxyHops,
} from './config/runtime.js';
import { getDb } from './db/client.js';
import {
  checkRateLimitRedis,
  createRateLimiters,
  closeRateLimitRedis,
  type RateLimiters,
} from './security/rate-limit.js';

const repository = new PostgresLinkRepository();
const linkCache = new RedisLinkCache();

export type AppOptions = {
  userRepository?: UserRepository;
  sessionStore?: session.Store;
  sessionSecret?: string;
  rateLimiters?: RateLimiters;
  distributedRateLimits?: boolean;
  trustProxyHops?: number;
};

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const csrfForMutations: RequestHandler = (request, _response, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    requireCsrf(request, _response, next);
    return;
  }
  next();
};

export function createApp(
  linkService = new LinkService(repository, undefined, linkCache),
  analyticsService = new AnalyticsService(repository),
  options: AppOptions = {},
) {
  if (!options.userRepository || !options.sessionStore) requireDatabaseUrl();
  const app = express();
  const production = process.env.NODE_ENV === 'production';
  const trustProxyHops = options.trustProxyHops ?? resolveTrustProxyHops();
  const userRepository = options.userRepository ?? new PostgresUserRepository();
  const authService = new AuthenticationService(userRepository);
  const rateLimiters =
    options.rateLimiters ?? createRateLimiters(options.distributedRateLimits ?? true);

  app.set('trust proxy', trustProxyHops);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: production ? undefined : false,
      hsts: production ? undefined : false,
    }),
  );
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok', service: 'linkpulse-api' });
  });

  app.get('/api/health/ready', async (_request, response) => {
    try {
      await getDb().execute(sql`select 1`);
      await checkRateLimitRedis();
      response.json({ status: 'ready', database: 'ok', redis: 'ok' });
    } catch {
      response.status(503).json({ status: 'not_ready', dependencies: 'unavailable' });
    }
  });

  app.use(
    ['/api/auth', '/api/links', '/api/analytics'],
    session({
      name: 'linkpulse.sid',
      secret: options.sessionSecret ?? requireSessionSecret(),
      store: options.sessionStore ?? new PostgresSessionStore(),
      resave: false,
      saveUninitialized: false,
      rolling: false,
      proxy: trustProxyHops > 0,
      cookie: {
        httpOnly: true,
        secure: production,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_TTL_MS,
      },
    }),
  );

  app.use('/api/auth', csrfForMutations, createAuthRouter(authService, rateLimiters.auth));
  app.use(
    '/api/links',
    requireUser,
    csrfForMutations,
    createLinksRouter(linkService, rateLimiters.createLink),
  );
  app.use(
    '/api/analytics',
    requireUser,
    createAnalyticsRouter(analyticsService, rateLimiters.analytics),
  );

  app.use('/api', (_request, response) => {
    response.status(404).json({
      error: { code: 'API_ROUTE_NOT_FOUND', message: 'The requested API route was not found.' },
    });
  });

  app.get('/:shortCode', rateLimiters.redirect, async (request, response) => {
    const { shortCode } = request.params;
    if (typeof shortCode !== 'string') {
      throw new ApiError(404, 'LINK_NOT_FOUND', 'The requested short link was not found.');
    }
    const target = await linkService.resolveForRedirect(shortCode);
    await linkService.recordClick(target.linkId);
    response.redirect(302, target.destinationUrl);
  });

  app.use((_request, response) => {
    response.status(404).json({
      error: { code: 'ROUTE_NOT_FOUND', message: 'The requested route was not found.' },
    });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    void next;
    if (error instanceof ApiError) {
      response.status(error.status).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }

    if (
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.parse.failed'
    ) {
      response.status(400).json({
        error: { code: 'INVALID_JSON', message: 'The request body must contain valid JSON.' },
      });
      return;
    }

    if (
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.too.large'
    ) {
      response.status(413).json({
        error: { code: 'REQUEST_TOO_LARGE', message: 'The request body exceeds the allowed size.' },
      });
      return;
    }

    response.status(500).json({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected server error occurred.' },
    });
  };
  app.use(errorHandler);

  return app;
}

export async function closeAppResources(): Promise<void> {
  await Promise.all([linkCache.close(), closeRateLimitRedis()]);
}
