/**
 * The platform's OWN transactional email: invitations, password reset,
 * email verification. Not the customers' outreach — that goes out from
 * their own accounts (orchestrator senders).
 *
 * Optional. Configure PLATFORM_SMTP_HOST / _PORT / _USER / _PASS and
 * PLATFORM_MAIL_FROM. Without it nothing is emailed: invites and reset
 * links are shown to the owner/admin to pass on, and "forgot password"
 * tells people to ask their admin (the dashboard reads
 * GET /api/auth/config → email_enabled).
 */

import nodemailer from 'nodemailer';

import { env } from '../env';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

type Hook = (mail: Mail) => Promise<void>;
let hook: Hook | undefined;

/** Tests capture mail here instead of sending it. */
export function setMailerHook(h: Hook | undefined): void {
  hook = h;
}

export function mailerConfigured(): boolean {
  return !!hook || !!(env.platformSmtpHost && env.platformMailFrom);
}

export async function sendMail(mail: Mail): Promise<void> {
  if (hook) return hook(mail);
  if (!mailerConfigured()) throw new Error('platform email is not configured');
  const transport = nodemailer.createTransport({
    host: env.platformSmtpHost,
    port: env.platformSmtpPort,
    secure: env.platformSmtpPort === 465,
    requireTLS: !env.platformSmtpPlain && env.platformSmtpPort !== 465 && env.platformSmtpPort !== 25,
    ignoreTLS: env.platformSmtpPlain,
    auth: env.platformSmtpUser ? { user: env.platformSmtpUser, pass: env.platformSmtpPass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.sendMail({ from: env.platformMailFrom, to: mail.to, subject: mail.subject, text: mail.text });
  } finally {
    transport.close();
  }
}

/** A link into the dashboard (where invite / reset / verify pages live). */
export function dashboardLink(path: string, token: string): string {
  return `${env.dashboardUrl.replace(/\/+$/, '')}${path}?token=${encodeURIComponent(token)}`;
}
