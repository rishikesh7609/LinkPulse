import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const link = {
  id: 'f2a2c09a-8bde-460c-9441-40a7c49efcf5',
  shortCode: 'launch',
  shortUrl: 'http://localhost:3001/launch',
  destinationUrl: 'https://example.com/launch',
  createdAt: '2026-01-15T10:00:00.000Z',
  expiresAt: null as string | null,
  isActive: true,
};

const points = [
  { date: '2026-05-01', clicks: 2 },
  { date: '2026-05-03', clicks: 5 },
];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function page(data: (typeof link)[], total = data.length, pageNumber = 1, limit = 10) {
  return {
    data,
    pagination: {
      page: pageNumber,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

function analyticsResponse(path: string, saved: (typeof link)[], totalClicks = 42) {
  if (path === '/api/analytics/total') {
    return jsonResponse({ data: { totalClicks } });
  }
  if (path === '/api/analytics/timeseries') {
    return jsonResponse({ data: { days: 30, points } });
  }
  if (path === '/api/analytics/top') {
    return jsonResponse({
      data: saved.slice(0, 5).map((item, index) => ({
        ...item,
        linkId: item.id,
        totalClicks: 18 - index,
      })),
    });
  }
  const id = path.split('/').at(-1);
  const item = saved.find((savedLink) => savedLink.id === id) ?? link;
  return jsonResponse({
    data: { linkId: item.id, shortCode: item.shortCode, totalClicks: 18, clicksOverTime: points },
  });
}

describe('LinkPulse analytics dashboard', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let mockUser: { id: string; email: string } | null;
  let authRequests: { path: string; init?: RequestInit }[];

  beforeEach(() => {
    fetchMock = vi.fn();
    mockUser = { id: 'test-account', email: 'owner@example.test' };
    authRequests = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.startsWith('/api/auth/')) {
        authRequests.push({ path: url.pathname, init });
        if (url.pathname === '/api/auth/csrf')
          return jsonResponse({ csrfToken: 'test-csrf-token' });
        if (url.pathname === '/api/auth/me') {
          return mockUser
            ? jsonResponse({ data: mockUser })
            : jsonResponse(
                { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in.' } },
                401,
              );
        }
        if (url.pathname === '/api/auth/login' || url.pathname === '/api/auth/register') {
          mockUser = { id: 'test-account', email: 'owner@example.test' };
          return jsonResponse({ data: mockUser, csrfToken: 'rotated-csrf-token' }, 200);
        }
        return jsonResponse(null, 204);
      }
      return (fetchMock as unknown as typeof fetch)(input, init);
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('loads overview metrics, click trend, top links, and per-link totals from API responses', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/links') return jsonResponse(page([link]));
      return analyticsResponse(url.pathname, [link]);
    });

    render(<App />);

    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.getByText('1', { selector: '.metric-card strong' })).toBeInTheDocument();
    expect(screen.getByText('7', { selector: '.metric-card-accent strong' })).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /daily clicks over the last 30 days/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('/launch')).toBeInTheDocument();
    expect(screen.getByText('18', { selector: '.top-links-list strong' })).toBeInTheDocument();
    expect(screen.getByText('18', { selector: '.link-clicks strong' })).toBeInTheDocument();
    expect(screen.getByText('LinkPulse — A smarter way to manage links.')).toBeInTheDocument();
    expect(screen.getByText('Designed & built by Rishikesh Sinha.')).toBeInTheDocument();
    expect(screen.getByText('© 2026 LinkPulse.')).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith('/api/analytics/total', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith('/api/analytics/timeseries?days=30', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/analytics/top?limit=5&days=30',
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/analytics/links/${link.id}?days=30`,
      expect.any(Object),
    );
  });

  it('shows honest empty states when the API has no links or clicks', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/links') return jsonResponse(page([]));
      if (url.pathname === '/api/analytics/total')
        return jsonResponse({ data: { totalClicks: 0 } });
      if (url.pathname === '/api/analytics/timeseries') {
        return jsonResponse({ data: { days: 30, points: [] } });
      }
      return jsonResponse({ data: [] });
    });

    render(<App />);

    expect(await screen.findByText(/no links yet/i)).toBeInTheDocument();
    expect(await screen.findByText(/no recorded clicks yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/share a short link to get started.*last 30 days/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText('0', { selector: '.metric-card strong' })).toHaveLength(3);
  });

  it('creates a link with an alias and expiration, then copies its short URL', async () => {
    let saved: (typeof link)[] = [];
    const created = {
      ...link,
      shortCode: 'launch-day',
      shortUrl: 'http://localhost:3001/launch-day',
      expiresAt: '2030-10-01T06:30:00.000Z',
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/links' && init?.method === 'POST') {
        saved = [created];
        return jsonResponse({ data: created }, 201);
      }
      if (url.pathname === '/api/links') return jsonResponse(page(saved));
      return analyticsResponse(url.pathname, saved, saved.length ? 42 : 0);
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(/no links yet/i);
    await user.type(screen.getByLabelText(/destination url/i), 'https://example.com/launch');
    await user.type(screen.getByLabelText(/custom alias/i), 'launch-day');
    await user.type(screen.getByLabelText(/^expires/i), '2030-10-01T12:00');
    await user.click(screen.getByRole('button', { name: /create short link/i }));

    expect(await screen.findByText('YOUR SHORT LINK IS READY')).toBeInTheDocument();
    expect(await screen.findAllByRole('link', { name: created.shortUrl })).toHaveLength(2);
    const createCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input).startsWith('/api/links') && init?.method === 'POST',
    );
    expect(JSON.parse(createCall?.[1]?.body as string)).toEqual({
      destinationUrl: 'https://example.com/launch',
      alias: 'launch-day',
      expiresAt: new Date('2030-10-01T12:00').toISOString(),
    });
    await user.click(screen.getByRole('button', { name: /copy link/i }));
    const resultPanel = screen.getByText('YOUR SHORT LINK IS READY').closest('.created-result');
    expect(resultPanel).not.toBeNull();
    expect(
      await within(resultPanel as HTMLElement).findByRole('button', { name: 'Copied' }),
    ).toBeInTheDocument();
  });

  it('edits, deactivates, reactivates, and deletes a saved link', async () => {
    let saved: (typeof link)[] = [{ ...link }];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/links' && method === 'GET') return jsonResponse(page(saved));
      if (url.pathname === `/api/links/${link.id}` && method === 'PATCH') {
        saved = [{ ...saved[0]!, destinationUrl: JSON.parse(init?.body as string).destinationUrl }];
        return jsonResponse({ data: saved[0] });
      }
      if (url.pathname === `/api/links/${link.id}/status`) {
        saved = [{ ...saved[0]!, isActive: JSON.parse(init?.body as string).isActive }];
        return jsonResponse({ data: saved[0] });
      }
      if (url.pathname === `/api/links/${link.id}` && method === 'DELETE') {
        saved = [];
        return jsonResponse(null, 204);
      }
      return analyticsResponse(url.pathname, saved);
    });

    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('link', { name: link.shortUrl });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const destination = screen.getByLabelText('Destination URL', {
      selector: `#edit-destination-${link.id}`,
    });
    await user.clear(destination);
    await user.type(destination, 'https://example.com/edited');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('https://example.com/edited', { selector: '.destination' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reactivate' }));
    expect(await screen.findByRole('button', { name: 'Deactivate' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));
    expect(await screen.findByText(/no links yet/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/deleted/i);
  });

  it('paginates server results and searches within the current page', async () => {
    const second = {
      ...link,
      id: 'second-link',
      shortCode: 'other',
      shortUrl: 'http://localhost:3001/other',
      destinationUrl: 'https://example.com/other',
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/links') {
        const pageNumber = Number(url.searchParams.get('page'));
        return jsonResponse(page(pageNumber === 1 ? [link, second] : [second], 12, pageNumber, 10));
      }
      return analyticsResponse(url.pathname, [link, second]);
    });

    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('link', { name: link.shortUrl });
    await user.type(
      screen.getByRole('searchbox', { name: /search links on this page/i }),
      'launch',
    );
    expect(screen.getByRole('link', { name: link.shortUrl })).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Saved links' })).queryByRole('link', {
        name: second.shortUrl,
      }),
    ).not.toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox'));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Page 2 of 2')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/links?page=2&limit=10', expect.any(Object));
  });

  it('shows API failures instead of substituting sample dashboard data', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/links') return jsonResponse(page([link]));
      if (url.pathname === '/api/analytics/top') {
        return jsonResponse(
          { error: { code: 'DB_UNAVAILABLE', message: 'Analytics are unavailable.' } },
          500,
        );
      }
      return analyticsResponse(url.pathname, [link]);
    });

    render(<App />);
    expect(await screen.findAllByText('Analytics are unavailable.')).toHaveLength(2);
    expect(screen.getAllByText('—', { selector: '.metric-card strong' })).toHaveLength(2);
  });

  it('shows a network error and allows the link list to be retried', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/links') return jsonResponse(page([link]));
      return analyticsResponse(url.pathname, [link]);
    });

    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText(/could not reach linkpulse/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: link.shortUrl })).toBeInTheDocument();
  });

  it('shows the sign-in gate and returns to the live dashboard after authentication', async () => {
    mockUser = null;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/links') return jsonResponse(page([]));
      if (url.pathname === '/api/analytics/total')
        return jsonResponse({ data: { totalClicks: 0 } });
      if (url.pathname === '/api/analytics/timeseries')
        return jsonResponse({ data: { days: 30, points: [] } });
      return jsonResponse({ data: [] });
    });

    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Welcome back.' })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/email address/i), 'owner@example.test');
    await user.type(screen.getByLabelText(/password/i), 'a-long-test-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: /a clear view/i })).toBeInTheDocument();
    expect(
      authRequests.some(
        ({ path, init }) =>
          path === '/api/auth/login' &&
          new Headers(init?.headers).get('X-CSRF-Token') === 'test-csrf-token',
      ),
    ).toBe(true);
  });
});
