import type { ClickSeries, TopLink } from '../api/links';
import ClickTrendChart from './ClickTrendChart';

type Props = {
  totalLinks: number | null;
  isLinksLoading: boolean;
  analyticsTotal: number | null;
  clicksLast30Days: number | null;
  clickSeries: ClickSeries | null;
  topLinks: TopLink[] | null;
  isAnalyticsLoading: boolean;
  analyticsError: string | null;
  onRetry: () => void;
};

export default function DashboardAnalytics({
  totalLinks,
  isLinksLoading,
  analyticsTotal,
  clicksLast30Days,
  clickSeries,
  topLinks,
  isAnalyticsLoading,
  analyticsError,
  onRetry,
}: Props) {
  return (
    <>
      <section className="metric-grid" aria-label="Workspace summary">
        <article className="metric-card">
          <span className="metric-label">TOTAL LINKS</span>
          <strong>{isLinksLoading && totalLinks === null ? '—' : (totalLinks ?? '—')}</strong>
          <span className="metric-foot">Saved in your workspace</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">TOTAL CLICKS</span>
          <strong>
            {isAnalyticsLoading && analyticsTotal === null ? '—' : (analyticsTotal ?? '—')}
          </strong>
          <span className="metric-foot">All recorded redirects</span>
        </article>
        <article className="metric-card metric-card-accent">
          <span className="metric-label">CLICKS · LAST 30 DAYS</span>
          <strong>
            {isAnalyticsLoading && clicksLast30Days === null ? '—' : (clicksLast30Days ?? '—')}
          </strong>
          <span className="metric-foot">From stored click events</span>
        </article>
      </section>

      <section className="analytics-grid" aria-label="Click analytics">
        <article className="dashboard-panel trend-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">LAST 30 DAYS</p>
              <h2>Click activity</h2>
            </div>
            <span className="panel-tag">DAILY</span>
          </div>
          {analyticsError ? (
            <div className="panel-state error-state" role="alert">
              <p>{analyticsError}</p>
              <button className="text-button" type="button" onClick={onRetry}>
                Try again
              </button>
            </div>
          ) : isAnalyticsLoading ? (
            <div className="panel-state" role="status">
              Loading click activity…
            </div>
          ) : (
            clickSeries && (
              <ClickTrendChart
                points={clickSeries.points}
                label="Daily clicks over the last 30 days"
              />
            )
          )}
        </article>

        <article className="dashboard-panel top-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">LAST 30 DAYS</p>
              <h2>Top links</h2>
            </div>
            <span className="panel-tag">TOP 5</span>
          </div>
          {analyticsError ? (
            <div className="panel-state error-state" role="alert">
              <p>{analyticsError}</p>
            </div>
          ) : isAnalyticsLoading || topLinks === null ? (
            <div className="panel-state" role="status">
              Loading top links…
            </div>
          ) : topLinks.length === 0 ? (
            <div className="panel-state empty-state">
              <span className="empty-icon" aria-hidden="true">
                ↗
              </span>
              <p>
                Share a short link to get started. Links with recorded clicks from the last 30 days
                will rank here.
              </p>
            </div>
          ) : (
            <ol className="top-links-list">
              {topLinks.map((link, index) => (
                <li key={link.linkId}>
                  <span className="top-rank">{String(index + 1).padStart(2, '0')}</span>
                  <div className="top-link-copy">
                    <a href={link.shortUrl} target="_blank" rel="noreferrer">
                      /{link.shortCode}
                    </a>
                    <span title={link.destinationUrl}>{link.destinationUrl}</span>
                  </div>
                  <strong>{link.totalClicks}</strong>
                </li>
              ))}
            </ol>
          )}
        </article>
      </section>
    </>
  );
}
