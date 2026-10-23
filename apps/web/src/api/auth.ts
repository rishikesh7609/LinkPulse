import { request } from './links';

export type AuthUser = { id: string; email: string };

export async function getCurrentUser(signal?: AbortSignal): Promise<AuthUser> {
  const response = await request<{ data: AuthUser }>('/api/auth/me', { signal });
  return response.data;
}

async function submitCredentials(
  path: '/api/auth/login' | '/api/auth/register',
  email: string,
  password: string,
) {
  const response = await request<{ data: AuthUser; csrfToken: string }>(path, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return response.data;
}

export function login(email: string, password: string): Promise<AuthUser> {
  return submitCredentials('/api/auth/login', email, password);
}

export function register(email: string, password: string): Promise<AuthUser> {
  return submitCredentials('/api/auth/register', email, password);
}

export async function logout(): Promise<void> {
  await request<void>('/api/auth/logout', { method: 'POST' });
}
