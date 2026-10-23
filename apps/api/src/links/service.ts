import { randomBytes } from 'node:crypto';
import { ApiError, ShortCodeConflictError } from './errors.js';
import type { LinkRepository } from './repository.js';
import type { LinkUpdate } from './repository.js';
import type { LinkCache } from '../cache/link-cache.js';
import { linkCacheTtlSeconds } from '../cache/link-cache.js';
import type { LinkRecord } from '../db/schema.js';
import { resolvePublicBaseUrl } from '../config/runtime.js';

const SHORT_CODE_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
const RESERVED_CODES = new Set(['api']);
const MAX_GENERATED_CODE_ATTEMPTS = 5;
const MAX_DESTINATION_LENGTH = 2048;

export type LinkView = {
  id: string;
  shortCode: string;
  shortUrl: string;
  destinationUrl: string;
  createdAt: string;
  expiresAt: string | null;
  isActive: boolean;
};

export type CreateLinkInput = {
  destinationUrl: unknown;
  alias?: unknown;
  expiresAt?: unknown;
};

export type Pagination = { page: number; limit: number };

export type PaginatedLinks = {
  data: LinkView[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

export type RedirectTarget = { linkId: string; destinationUrl: string };

export function validateDestinationUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_DESTINATION_LENGTH) {
    throw new ApiError(400, 'INVALID_DESTINATION_URL', 'Enter a valid HTTP or HTTPS URL.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiError(400, 'INVALID_DESTINATION_URL', 'Enter a valid HTTP or HTTPS URL.');
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new ApiError(
      400,
      'INVALID_DESTINATION_URL',
      'Only HTTP or HTTPS URLs without embedded credentials are allowed.',
    );
  }

  return parsed.toString();
}

function validateAlias(value: unknown): string {
  if (typeof value !== 'string' || !SHORT_CODE_PATTERN.test(value)) {
    throw new ApiError(
      400,
      'INVALID_ALIAS',
      'Aliases must be 3–32 characters using letters, numbers, hyphens, or underscores.',
    );
  }

  if (RESERVED_CODES.has(value.toLowerCase())) {
    throw new ApiError(400, 'RESERVED_ALIAS', 'That alias is reserved.');
  }

  return value;
}

function parseExpiration(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw new ApiError(400, 'INVALID_EXPIRATION', 'Expiration must be an ISO date string.');
  }

  const expiresAt = new Date(value);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new ApiError(400, 'INVALID_EXPIRATION', 'Expiration must be a valid future date.');
  }

  return expiresAt;
}

function generateShortCode(): string {
  return randomBytes(6).toString('base64url');
}

export class LinkService {
  private readonly publicBaseUrl: string;

  constructor(
    private readonly repository: LinkRepository,
    publicBaseUrl = resolvePublicBaseUrl(),
    private readonly cache?: LinkCache,
  ) {
    let parsedBase: URL;
    try {
      parsedBase = new URL(publicBaseUrl);
    } catch {
      throw new Error('PUBLIC_BASE_URL must be an absolute HTTP or HTTPS URL.');
    }
    if (
      !['http:', 'https:'].includes(parsedBase.protocol) ||
      parsedBase.pathname !== '/' ||
      parsedBase.search.length > 0 ||
      parsedBase.hash.length > 0 ||
      parsedBase.username.length > 0 ||
      parsedBase.password.length > 0
    ) {
      throw new Error('PUBLIC_BASE_URL must be an absolute HTTP or HTTPS URL.');
    }
    this.publicBaseUrl = parsedBase.origin;
  }

  async create(input: CreateLinkInput, ownerId: string): Promise<LinkView> {
    const destinationUrl = validateDestinationUrl(input.destinationUrl);
    const alias = input.alias === undefined ? undefined : validateAlias(input.alias);
    const expiresAt = parseExpiration(input.expiresAt);

    for (let attempt = 0; attempt < MAX_GENERATED_CODE_ATTEMPTS; attempt += 1) {
      const shortCode = alias ?? generateShortCode();
      try {
        const record = await this.repository.create({
          ownerId,
          shortCode,
          destinationUrl,
          expiresAt,
        });
        return this.toView(record);
      } catch (error) {
        if (!(error instanceof ShortCodeConflictError)) {
          throw error;
        }
        if (alias) {
          throw new ApiError(409, 'ALIAS_TAKEN', 'That custom alias is already in use.');
        }
      }
    }

    throw new ApiError(
      503,
      'SHORT_CODE_UNAVAILABLE',
      'A unique short code could not be allocated. Please try again.',
    );
  }

  async getById(id: string, ownerId: string): Promise<LinkView> {
    const record = await this.repository.findById(id, ownerId);
    if (!record) {
      throw new ApiError(404, 'LINK_NOT_FOUND', 'The requested link was not found.');
    }
    return this.toView(record);
  }

  async list(ownerId: string, { page, limit }: Pagination): Promise<PaginatedLinks> {
    const { items, total } = await this.repository.list(ownerId, limit, (page - 1) * limit);
    return {
      data: items.map((item) => this.toView(item)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async resolveForRedirect(shortCode: string): Promise<RedirectTarget> {
    let record: LinkRecord | undefined;
    try {
      record = await this.cache?.get(shortCode);
    } catch {
      // PostgreSQL remains authoritative when the cache is unavailable.
    }
    if (!record) {
      record = await this.repository.findByShortCode(shortCode);
      if (record?.isActive && (!record.expiresAt || record.expiresAt.getTime() > Date.now())) {
        try {
          await this.cache?.set(shortCode, record, linkCacheTtlSeconds(record));
        } catch {
          // Cache write failures must not prevent an otherwise valid redirect.
        }
      }
    }
    if (!record) {
      throw new ApiError(404, 'LINK_NOT_FOUND', 'The requested short link was not found.');
    }
    if (!record.isActive) {
      throw new ApiError(410, 'LINK_INACTIVE', 'This short link has been deactivated.');
    }
    if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
      try {
        await this.cache?.invalidate(shortCode);
      } catch {
        // The expired row is rejected on every request even if Redis is unavailable.
      }
      throw new ApiError(410, 'LINK_EXPIRED', 'This short link has expired.');
    }

    // Validate persisted data again so a corrupted row cannot become an open redirect.
    try {
      return { linkId: record.id, destinationUrl: validateDestinationUrl(record.destinationUrl) };
    } catch {
      throw new ApiError(
        500,
        'INVALID_STORED_DESTINATION',
        'This short link has an invalid destination.',
      );
    }
  }

  async update(
    id: string,
    ownerId: string,
    input: { destinationUrl?: unknown; expiresAt?: unknown },
  ): Promise<LinkView> {
    const patch: LinkUpdate = {};
    if (Object.hasOwn(input, 'destinationUrl')) {
      patch.destinationUrl = validateDestinationUrl(input.destinationUrl);
    }
    if (Object.hasOwn(input, 'expiresAt')) {
      patch.expiresAt = parseExpiration(input.expiresAt);
    }
    if (Object.keys(patch).length === 0) {
      throw new ApiError(400, 'EMPTY_UPDATE', 'Provide a destination URL or expiration to update.');
    }
    const updated = await this.repository.update(id, ownerId, patch);
    if (!updated) throw new ApiError(404, 'LINK_NOT_FOUND', 'The requested link was not found.');
    await this.invalidate(updated.shortCode);
    return this.toView(updated);
  }

  async setActive(id: string, ownerId: string, isActive: boolean): Promise<LinkView> {
    const updated = await this.repository.setActive(id, ownerId, isActive);
    if (!updated) throw new ApiError(404, 'LINK_NOT_FOUND', 'The requested link was not found.');
    await this.invalidate(updated.shortCode);
    return this.toView(updated);
  }

  async delete(id: string, ownerId: string): Promise<void> {
    const shortCode = await this.repository.deleteById(id, ownerId);
    if (!shortCode) throw new ApiError(404, 'LINK_NOT_FOUND', 'The requested link was not found.');
    await this.invalidate(shortCode);
  }

  async recordClick(linkId: string): Promise<void> {
    await this.repository.recordClick(linkId);
  }

  private async invalidate(shortCode: string): Promise<void> {
    try {
      await this.cache?.invalidate(shortCode);
    } catch {
      // The TTL bounds stale reads if Redis is unavailable during invalidation.
    }
  }

  private toView(record: LinkRecord): LinkView {
    return {
      id: record.id,
      shortCode: record.shortCode,
      shortUrl: `${this.publicBaseUrl}/${encodeURIComponent(record.shortCode)}`,
      destinationUrl: record.destinationUrl,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt?.toISOString() ?? null,
      isActive: record.isActive,
    };
  }
}
