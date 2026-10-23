import type { FormEvent } from 'react';
import type { Link, LinkAnalytics } from '../api/links';
import ClickTrendChart from './ClickTrendChart';

type Props = {
  links: Link[];
  filteredLinks: Link[];
  linkAnalytics: Record<string, LinkAnalytics | null>;
  totalLinks: number | null;
  totalPages: number;
  page: number;
  search: string;
  isLinksLoading: boolean;
  linksError: string | null;
  linkAnalyticsError: string | null;
  copyError: string | null;
  copiedLinkId: string | null;
  editingId: string | null;
  editError: string | null;
  confirmDeleteId: string | null;
  busyLinkId: string | null;
  expandedAnalyticsId: string | null;
  onSearchChange: (value: string) => void;
  onRetry: () => void;
  onPageChange: (page: number) => void;
  onCopy: (link: Pick<Link, 'id' | 'shortUrl'>) => Promise<void>;
  onEditToggle: (id: string) => void;
  onEditSubmit: (event: FormEvent<HTMLFormElement>, link: Link) => void;
  onEditCancel: () => void;
  onToggleActive: (link: Link) => void;
  onDeleteRequest: (id: string) => void;
  onDeleteConfirm: (link: Link) => void;
  onDeleteCancel: () => void;
  onAnalyticsToggle: (id: string) => void;
};

function isExpired(link: Link): boolean {
  return link.expiresAt !== null && new Date(link.expiresAt).getTime() <= Date.now();
}

function linkStatus(link: Link): string {
  if (!link.isActive) return 'Inactive';
  if (isExpired(link)) return 'Expired';
  return 'Active';
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unknown date'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function toLocalDateTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export default function SavedLinksSection({
  links,
  filteredLinks,
  linkAnalytics,
  totalLinks,
  totalPages,
  page,
  search,
  isLinksLoading,
  linksError,
  linkAnalyticsError,
  copyError,
  copiedLinkId,
  editingId,
  editError,
  confirmDeleteId,
  busyLinkId,
  expandedAnalyticsId,
  onSearchChange,
  onRetry,
  onPageChange,
  onCopy,
  onEditToggle,
  onEditSubmit,
  onEditCancel,
  onToggleActive,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
  onAnalyticsToggle,
}: Props) {
  return (
    <section className="links-section dashboard-links" aria-labelledby="links-heading">
      <div className="links-heading-row">
        <div>
          <p className="eyebrow">YOUR LIBRARY</p>
          <h2 id="links-heading">Saved links</h2>
        </div>
        <span className="link-count" aria-label={`${totalLinks ?? 0} saved links`}>
          {totalLinks ?? '—'} <span>LINKS</span>
        </span>
      </div>
      <div className="list-tools">
        <label className="search-field" htmlFor="link-search">
          <span className="sr-only">Search links on this page</span>
          <input
            id="link-search"
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search this page by alias or destination"
          />
        </label>
        <span className="page-caption">{totalLinks === null ? '—' : `${totalLinks} total`}</span>
      </div>
      {copyError && (
        <p className="form-message error-message" role="alert">
          {copyError}
        </p>
      )}
      {linkAnalyticsError && (
        <p className="notice error-notice" role="alert">
          {linkAnalyticsError}
        </p>
      )}
      {linksError ? (
        <div className="list-state error-state" role="alert">
          <p>{linksError}</p>
          <button className="text-button" type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : isLinksLoading ? (
        <div className="list-state" role="status">
          Loading your links…
        </div>
      ) : links.length === 0 ? (
        <div className="list-state empty-state">
          <span className="empty-icon" aria-hidden="true">
            ↗
          </span>
          <p>No links yet. Create your first short link above.</p>
        </div>
      ) : filteredLinks.length === 0 ? (
        <div className="list-state empty-state">
          <p>No links on this page match “{search}”.</p>
          <button className="text-button" type="button" onClick={() => onSearchChange('')}>
            Clear search
          </button>
        </div>
      ) : (
        <>
          <div className="link-list-head" aria-hidden="true">
            <span>SHORT LINK / DESTINATION</span>
            <span>CLICKS</span>
            <span>LINK ACTIONS</span>
          </div>
          <ul className="link-list dashboard-link-list" aria-label="Saved links">
            {filteredLinks.map((link) => {
              const stats = linkAnalytics[link.id];
              return (
                <li className="managed-link" key={link.id}>
                  <div className="link-row">
                    <div className="link-main">
                      <div className="link-short-line">
                        <a
                          className="short-url"
                          href={link.shortUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {link.shortUrl}
                        </a>
                        <span className={`link-status ${linkStatus(link).toLowerCase()}`}>
                          <span aria-hidden="true" />
                          {linkStatus(link)}
                        </span>
                      </div>
                      <p className="destination" title={link.destinationUrl}>
                        {link.destinationUrl}
                      </p>
                      <p className="created-date">
                        Created {formatDate(link.createdAt)}
                        {link.expiresAt && ` · Expires ${formatDate(link.expiresAt)}`}
                      </p>
                    </div>
                    <div className="link-clicks" aria-label="All-time clicks">
                      <strong>
                        {stats ? stats.totalClicks : stats === null ? 'Unavailable' : '…'}
                      </strong>
                      <span>ALL-TIME</span>
                    </div>
                    <div className="link-actions">
                      <button
                        className="copy-button"
                        type="button"
                        onClick={() => void onCopy(link)}
                      >
                        {copiedLinkId === link.id ? 'Copied' : 'Copy'}
                      </button>
                      <button
                        className="link-action-button"
                        type="button"
                        onClick={() => onEditToggle(link.id)}
                        aria-expanded={editingId === link.id}
                      >
                        Edit
                      </button>
                      <button
                        className="link-action-button"
                        type="button"
                        onClick={() => onToggleActive(link)}
                        disabled={busyLinkId === link.id}
                      >
                        {link.isActive ? 'Deactivate' : 'Reactivate'}
                      </button>
                      {confirmDeleteId === link.id ? (
                        <>
                          <button
                            className="link-action-button danger-action"
                            type="button"
                            onClick={() => onDeleteConfirm(link)}
                            disabled={busyLinkId === link.id}
                          >
                            {busyLinkId === link.id ? 'Deleting…' : 'Confirm delete'}
                          </button>
                          <button
                            className="link-action-button"
                            type="button"
                            onClick={onDeleteCancel}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          className="link-action-button danger-action"
                          type="button"
                          onClick={() => onDeleteRequest(link.id)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                  {editingId === link.id && (
                    <form
                      className="edit-link-form"
                      onSubmit={(event) => onEditSubmit(event, link)}
                    >
                      <label className="field" htmlFor={`edit-destination-${link.id}`}>
                        Destination URL
                        <input
                          id={`edit-destination-${link.id}`}
                          name="destinationUrl"
                          type="url"
                          defaultValue={link.destinationUrl}
                          maxLength={2048}
                          required
                        />
                      </label>
                      <label className="field" htmlFor={`edit-expiration-${link.id}`}>
                        Expiration <em>OPTIONAL</em>
                        <input
                          id={`edit-expiration-${link.id}`}
                          name="expiresAt"
                          type="datetime-local"
                          defaultValue={toLocalDateTime(link.expiresAt)}
                        />
                      </label>
                      {editError && (
                        <p className="form-message error-message" role="alert">
                          {editError}
                        </p>
                      )}
                      <div className="edit-actions">
                        <button
                          className="primary-button compact-button"
                          type="submit"
                          disabled={busyLinkId === link.id}
                        >
                          {busyLinkId === link.id ? 'Saving…' : 'Save changes'}
                        </button>
                        <button className="link-action-button" type="button" onClick={onEditCancel}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                  <div className="link-detail-row">
                    <span>
                      {stats
                        ? `${stats.totalClicks} all-time clicks · trend shows last 30 days`
                        : stats === null
                          ? 'Click count unavailable'
                          : 'Loading click count…'}
                    </span>
                    {stats && (
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => onAnalyticsToggle(link.id)}
                        aria-expanded={expandedAnalyticsId === link.id}
                      >
                        {expandedAnalyticsId === link.id ? 'Hide trend' : 'View trend'}
                      </button>
                    )}
                  </div>
                  {expandedAnalyticsId === link.id && stats && (
                    <div className="link-trend">
                      <ClickTrendChart
                        points={stats.clicksOverTime}
                        label={`Daily clicks for ${link.shortCode}`}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {totalPages > 1 && (
        <nav className="pagination" aria-label="Saved links pages">
          <button
            className="secondary-button"
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1 || isLinksLoading}
          >
            Previous
          </button>
          <span>
            Page {page} of {totalPages}
          </span>
          <button
            className="secondary-button"
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages || isLinksLoading}
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}
