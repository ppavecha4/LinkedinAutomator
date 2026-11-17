/**
 * One-time account tokens and the emails that carry them (slice 3.6).
 * Shared by sign-up, the recovery routes and the team routes.
 */

import { query } from '../db/client';
import { ApiError } from './errors';
import { dashboardLink, mailerConfigured, sendMail } from './mailer';
import { newToken } from './tokens';

export const RESET_TTL_MINUTES = 60;
export const VERIFY_TTL_MINUTES = 3 * 24 * 60;

/** Store a fresh one-time token for a user and return it (never logged). */
export async function issueToken(userId: string, purpose: 'reset' | 'verify'): Promise<string> {
  const { token, hash } = newToken();
  const ttl = purpose === 'reset' ? RESET_TTL_MINUTES : VERIFY_TTL_MINUTES;
  const r = await query<{ issued: boolean }>(`SELECT issue_user_token($1, $2, $3, $4) AS issued`, [userId, purpose, hash, ttl]);
  if (!r.rows[0]?.issued) throw ApiError.notFound('user not found');
  return token;
}

export async function emailVerificationLink(userId: string, email: string, name: string | null): Promise<void> {
  if (!mailerConfigured()) return;
  const link = dashboardLink('/verify-email', await issueToken(userId, 'verify'));
  await sendMail({
    to: email,
    subject: 'Verify your email address',
    text: `Hi ${name ?? 'there'},\n\nConfirm your email address to start launching campaigns:\n\n${link}\n\nThis link works once, for 3 days. If you didn't create an account, ignore this email.\n`,
  });
}
