/**
 * Slice 3.9 — rate-limit counts shared through Redis. Needs a real Redis
 * (REDIS_TEST_URL); skipped without one. Two limiter instances in one test
 * stand in for two API instances.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../../src/env';
import { closeRedis, getRedis } from '../../src/lib/redis';
import { authRateLimit, RedisStore, setRateLimitStore } from '../../src/middleware/authRateLimit';

const URL = process.env.REDIS_TEST_URL;
const describeIfRedis = URL ? describe : describe.skip;
const RUN = Math.random().toString(36).slice(2, 8);

/** Run one request through a limiter; resolves to the HTTP status it would give (200 = let through). */
function through(lim: ReturnType<typeof authRateLimit>): Promise<number> {
  return new Promise((resolve) => lim({} as never, {} as never, (e?: unknown) => resolve(e ? (e as { status: number }).status : 200)));
}

describeIfRedis('rate limits in Redis', () => {
  const original = { ...env };

  beforeAll(() => {
    env.redisUrl = URL!;
    setRateLimitStore(new RedisStore());
  });

  afterAll(async () => {
    setRateLimitStore(undefined);
    Object.assign(env, original);
    await closeRedis();
  });

  it('two API instances share one count', async () => {
    const a = authRateLimit({ name: `shared-${RUN}`, windowMs: 60_000, max: 3, key: () => 'ip:1.2.3.4' });
    const b = authRateLimit({ name: `shared-${RUN}`, windowMs: 60_000, max: 3, key: () => 'ip:1.2.3.4' });
    expect([await through(a), await through(b), await through(a), await through(b)]).toEqual([200, 200, 200, 429]);
  });

  it('different limiters and different keys count separately', async () => {
    const one = authRateLimit({ name: `one-${RUN}`, windowMs: 60_000, max: 1, key: () => 'ip:9.9.9.9' });
    const two = authRateLimit({ name: `two-${RUN}`, windowMs: 60_000, max: 1, key: () => 'ip:9.9.9.9' });
    const other = authRateLimit({ name: `one-${RUN}`, windowMs: 60_000, max: 1, key: () => 'ip:8.8.8.8' });
    expect([await through(one), await through(two), await through(other)]).toEqual([200, 200, 200]);
    expect(await through(one)).toBe(429);
  });

  it('a window ends: after it the same caller is let through again', async () => {
    const lim = authRateLimit({ name: `short-${RUN}`, windowMs: 400, max: 2, key: () => 'ip:5.5.5.5' });
    expect([await through(lim), await through(lim), await through(lim)]).toEqual([200, 200, 429]);
    await new Promise((r) => setTimeout(r, 550));
    expect(await through(lim)).toBe(200);
  });

  it('every counter carries an expiry, so a crash can never leave someone locked out for good', async () => {
    const lim = authRateLimit({ name: `ttl-${RUN}`, windowMs: 60_000, max: 5, key: () => 'ip:7.7.7.7' });
    await through(lim);
    const ttl = await getRedis().pttl(`rl:ttl-${RUN}|ip:7.7.7.7`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
    // Even a key left behind without a TTL is repaired by the next hit.
    await getRedis().set(`rl:ttl-${RUN}|ip:6.6.6.6`, '2');
    const lim2 = authRateLimit({ name: `ttl-${RUN}`, windowMs: 60_000, max: 5, key: () => 'ip:6.6.6.6' });
    expect(await through(lim2)).toBe(200);
    expect(await getRedis().pttl(`rl:ttl-${RUN}|ip:6.6.6.6`)).toBeGreaterThan(0);
  });

  it('if the store is down, sign-in is not broken: this instance counts on its own', async () => {
    setRateLimitStore({ hit: async () => { throw new Error('redis is down'); } });
    const lim = authRateLimit({ name: `down-${RUN}`, windowMs: 60_000, max: 2, key: () => 'ip:4.4.4.4' });
    expect([await through(lim), await through(lim), await through(lim)]).toEqual([200, 200, 429]);
    setRateLimitStore(new RedisStore());
  });
});
