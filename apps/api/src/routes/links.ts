import { Router } from 'express';
import { ApiError } from '../links/errors.js';
import type { LinkService } from '../links/service.js';
import { authenticatedUserId } from '../auth/middleware.js';
import type { RequestHandler } from 'express';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parsePositiveInteger(
  value: unknown,
  field: string,
  fallback: number,
  max?: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ApiError(400, 'INVALID_PAGINATION', `${field} must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) {
    throw new ApiError(
      400,
      'INVALID_PAGINATION',
      max === undefined
        ? `${field} must be a positive integer.`
        : `${field} must be between 1 and ${max}.`,
    );
  }
  return parsed;
}

function requestBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'Send a JSON object in the request body.');
  }
  return value as Record<string, unknown>;
}

export function createLinksRouter(service: LinkService, createLimiter?: RequestHandler): Router {
  const router = Router();

  router.post('/', ...(createLimiter ? [createLimiter] : []), async (request, response) => {
    const body = requestBody(request.body);
    const data = await service.create(
      {
        destinationUrl: body.destinationUrl,
        alias: body.alias,
        expiresAt: body.expiresAt,
      },
      authenticatedUserId(request),
    );
    response.status(201).json({ data });
  });

  router.get('/', async (request, response) => {
    const page = parsePositiveInteger(request.query.page, 'page', 1);
    const limit = parsePositiveInteger(request.query.limit, 'limit', 20, 100);
    response.json(await service.list(authenticatedUserId(request), { page, limit }));
  });

  router.get('/:id', async (request, response) => {
    if (!UUID_PATTERN.test(request.params.id)) {
      throw new ApiError(400, 'INVALID_ID', 'The link ID must be a UUID.');
    }
    response.json({ data: await service.getById(request.params.id, authenticatedUserId(request)) });
  });

  router.patch('/:id', async (request, response) => {
    if (!UUID_PATTERN.test(request.params.id)) {
      throw new ApiError(400, 'INVALID_ID', 'The link ID must be a UUID.');
    }
    const body = requestBody(request.body);
    const patch: { destinationUrl?: unknown; expiresAt?: unknown } = {};
    if (Object.hasOwn(body, 'destinationUrl')) patch.destinationUrl = body.destinationUrl;
    if (Object.hasOwn(body, 'expiresAt')) patch.expiresAt = body.expiresAt;
    response.json({
      data: await service.update(request.params.id, authenticatedUserId(request), patch),
    });
  });

  router.patch('/:id/status', async (request, response) => {
    if (!UUID_PATTERN.test(request.params.id)) {
      throw new ApiError(400, 'INVALID_ID', 'The link ID must be a UUID.');
    }
    const body = requestBody(request.body);
    if (typeof body.isActive !== 'boolean') {
      throw new ApiError(400, 'INVALID_STATUS', 'isActive must be a boolean.');
    }
    response.json({
      data: await service.setActive(request.params.id, authenticatedUserId(request), body.isActive),
    });
  });

  router.delete('/:id', async (request, response) => {
    if (!UUID_PATTERN.test(request.params.id)) {
      throw new ApiError(400, 'INVALID_ID', 'The link ID must be a UUID.');
    }
    await service.delete(request.params.id, authenticatedUserId(request));
    response.status(204).end();
  });

  return router;
}
