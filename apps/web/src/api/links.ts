export type Link = {
  id: string;
  shortCode: string;
  shortUrl: string;
  destinationUrl: string;
  createdAt: string;
  expiresAt: string | null;
  isActive: boolean;
};

export type LinkPage = {
  data: Link[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

export type CreateLinkInput = {
  destinationUrl: string;
  alias?: string;
  expiresAt?: string;
};

export type UpdateLinkInput = { destinationUrl?: string; expiresAt?: string | null };
export type ClickPoint = { date: string; clicks: number };
export type AnalyticsTotal = { totalClicks: number };
export type ClickSeries = { days: number; points: ClickPoint[] };
export type TopLink = Link & { linkId: string; totalClicks: number };
export type LinkAnalytics = {
  linkId: string;
  shortCode: string;
  totalClicks: number;
  clicksOverTime: ClickPoint[];
};

type ApiErrorBody = { error?: { code?: string; message?: string } };

export class LinkApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LinkApiError';
  }
}

let csrfToken: string | undefined;
let csrfRequest: Promise<string> | undefined;

async function getCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  csrfRequest ??= (async () => {
    const response = await fetch('/api/auth/csrf', { credentials: 'same-origin' }).catch(
      () => null,
    );
    const body = (await response?.json().catch(() => null)) as { csrfToken?: string } | null;
    if (!response?.ok || !body?.csrfToken) {
      throw new LinkApiError(
        'Could not start a secure session. Refresh and try again.',
        'CSRF_UNAVAILABLE',
      );
    }
    csrfToken = body.csrfToken;
    return csrfToken;
  })().finally(() => {
    csrfRequest = undefined;
  });
  return csrfRequest;
}

export function clearCsrfToken(): void {
  csrfToken = undefined;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...Object.fromEntries(new Headers(init?.headers).entries()),
  };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    headers['X-CSRF-Token'] = await getCsrfToken();
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers,
    });
  } catch {
    throw new LinkApiError(
      'Could not reach LinkPulse. Check that the API is running.',
      'NETWORK_ERROR',
    );
  }

  const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
  if (!response.ok) {
    const code = body?.error?.code ?? 'REQUEST_FAILED';
    if (code === 'AUTHENTICATION_REQUIRED' && typeof window !== 'undefined') {
      clearCsrfToken();
      window.dispatchEvent(new Event('linkpulse:auth-expired'));
    }
    throw new LinkApiError(body?.error?.message ?? 'The request could not be completed.', code);
  }
  if (
    body &&
    typeof body === 'object' &&
    'csrfToken' in body &&
    typeof body.csrfToken === 'string'
  ) {
    csrfToken = body.csrfToken;
  }
  if (path === '/api/auth/logout') clearCsrfToken();
  return body as T;
}

export function getLinks(page = 1, limit = 10, signal?: AbortSignal): Promise<LinkPage> {
  const query = new URLSearchParams({ page: String(page), limit: String(limit) });
  return request<LinkPage>(`/api/links?${query}`, { signal });
}

export async function createLink(input: CreateLinkInput): Promise<Link> {
  const response = await request<{ data: Link }>('/api/links', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.data;
}

export async function updateLink(id: string, input: UpdateLinkInput): Promise<Link> {
  const response = await request<{ data: Link }>(`/api/links/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return response.data;
}

export async function setLinkActive(id: string, isActive: boolean): Promise<Link> {
  const response = await request<{ data: Link }>(`/api/links/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  });
  return response.data;
}

export function deleteLink(id: string): Promise<void> {
  return request<void>(`/api/links/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function getAnalyticsTotal(signal?: AbortSignal): Promise<AnalyticsTotal> {
  const response = await request<{ data: AnalyticsTotal }>('/api/analytics/total', { signal });
  return response.data;
}

export async function getClickSeries(days = 30, signal?: AbortSignal): Promise<ClickSeries> {
  const response = await request<{ data: ClickSeries }>(`/api/analytics/timeseries?days=${days}`, {
    signal,
  });
  return response.data;
}

export async function getTopLinks(limit = 5, days = 30, signal?: AbortSignal): Promise<TopLink[]> {
  const response = await request<{ data: TopLink[] }>(
    `/api/analytics/top?limit=${limit}&days=${days}`,
    { signal },
  );
  return response.data;
}

export async function getLinkAnalytics(
  id: string,
  days = 30,
  signal?: AbortSignal,
): Promise<LinkAnalytics> {
  const response = await request<{ data: LinkAnalytics }>(
    `/api/analytics/links/${encodeURIComponent(id)}?days=${days}`,
    { signal },
  );
  return response.data;
}
