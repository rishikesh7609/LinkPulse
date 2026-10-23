export function resolvePublicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PUBLIC_BASE_URL?.trim();
  if (env.NODE_ENV === 'production') {
    if (!configured) throw new Error('PUBLIC_BASE_URL is required in production.');

    let parsed: URL;
    try {
      parsed = new URL(configured);
    } catch {
      throw new Error('PUBLIC_BASE_URL must be an absolute HTTPS URL in production.');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('PUBLIC_BASE_URL must be an absolute HTTPS URL in production.');
    }
  }

  if (configured) return configured;
  return `http://localhost:${env.API_PORT ?? env.PORT ?? '3001'}`;
}

export function resolveApiPort(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.PORT ?? env.API_PORT ?? '3001';
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DATABASE_URL?.trim();
  if (!configured) throw new Error('DATABASE_URL is required for database commands.');
  return configured;
}

export function requireSessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 bytes.');
  }
  return secret;
}

export function requireRedisUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.REDIS_URL?.trim();
  if (!value) throw new Error('REDIS_URL is required for distributed request limits.');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('REDIS_URL must be a valid redis:// or rediss:// URL.');
  }
  if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('REDIS_URL must be a valid redis:// or rediss:// URL.');
  }
  return value;
}

export function resolveTrustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.TRUST_PROXY_HOPS ?? '0';
  if (!/^\d+$/.test(value)) {
    throw new Error('TRUST_PROXY_HOPS must be a non-negative integer.');
  }
  const hops = Number(value);
  if (!Number.isSafeInteger(hops) || hops > 5) {
    throw new Error('TRUST_PROXY_HOPS must be between 0 and 5.');
  }
  return hops;
}
