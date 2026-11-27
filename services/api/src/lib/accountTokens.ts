/**
 * One-time account tokens and the emails that carry them (slice 3.6).
 * Shared by sign-up, the recovery routes and the team routes.
 */

import { query } from '../db/client';
import { emailWords, type EmailLanguage } from './accountEmails';
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

export async function emailVerificationLink(userId: string, email: string, name: string | null, language: EmailLanguage = 'en'): Promise<void> {
  if (!mailerConfigured()) return;
  const link = dashboardLink('/verify-email', await issueToken(userId, 'verify'));
  const words = emailWords(language);
  await sendMail({ to: email, subject: words.verify.subject, text: `${words.hi(name)}\n\n${words.verify.body(link)}` });
}
