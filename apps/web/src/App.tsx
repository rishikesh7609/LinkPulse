import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import AuthScreen from './components/AuthScreen';
import { getCurrentUser, logout, type AuthUser } from './api/auth';
import { LinkApiError } from './api/links';
import {
  createLink,
  deleteLink,
  getAnalyticsTotal,
  getClickSeries,
  getLinkAnalytics,
  getLinks,
  getTopLinks,
  setLinkActive,
  updateLink,
  type ClickSeries,
  type Link,
  type LinkAnalytics,
  type TopLink,
} from './api/links';
import DashboardAnalytics from './components/DashboardAnalytics';
import LinkCreateForm from './components/LinkCreateForm';
import SavedLinksSection from './components/SavedLinksSection';

const PAGE_SIZE = 10;

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const onExpired = () => setUser(null);
    window.addEventListener('linkpulse:auth-expired', onExpired);
    void getCurrentUser(controller.signal)
      .then((current) => setUser(current))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof LinkApiError && cause.code !== 'AUTHENTICATION_REQUIRED') {
          setSessionError(cause.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsCheckingSession(false);
      });
    return () => {
      controller.abort();
      window.removeEventListener('linkpulse:auth-expired', onExpired);
    };
  }, []);

  if (isCheckingSession) {
    return (
      <div className="auth-loading" role="status">
        Loading your workspace…
      </div>
    );
  }
  if (!user) return <AuthScreen onAuthenticated={setUser} serviceError={sessionError} />;
  return <Dashboard user={user} onLogout={() => setUser(null)} />;
}

function Dashboard({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [links, setLinks] = useState<Link[]>([]);
  const [totalLinks, setTotalLinks] = useState<number | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [page, setPage] = useState(1);
  const [isLinksLoading, setIsLinksLoading] = useState(true);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [analyticsTotal, setAnalyticsTotal] = useState<number | null>(null);
  const [clickSeries, setClickSeries] = useState<ClickSeries | null>(null);
  const [topLinks, setTopLinks] = useState<TopLink[] | null>(null);
  const [isAnalyticsLoading, setIsAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [linkAnalytics, setLinkAnalytics] = useState<Record<string, LinkAnalytics | null>>({});
  const [linkAnalyticsError, setLinkAnalyticsError] = useState<string | null>(null);
  const analyticsCache = useRef(new Map<string, LinkAnalytics>());
  const [search, setSearch] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdLink, setCreatedLink] = useState<Link | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null);
  const [expandedAnalyticsId, setExpandedAnalyticsId] = useState<string | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const loadLinks = useCallback(async (targetPage: number, signal?: AbortSignal, force = false) => {
    setIsLinksLoading(true);
    setLinksError(null);
    setLinkAnalyticsError(null);
    if (force) {
      analyticsCache.current.clear();
      setLinkAnalytics({});
    }
    try {
      const response = await getLinks(targetPage, PAGE_SIZE, signal);
      if (signal?.aborted) return;
      setLinks(response.data);
      setTotalLinks(response.pagination.total);
      setTotalPages(response.pagination.totalPages);
      setPage(response.pagination.page);
      setIsLinksLoading(false);

      const missing = response.data.filter((link) => !analyticsCache.current.has(link.id));
      const results = await Promise.allSettled(
        missing.map((link) => getLinkAnalytics(link.id, 30, signal)),
      );
      if (signal?.aborted) return;
      let hadError = false;
      results.forEach((result, index) => {
        const link = missing[index];
        if (!link) return;
        if (result.status === 'fulfilled') analyticsCache.current.set(link.id, result.value);
        else hadError = true;
      });
      setLinkAnalytics(
        Object.fromEntries(
          response.data.map((link) => [link.id, analyticsCache.current.get(link.id) ?? null]),
        ),
      );
      if (hadError)
        setLinkAnalyticsError('Some link click totals could not be loaded. Try refreshing.');
    } catch (error) {
      if (signal?.aborted) return;
      setLinksError(error instanceof Error ? error.message : 'Could not load saved links.');
    } finally {
      if (!signal?.aborted) setIsLinksLoading(false);
    }
  }, []);

  const loadOverview = useCallback(async (signal?: AbortSignal) => {
    setIsAnalyticsLoading(true);
    setAnalyticsError(null);
    try {
      const [totalResponse, seriesResponse, topResponse] = await Promise.all([
        getAnalyticsTotal(signal),
        getClickSeries(30, signal),
        getTopLinks(5, 30, signal),
      ]);
      if (signal?.aborted) return;
      setAnalyticsTotal(totalResponse.totalClicks);
      setClickSeries(seriesResponse);
      setTopLinks(topResponse);
    } catch (error) {
      if (signal?.aborted) return;
      setAnalyticsError(error instanceof Error ? error.message : 'Could not load analytics.');
      setAnalyticsTotal(null);
      setClickSeries(null);
      setTopLinks(null);
    } finally {
      if (!signal?.aborted) setIsAnalyticsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      void loadLinks(1, controller.signal);
      void loadOverview(controller.signal);
    });
    return () => controller.abort();
  }, [loadLinks, loadOverview]);

  const filteredLinks = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return links;
    return links.filter(
      (link) =>
        link.shortCode.toLowerCase().includes(query) ||
        link.destinationUrl.toLowerCase().includes(query),
    );
  }, [links, search]);

  const clicksLast30Days =
    clickSeries?.points.reduce((sum, point) => sum + point.clicks, 0) ?? null;

  async function refreshAll(targetPage = page) {
    setActionError(null);
    await Promise.all([loadLinks(targetPage, undefined, true), loadOverview()]);
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const destinationUrl = String(formData.get('destinationUrl') ?? '').trim();
    const alias = String(formData.get('alias') ?? '').trim();
    const expiration = String(formData.get('expiresAt') ?? '').trim();
    setIsSubmitting(true);
    setFormError(null);
    setActionMessage(null);
    try {
      const created = await createLink({
        destinationUrl,
        ...(alias ? { alias } : {}),
        ...(expiration ? { expiresAt: new Date(expiration).toISOString() } : {}),
      });
      setCreatedLink(created);
      form.reset();
      setSearch('');
      setActionMessage('Short link created and saved.');
      await refreshAll(1);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not create this short link.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function copyUrl(link: Pick<Link, 'id' | 'shortUrl'>) {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(link.shortUrl);
      setCopiedLinkId(link.id);
      window.setTimeout(() => setCopiedLinkId(null), 1800);
    } catch {
      setCopyError('Clipboard access is unavailable. You can select the short URL to copy it.');
    }
  }

  async function handleEdit(event: FormEvent<HTMLFormElement>, link: Link) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const destinationUrl = String(data.get('destinationUrl') ?? '').trim();
    const expiration = String(data.get('expiresAt') ?? '').trim();
    setBusyLinkId(link.id);
    setEditError(null);
    setActionMessage(null);
    try {
      await updateLink(link.id, {
        destinationUrl,
        expiresAt: expiration ? new Date(expiration).toISOString() : null,
      });
      setEditingId(null);
      setActionMessage('Link details updated.');
      await refreshAll(page);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : 'Could not update this link.');
    } finally {
      setBusyLinkId(null);
    }
  }

  async function toggleActive(link: Link) {
    setBusyLinkId(link.id);
    setActionError(null);
    setActionMessage(null);
    try {
      await setLinkActive(link.id, !link.isActive);
      setActionMessage(link.isActive ? 'Link deactivated.' : 'Link reactivated.');
      await refreshAll(page);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not change link status.');
    } finally {
      setBusyLinkId(null);
    }
  }

  async function confirmDelete(link: Link) {
    setBusyLinkId(link.id);
    setActionError(null);
    setActionMessage(null);
    try {
      await deleteLink(link.id);
      const nextPage = links.length === 1 && page > 1 ? page - 1 : page;
      setConfirmDeleteId(null);
      setExpandedAnalyticsId(null);
      setActionMessage('Link and its click history deleted.');
      await refreshAll(nextPage);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not delete this link.');
    } finally {
      setBusyLinkId(null);
    }
  }

  const retryPage = () => void loadLinks(page, undefined, true);

  async function handleLogout() {
    setLogoutError(null);
    try {
      await logout();
      onLogout();
    } catch (cause) {
      setLogoutError(cause instanceof Error ? cause.message : 'Could not sign out. Try again.');
    }
  }

  return (
    <div className="app-shell dashboard-shell">
      <header className="topbar dashboard-topbar">
        <a className="brand" href="#top" aria-label="LinkPulse dashboard">
          <span className="brand-mark" aria-hidden="true">
            lp
          </span>
          <span>LinkPulse</span>
        </a>
        <div className="topbar-note">
          <span>URLS</span>
          <span className="topbar-divider" aria-hidden="true">
            /
          </span>
          ANALYTICS
        </div>
        <div className="account-actions">
          <span className="account-email">{user.email}</span>
          <button
            className="text-button signout-button"
            type="button"
            onClick={() => void handleLogout()}
          >
            Sign out
          </button>
        </div>
      </header>

      <main id="top" className="page-content dashboard-content">
        {logoutError && (
          <p className="notice error-notice" role="alert">
            {logoutError}
          </p>
        )}
        <section className="dashboard-heading" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">LINKPULSE / WORKSPACE</p>
            <h1 id="page-title">
              A clear view <span>of your links.</span>
            </h1>
            <p className="intro-copy">
              Manage destinations and follow the clicks your links receive.
            </p>
          </div>
          <button
            className="secondary-button refresh-button"
            type="button"
            onClick={() => void refreshAll()}
            disabled={isLinksLoading || isAnalyticsLoading}
          >
            {isLinksLoading || isAnalyticsLoading ? 'Refreshing…' : 'Refresh data'}
          </button>
        </section>

        {actionMessage && (
          <p className="notice success-notice" role="status">
            {actionMessage}
          </p>
        )}
        {actionError && (
          <p className="notice error-notice" role="alert">
            {actionError}
          </p>
        )}

        <DashboardAnalytics
          totalLinks={totalLinks}
          isLinksLoading={isLinksLoading}
          analyticsTotal={analyticsTotal}
          clicksLast30Days={clicksLast30Days}
          clickSeries={clickSeries}
          topLinks={topLinks}
          isAnalyticsLoading={isAnalyticsLoading}
          analyticsError={analyticsError}
          onRetry={() => void loadOverview()}
        />
        <LinkCreateForm
          isSubmitting={isSubmitting}
          formError={formError}
          createdLink={createdLink}
          copiedLinkId={copiedLinkId}
          onSubmit={handleCreate}
          onCopy={copyUrl}
        />
        <SavedLinksSection
          links={links}
          filteredLinks={filteredLinks}
          linkAnalytics={linkAnalytics}
          totalLinks={totalLinks}
          totalPages={totalPages}
          page={page}
          search={search}
          isLinksLoading={isLinksLoading}
          linksError={linksError}
          linkAnalyticsError={linkAnalyticsError}
          copyError={copyError}
          copiedLinkId={copiedLinkId}
          editingId={editingId}
          editError={editError}
          confirmDeleteId={confirmDeleteId}
          busyLinkId={busyLinkId}
          expandedAnalyticsId={expandedAnalyticsId}
          onSearchChange={setSearch}
          onRetry={retryPage}
          onPageChange={(targetPage) => void loadLinks(targetPage)}
          onCopy={copyUrl}
          onEditToggle={(id) => {
            setEditingId(editingId === id ? null : id);
            setEditError(null);
          }}
          onEditSubmit={handleEdit}
          onEditCancel={() => setEditingId(null)}
          onToggleActive={(link) => void toggleActive(link)}
          onDeleteRequest={setConfirmDeleteId}
          onDeleteConfirm={(link) => void confirmDelete(link)}
          onDeleteCancel={() => setConfirmDeleteId(null)}
          onAnalyticsToggle={(id) => setExpandedAnalyticsId(expandedAnalyticsId === id ? null : id)}
        />
        <footer className="page-footer">
          <span>LinkPulse — A smarter way to manage links.</span>
          <span>Designed &amp; built by Rishikesh Sinha.</span>
          <span>© 2026 LinkPulse.</span>
        </footer>
      </main>
    </div>
  );
}
