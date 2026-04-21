/**
 * Lazy Redis client. Used by the /health endpoint and (later) the
 * suppression cache + rate-limit reader.
 *
 * In local dev with REDIS_URL unset, `getRedis()` throws on first use —
 * the health endpoint catches that and reports `redis: 'disconnected'`.
 */

import Redis, { type Redis as RedisClient } from 'ioredis';

import { env } from '../env';

let client: RedisClient | null = null;

export function getRedis(): RedisClient {
  if (!client) {
    if (!env.redisUrl) {
      throw new Error('REDIS_URL is not set');
    }
    client = new Redis(env.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });
  }
  return client;
}

export async function pingRedis(): Promise<boolean> {
  try {
    const r = getRedis();
    if (r.status === 'wait' || r.status === 'end') {
      await r.connect();
    }
    const reply = await r.ping();
    return reply === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    try {
      await client.quit();
    } catch {
      /* ignore */
    }
    client = null;
  }
}
