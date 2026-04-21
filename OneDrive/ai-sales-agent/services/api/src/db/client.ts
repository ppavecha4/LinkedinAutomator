/**
 * Postgres pool for the API service.
 *
 * Lazy: the pool is created on first query so the API boots even without a
 * DATABASE_URL (dev smoke tests, unit tests). If you actually call the DB
 * without DATABASE_URL set, you'll get a clear error.
 */

import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';

import { env } from '../env';
import { logger } from '../logger';

let pool: Pool | null = null;

function buildConfig(): PoolConfig {
  if (!env.databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set — refusing to connect. Set it in .env or wire a fake repo in tests.',
    );
  }
  return {
    connectionString: env.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
}

export function getPool(): Pool {
  if (!pool) {
    const config = buildConfig();
    pool = new Pool(config);
    pool.on('error', (err) => {
      logger.error('pg pool error', { error: err.message });
    });
  }
  return pool;
}

export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<QueryResult<R>> {
  const started = Date.now();
  const result = await getPool().query<R>(text, params as unknown[]);
  const duration = Date.now() - started;
  if (duration > 200) {
    logger.warn('slow query', { duration_ms: duration, sql: text.slice(0, 120) });
  }
  return result;
}

export async function withTransaction<T>(
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
