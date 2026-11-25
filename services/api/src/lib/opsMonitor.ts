/**
 * Operational monitoring (hardening, slice 6.3).
 *
 * Every OPS_MONITOR_INTERVAL_MINUTES the API runs a handful of checks:
 *
 *   database        answers a query
 *   redis           answers a ping
 *   <heartbeat>     each expected job (cron senders, reply poller, nightly
 *                   backup, weekly restore test) reported within its window
 *   database_size   under OPS_DB_SIZE_ALERT_GB (off when 0)
 *
 * and ALERTS ON CHANGE: one message when a check starts failing, a reminder
 * every OPS_REMINDER_HOURS while it still fails, one when it recovers. Alerts
 * go to a chat webhook (ALERT_WEBHOOK_URL: Slack, Discord, Teams, ntfy ...)
 * and/or by email (ALERT_EMAIL, through the platform mailbox).
 *
 * If everything is healthy it also pings OPS_PING_URL (e.g. a healthchecks.io
 * check). That is the dead-man's switch: when the API, the server or this loop
 * itself dies, nothing pings, and THAT service alerts you. A monitor cannot
 * report its own death.
 *
 * Expected heartbeats: OPS_EXPECTED_HEARTBEATS, "name:max_age_minutes,..."
 * (jobs record theirs through the ops_heartbeat() SQL function, V31).
 */

import { query } from '../db/client';
import { env } from '../env';
import { logger } from '../logger';
import { mailerConfigured, sendMail } from './mailer';
import { pingRedis } from './redis';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Minutes since the job last reported (heartbeat checks). */
  age_minutes?: number;
}

export interface Expectation { name: string; maxAgeMinutes: number }

/** "auto_sends:20,backup:1560" -> [{auto_sends, 20}, {backup, 1560}] (bad entries are ignored). */
export function parseExpected(raw: string): Expectation[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean).flatMap((s) => {
    const [name, mins] = s.split(':');
    const n = Number(mins);
    return name && Number.isFinite(n) && n > 0 ? [{ name: name.trim(), maxAgeMinutes: n }] : [];
  });
}

const startedAt = Date.now();
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_r, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);

export async function runChecks(now = Date.now()): Promise<Check[]> {
  const checks: Check[] = [];

  let dbOk = true;
  try {
    await withTimeout(query('SELECT 1'), 3000);
    checks.push({ name: 'database', ok: true, detail: 'answers queries' });
  } catch (e) {
    dbOk = false;
    checks.push({ name: 'database', ok: false, detail: `not answering (${(e as Error).message})` });
  }

  try {
    const ok = env.redisUrl ? await withTimeout(pingRedis(), 3000) : true;
    checks.push({ name: 'redis', ok, detail: env.redisUrl ? (ok ? 'answers pings' : 'not answering') : 'not configured' });
  } catch {
    checks.push({ name: 'redis', ok: false, detail: 'not answering' });
  }
  if (!dbOk) return checks;     // the rest needs the database

  const beats = new Map<string, Date>();
  try {
    const r = await query<{ name: string; last_ok_at: Date }>(`SELECT * FROM ops_heartbeats_read()`);
    r.rows.forEach((b) => beats.set(b.name, new Date(b.last_ok_at)));
  } catch (e) {
    checks.push({ name: 'heartbeats', ok: false, detail: `could not read heartbeats (${(e as Error).message})` });
    return checks;
  }
  const graceMs = env.opsGraceMinutes * 60_000;
  for (const exp of parseExpected(env.opsExpectedHeartbeats)) {
    const last = beats.get(exp.name);
    if (!last) {
      // Never seen: give the job time to run once after this process starts before complaining.
      const waited = now - startedAt >= graceMs;
      checks.push({ name: exp.name, ok: !waited, detail: waited ? 'has never reported' : 'not reported yet (starting up)' });
      continue;
    }
    const age = Math.floor((now - last.getTime()) / 60_000);
    checks.push({
      name: exp.name, ok: age <= exp.maxAgeMinutes, age_minutes: age,
      detail: age <= exp.maxAgeMinutes ? `reported ${age} min ago` : `last reported ${age} min ago (expected every ${exp.maxAgeMinutes} min or less)`,
    });
  }

  if (env.opsDbSizeAlertGb > 0) {
    try {
      const r = await query<{ bytes: string }>(`SELECT pg_database_size(current_database())::text AS bytes`);
      const gb = Number(r.rows[0].bytes) / 1024 ** 3;
      checks.push({ name: 'database_size', ok: gb < env.opsDbSizeAlertGb, detail: `${gb.toFixed(2)} GB (alert at ${env.opsDbSizeAlertGb} GB)` });
    } catch {
      /* a failure here is not worth an alert */
    }
  }
  return checks;
}

// ── Alerting ───────────────────────────────────────────────────────────

export type AlertSender = (subject: string, body: string) => Promise<void>;
let senderHook: AlertSender | undefined;
export function setAlertHook(h: AlertSender | undefined): void {
  senderHook = h;
}
let pingHook: ((url: string) => Promise<void>) | undefined;
export function setPingHook(h: ((url: string) => Promise<void>) | undefined): void {
  pingHook = h;
}

export function alertsConfigured(): boolean {
  return !!(senderHook || env.alertWebhookUrl || (env.alertEmail && mailerConfigured()));
}

async function deliver(subject: string, body: string): Promise<void> {
  if (senderHook) return senderHook(subject, body);
  const text = `${subject}\n${body}`;
  if (env.alertWebhookUrl) {
    try {
      // `text` is what Slack / Teams / ntfy-style hooks read, `content` is Discord's.
      await fetch(env.alertWebhookUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      logger.warn('alert webhook failed', { error: (e as Error).message });
    }
  }
  if (env.alertEmail && mailerConfigured()) {
    for (const to of env.alertEmail.split(',').map((s) => s.trim()).filter(Boolean)) {
      try {
        await sendMail({ to, subject, text: body });
      } catch (e) {
        logger.warn('alert email failed', { error: (e as Error).message });
      }
    }
  }
}

interface Known { ok: boolean; since: number; lastAlert: number }
const known = new Map<string, Known>();
export function resetMonitorState(): void {
  known.clear();
}

/** Compare this run with the last one and send what changed. Returns the messages sent (for tests). */
export async function reportChanges(checks: Check[], now = Date.now()): Promise<string[]> {
  const sent: string[] = [];
  const reminderMs = env.opsReminderHours * 3_600_000;
  for (const c of checks) {
    const before = known.get(c.name);
    if (!c.ok) {
      if (!before || before.ok) {
        known.set(c.name, { ok: false, since: now, lastAlert: now });
        sent.push(`ALERT: ${c.name}`);
        await deliver(`[ALERT] ${c.name}`, `${c.name}: ${c.detail}`);
      } else if (reminderMs > 0 && now - before.lastAlert >= reminderMs) {
        before.lastAlert = now;
        const hours = Math.round((now - before.since) / 3_600_000);
        sent.push(`REMINDER: ${c.name}`);
        await deliver(`[STILL FAILING] ${c.name}`, `${c.name}: ${c.detail} (failing for ${hours} h)`);
      }
    } else {
      if (before && !before.ok) {
        sent.push(`RESOLVED: ${c.name}`);
        await deliver(`[RESOLVED] ${c.name}`, `${c.name}: ${c.detail}`);
      }
      known.set(c.name, { ok: true, since: before?.ok ? before.since : now, lastAlert: 0 });
    }
  }
  return sent;
}

async function pingDeadMansSwitch(): Promise<void> {
  if (!env.opsPingUrl) return;
  try {
    if (pingHook) await pingHook(env.opsPingUrl);
    else await fetch(env.opsPingUrl, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    logger.warn('ops ping failed', { error: (e as Error).message });
  }
}

/** One monitor cycle: check, alert on change, ping the dead-man's switch when all is well. */
export async function monitorOnce(now = Date.now()): Promise<Check[]> {
  const checks = await runChecks(now);
  await reportChanges(checks, now);
  if (checks.every((c) => c.ok)) await pingDeadMansSwitch();
  return checks;
}

export function startOpsMonitor(): () => void {
  if (!env.opsMonitorEnabled) return () => undefined;
  const run = () => { void monitorOnce().catch((e) => logger.error('ops monitor failed', { error: (e as Error).message })); };
  const first = setTimeout(run, 60_000);
  const every = setInterval(run, Math.max(1, env.opsMonitorIntervalMinutes) * 60_000);
  first.unref();
  every.unref();
  logger.info('ops monitor started', { alerts: alertsConfigured(), ping: !!env.opsPingUrl });
  return () => { clearTimeout(first); clearInterval(every); };
}
