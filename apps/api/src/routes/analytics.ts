import { Router } from 'express';
import { ApiError } from '../links/errors.js';
import type { AnalyticsService } from '../analytics/service.js';
import type { RequestHandler } from 'express';
import { authenticatedUserId } from '../auth/middleware.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function positiveInteger(value: unknown, name: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ApiError(400, 'INVALID_QUERY', `${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ApiError(400, 'INVALID_QUERY', `${name} must be between 1 and ${max}.`);
  }
  return parsed;
}

export function createAnalyticsRouter(service: AnalyticsService, limiter?: RequestHandler): Router {
  const router = Router();
  if (limiter) router.use(limiter);

  router.get('/total', async (request, response) => {
    response.json({ data: await service.total(authenticatedUserId(request)) });
  });

  router.get('/timeseries', async (request, response) => {
    const days = positiveInteger(request.query.days, 'days', 30, 365);
    response.json({
      data: { days, points: await service.timeseries(authenticatedUserId(request), days) },
    });
  });

  router.get('/top', async (request, response) => {
    const limit = positiveInteger(request.query.limit, 'limit', 10, 50);
    const days = positiveInteger(request.query.days, 'days', 30, 365);
    response.json({ data: await service.topLinks(authenticatedUserId(request), limit, days) });
  });

  router.get('/links/:id', async (request, response) => {
    if (!UUID_PATTERN.test(request.params.id)) {
      throw new ApiError(400, 'INVALID_ID', 'The link ID must be a UUID.');
    }
    const days = positiveInteger(request.query.days, 'days', 30, 365);
    response.json({
      data: await service.forLink(request.params.id, authenticatedUserId(request), days),
    });
  });

  return router;
}
