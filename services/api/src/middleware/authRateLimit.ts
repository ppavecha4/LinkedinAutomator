/**
 * Brute-force protection for the public auth endpoints (sign in, sign up,
 * password reset, invitations).
 *
 * Fixed windows keyed on the client IP AND, where the request names one,
 * the email: X-Forwarded-For can be spoofed to rotate IPs, an email cannot
 * be rotated without changing the target.
 *
 * Counts live in Redis when REDIS_URL is set, so every API instance shares
 * them (with only in-process counts, N instances would allow N times the
 * attempts). If Redis is unavailable the limiter falls back to this
 * process's own counts rather than failing sign-in or locking everyone out.
 */

import type { NextFunction, Request, Response } from 'express';

import { env } from '../env';
import { ApiError } from '../lib/errors';
import { getRedis } from '../lib/redis';
import { logger } from '../logger';

export interface Hit {
  count: number;
  /** When this window ends (epoch ms). */
  resetAt: number;
}

export interface RateStore {
  hit(key: string, windowMs: number): Promise<Hit>;
}

export class MemoryStore implements RateStore {
  private buckets = new Map<string, Hit>();

  async hit(key: string, windowMs: number): Promise<Hit> {
    const now = Date.now();
    // Opportunistic cleanup so the map cannot grow without bound.
    if (this.buckets.size > 10_000) {
      for (const [bk, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(bk);
    }
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, fresh);
      return { ...fresh };
    }
    b.count += 1;
    return { ...b };
  }
}

// Atomic: the key always gets a TTL, even if the process dies between commands.
const HIT_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
local t = redis.call('PTTL', KEYS[1])
if c == 1 or t < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  t = tonumber(ARGV[1])
end
return {c, t}
`;

export class RedisStore implements RateStore {
  async hit(key: string, windowMs: number): Promise<Hit> {
    const r = getRedis();
    if (r.status === 'wait' || r.status === 'end') await r.connect();
    const [count, ttl] = (await r.eval(HIT_SCRIPT, 1, `rl:${key}`, String(windowMs))) as [number, number];
    return { count: Number(count), resetAt: Date.now() + Number(ttl) };
  }
}

const memory = new MemoryStore();
const redis = new RedisStore();
let override: RateStore | undefined;
let lastWarn = 0;

/** Tests swap the store. */
export function setRateLimitStore(s: RateStore | undefined): void {
  override = s;
}

async function hit(key: string, windowMs: number): Promise<Hit> {
  const primary = override ?? (env.redisUrl ? redis : memory);
  try {
    return await primary.hit(key, windowMs);
  } catch (e) {
    if (Date.now() - lastWarn > 60_000) {
      lastWarn = Date.now();
      logger.warn('rate limit store unavailable; using this instance\'s own counts', { error: (e as Error).message });
    }
    return memory.hit(key, windowMs);
  }
}

export function authRateLimit(opts: {
  name: string;
  windowMs: number;
  max: number;
  key: (req: Request) => string | null;
}) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const k = opts.key(req);
    if (!k) return next();
    hit(`${opts.name}|${k}`, opts.windowMs).then(
      (h) => {
        if (h.count > opts.max) {
          const seconds = Math.max(1, Math.ceil((h.resetAt - Date.now()) / 1000));
          return next(new ApiError(429, 'RATE_LIMITED', `too many attempts; try again in ${seconds}s`));
        }
        next();
      },
      next,
    );
  };
}

const ip = (req: Request) => `ip:${req.ip ?? 'unknown'}`;
const email = (req: Request) => {
  const e = (req.body as { email?: unknown } | undefined)?.email;
  return typeof e === 'string' && e ? `email:${e.trim().toLowerCase()}` : null;
};

/** 20 sign-in attempts per IP and 10 per email, per 15 minutes. */
export const loginLimitByIp = authRateLimit({ name: 'login-ip', windowMs: 15 * 60_000, max: 20, key: ip });
export const loginLimitByEmail = authRateLimit({ name: 'login-email', windowMs: 15 * 60_000, max: 10, key: email });
/** Password-reset requests: 10 per IP and 3 per address per hour. */
export const forgotLimitByIp = authRateLimit({ name: 'forgot-ip', windowMs: 60 * 60_000, max: 10, key: ip });
export const forgotLimitByEmail = authRateLimit({ name: 'forgot-email', windowMs: 60 * 60_000, max: 3, key: email });
/** Using reset / verify / invite links: guesses are pointless (256-bit tokens) but cheap to cap. */
export const linkLimitByIp = authRateLimit({ name: 'link-ip', windowMs: 15 * 60_000, max: 30, key: ip });
/** 5 sign-ups per IP per hour. */
export const signupLimitByIp = authRateLimit({ name: 'signup-ip', windowMs: 60 * 60_000, max: 5, key: ip });
