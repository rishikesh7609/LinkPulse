import { createClient } from 'redis';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { RequestHandler } from 'express';
import { ApiError } from '../links/errors.js';
import { requireRedisUrl } from '../config/runtime.js';

type Limits = {
  windowMs: number;
  authMax: number;
  createMax: number;
  redirectMax: number;
  analyticsMax: number;
};

function positiveSetting(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

export function readRateLimits(): Limits {
  return {
    windowMs: positiveSetting('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
    authMax: positiveSetting('RATE_LIMIT_AUTH_MAX', 10),
    createMax: positiveSetting('RATE_LIMIT_CREATE_MAX', 30),
    redirectMax: positiveSetting('RATE_LIMIT_REDIRECT_MAX', 120),
    analyticsMax: positiveSetting('RATE_LIMIT_ANALYTICS_MAX', 120),
  };
}

let redisClient: ReturnType<typeof createClient> | undefined;
let connecting: Promise<void> | undefined;

async function sendRedisCommand(...args: string[]): Promise<number> {
  if (!redisClient) {
    redisClient = createClient({
      url: requireRedisUrl(),
      socket: {
        connectTimeout: 5_000,
        reconnectStrategy: (retries) =>
          retries >= 3 ? false : Math.min(250 * 2 ** retries, 1_000),
      },
    });
    redisClient.on('error', () => undefined);
  }
  if (!redisClient.isOpen) {
    connecting ??= redisClient
      .connect()
      .then(() => undefined)
      .finally(() => {
        connecting = undefined;
      });
    await connecting;
  }
  return (await redisClient.sendCommand(args)) as number;
}

function createLimiter(
  prefix: string,
  windowMs: number,
  limit: number,
  distributed: boolean,
): RequestHandler {
  const store = distributed
    ? new RedisStore({
        prefix: `linkpulse:limit:${prefix}:`,
        sendCommand: (...args: string[]) => sendRedisCommand(...args),
      })
    : undefined;

  const limiter = rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    passOnStoreError: false,
    ...(store ? { store } : {}),
    handler: (_request, response) => {
      response.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
      });
    },
  });

  return (request, response, next) => {
    limiter(request, response, (error?: unknown) => {
      if (error) {
        next(
          new ApiError(
            503,
            'RATE_LIMITER_UNAVAILABLE',
            'Request protection is temporarily unavailable.',
          ),
        );
      } else {
        next();
      }
    });
  };
}

export type RateLimiters = {
  auth: RequestHandler;
  createLink: RequestHandler;
  redirect: RequestHandler;
  analytics: RequestHandler;
};

export function createRateLimiters(distributed = true, values = readRateLimits()): RateLimiters {
  if (distributed) requireRedisUrl();
  return {
    auth: createLimiter('auth', values.windowMs, values.authMax, distributed),
    createLink: createLimiter('create', values.windowMs, values.createMax, distributed),
    redirect: createLimiter('redirect', values.windowMs, values.redirectMax, distributed),
    analytics: createLimiter('analytics', values.windowMs, values.analyticsMax, distributed),
  };
}

export async function closeRateLimitRedis(): Promise<void> {
  if (redisClient?.isOpen) {
    try {
      await redisClient.quit();
    } catch {
      redisClient.destroy();
    }
  }
  redisClient = undefined;
  connecting = undefined;
}

export async function checkRateLimitRedis(): Promise<void> {
  await sendRedisCommand('PING');
}
