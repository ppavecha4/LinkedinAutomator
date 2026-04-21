/**
 * Consistent response shape for the whole API: `{data, pagination?, error?}`.
 *
 * Every route returns one of these three shapes. Routes never write `res.json`
 * directly with arbitrary shapes — they call `ok()`, `okPaginated()`, or
 * throw an `ApiError`.
 */

import type { Response } from 'express';

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export interface ApiResponseBody<T> {
  data: T;
  pagination?: Pagination;
  error?: { code: string; message: string; details?: unknown };
}

export function ok<T>(res: Response, data: T, status = 200): Response {
  const body: ApiResponseBody<T> = { data };
  return res.status(status).json(body);
}

export function okPaginated<T>(
  res: Response,
  data: T,
  pagination: Pagination,
  status = 200,
): Response {
  const body: ApiResponseBody<T> = { data, pagination };
  return res.status(status).json(body);
}

export function buildPagination(
  page: number,
  limit: number,
  total: number,
): Pagination {
  return {
    page,
    limit,
    total,
    total_pages: limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1,
  };
}

export function parsePageLimit(query: Record<string, unknown>): {
  page: number;
  limit: number;
  offset: number;
} {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 20));
  return { page, limit, offset: (page - 1) * limit };
}
