import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { ApiError } from '../links/errors.js';

export const requireUser: RequestHandler = (request, _response, next) => {
  if (!request.session.userId) {
    next(new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to manage your links.'));
    return;
  }
  request.authenticatedUserId = request.session.userId;
  next();
};

export function authenticatedUserId(request: import('express').Request): string {
  const id = request.authenticatedUserId;
  if (!id) throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to manage your links.');
  return id;
}

export const requireCsrf: RequestHandler = (request, _response, next) => {
  const expected = request.session.csrfTokenHashes;
  const supplied = request.get('x-csrf-token');
  if (!expected?.length || !supplied) {
    next(new ApiError(403, 'CSRF_INVALID', 'Refresh the page and try again.'));
    return;
  }
  const suppliedHash = Buffer.from(createHash('sha256').update(supplied).digest('hex'));
  const matches = expected.some((hash) => {
    const expectedBytes = Buffer.from(hash);
    return (
      expectedBytes.length === suppliedHash.length && timingSafeEqual(expectedBytes, suppliedHash)
    );
  });
  if (!matches) {
    next(new ApiError(403, 'CSRF_INVALID', 'Refresh the page and try again.'));
    return;
  }
  next();
};

declare module 'express-serve-static-core' {
  interface Request {
    authenticatedUserId?: string;
  }
}
