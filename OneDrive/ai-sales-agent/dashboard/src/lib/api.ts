/**
 * Thin fetch wrapper. Handles:
 *   - base URL from VITE_API_URL (defaults to http://localhost:3000)
 *   - consistent `{data, error}` response unwrapping
 *   - dev auth header (X-Dev-User) so AUTH_MODE=bypass sees a stable user id
 *   - JSON serialisation on POST/PATCH
 */

import { DEV_USER_ID } from './auth';
import type { ApiResponseBody } from './types';

export const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export class ApiClientError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ data: T; raw: ApiResponseBody<T> }> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const headers = new Headers(init.headers ?? {});
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('X-Dev-User', DEV_USER_ID);
  const response = await fetch(url, { ...init, headers });
  let body: ApiResponseBody<T> | null = null;
  try {
    body = (await response.json()) as ApiResponseBody<T>;
  } catch {
    body = {
      data: null as unknown as T,
      error: { code: 'PARSE_ERROR', message: response.statusText },
    };
  }
  if (!response.ok || body?.error) {
    const err =
      body?.error ?? { code: 'HTTP_' + response.status, message: response.statusText };
    throw new ApiClientError(response.status, err.code, err.message, err.details);
  }
  return { data: body.data, raw: body };
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
