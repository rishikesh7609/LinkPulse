import { describe, expect, it } from 'vitest';
import {
  requireDatabaseUrl,
  requireRedisUrl,
  requireSessionSecret,
  resolveApiPort,
  resolvePublicBaseUrl,
  resolveTrustProxyHops,
} from './runtime.js';

describe('production runtime configuration', () => {
  it('requires an explicit public URL in production', () => {
    expect(() => resolvePublicBaseUrl({ NODE_ENV: 'production' })).toThrow(
      'PUBLIC_BASE_URL is required in production.',
    );
  });

  it('uses the configured public URL', () => {
    expect(
      resolvePublicBaseUrl({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://go.example.test' }),
    ).toBe('https://go.example.test');
  });

  it('requires an HTTPS public URL in production', () => {
    expect(() =>
      resolvePublicBaseUrl({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://links.test' }),
    ).toThrow('PUBLIC_BASE_URL must be an absolute HTTPS URL in production.');
  });

  it('prefers the hosting platform PORT over the local API_PORT', () => {
    expect(resolveApiPort({ PORT: '10000', API_PORT: '3001' })).toBe(10_000);
  });

  it('rejects invalid port configuration', () => {
    expect(() => resolveApiPort({ PORT: 'not-a-port' })).toThrow(
      'PORT must be an integer between 1 and 65535.',
    );
  });

  it('requires an explicit database URL instead of a localhost fallback', () => {
    expect(() => requireDatabaseUrl({})).toThrow('DATABASE_URL is required for database commands.');
    expect(requireDatabaseUrl({ DATABASE_URL: 'postgresql://db.example.test/linkpulse' })).toBe(
      'postgresql://db.example.test/linkpulse',
    );
  });

  it('requires a sufficiently long session signing secret without providing a fallback', () => {
    expect(() => requireSessionSecret({})).toThrow(
      'SESSION_SECRET must contain at least 32 bytes.',
    );
    expect(() => requireSessionSecret({ SESSION_SECRET: 'short' })).toThrow(
      'SESSION_SECRET must contain at least 32 bytes.',
    );
    expect(requireSessionSecret({ SESSION_SECRET: 'a'.repeat(48) })).toHaveLength(48);
  });

  it('validates Redis protocol configuration without exposing credentials', () => {
    expect(() => requireRedisUrl({})).toThrow(
      'REDIS_URL is required for distributed request limits.',
    );
    expect(() => requireRedisUrl({ REDIS_URL: 'http://redis.test' })).toThrow(
      'REDIS_URL must be a valid redis:// or rediss:// URL.',
    );
    expect(requireRedisUrl({ REDIS_URL: 'rediss://redis.test:6379' })).toBe(
      'rediss://redis.test:6379',
    );
  });

  it('defaults to no trusted proxies and rejects broad or invalid proxy settings', () => {
    expect(resolveTrustProxyHops({})).toBe(0);
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '1' })).toBe(1);
    expect(() => resolveTrustProxyHops({ TRUST_PROXY_HOPS: 'true' })).toThrow(
      'TRUST_PROXY_HOPS must be a non-negative integer.',
    );
    expect(() => resolveTrustProxyHops({ TRUST_PROXY_HOPS: '6' })).toThrow(
      'TRUST_PROXY_HOPS must be between 0 and 5.',
    );
  });
});
