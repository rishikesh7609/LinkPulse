import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Request } from 'express';
import { ApiError } from '../links/errors.js';
import type { AuthenticationService } from '../auth/service.js';
import type { RequestHandler } from 'express';

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'Send a JSON object in the request body.');
  }
  return value as Record<string, unknown>;
}

function regenerate(request: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    request.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function save(request: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    request.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function issueCsrfToken(request: Request): string {
  const token = randomBytes(32).toString('base64url');
  const hashes = request.session.csrfTokenHashes ?? [];
  request.session.csrfTokenHashes = [
    ...hashes.slice(-7),
    createHash('sha256').update(token).digest('hex'),
  ];
  return token;
}

async function establishSession(request: Request, userId: string): Promise<string> {
  await regenerate(request);
  request.session.userId = userId;
  const token = issueCsrfToken(request);
  await save(request);
  return token;
}

export function createAuthRouter(
  service: AuthenticationService,
  authLimiter?: RequestHandler,
): Router {
  const router = Router();

  router.get('/csrf', ...(authLimiter ? [authLimiter] : []), async (request, response) => {
    const csrfToken = issueCsrfToken(request);
    await save(request);
    response.json({ csrfToken });
  });

  router.get('/me', async (request, response) => {
    const id = request.session.userId;
    if (!id) throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue.');
    const user = await service.findUser(id);
    if (!user) {
      await new Promise<void>((resolve, reject) => {
        request.session.destroy((error) => (error ? reject(error) : resolve()));
      });
      throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue.');
    }
    response.json({ data: user });
  });

  router.post('/register', ...(authLimiter ? [authLimiter] : []), async (request, response) => {
    const body = objectBody(request.body);
    const user = await service.register(body.email, body.password);
    const csrfToken = await establishSession(request, user.id);
    response.status(201).json({ data: user, csrfToken });
  });

  router.post('/login', ...(authLimiter ? [authLimiter] : []), async (request, response) => {
    const body = objectBody(request.body);
    const user = await service.login(body.email, body.password);
    const csrfToken = await establishSession(request, user.id);
    response.json({ data: user, csrfToken });
  });

  router.post('/logout', async (request, response) => {
    await new Promise<void>((resolve, reject) => {
      request.session.destroy((error) => (error ? reject(error) : resolve()));
    });
    response.clearCookie('linkpulse.sid', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });
    response.status(204).end();
  });

  return router;
}
