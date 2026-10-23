import { ApiError } from '../links/errors.js';
import type { LinkRepository } from '../links/repository.js';
import { resolvePublicBaseUrl } from '../config/runtime.js';

export class AnalyticsService {
  constructor(
    private readonly repository: LinkRepository,
    private readonly publicBaseUrl = resolvePublicBaseUrl(),
  ) {}

  async total(ownerId: string) {
    return { totalClicks: await this.repository.totalClicks(ownerId) };
  }

  async timeseries(ownerId: string, days: number) {
    return this.repository.clicksOverTime(this.startDate(days), ownerId);
  }

  async topLinks(ownerId: string, limit: number, days: number) {
    const links = await this.repository.topLinks(limit, this.startDate(days), ownerId);
    return links.map((link) => ({
      ...link,
      shortUrl: `${this.publicBaseUrl}/${encodeURIComponent(link.shortCode)}`,
    }));
  }

  async forLink(linkId: string, ownerId: string, days: number) {
    const link = await this.repository.findById(linkId, ownerId);
    if (!link) throw new ApiError(404, 'LINK_NOT_FOUND', 'The requested link was not found.');
    const [totalClicks, clicksOverTime] = await Promise.all([
      this.repository.linkClickCount(linkId, ownerId),
      this.repository.clicksOverTime(this.startDate(days), ownerId, linkId),
    ]);
    return { linkId, shortCode: link.shortCode, totalClicks, clicksOverTime };
  }

  private startDate(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }
}
