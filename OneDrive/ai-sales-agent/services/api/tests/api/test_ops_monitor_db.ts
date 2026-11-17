/**
 * Slice 6.3: monitoring and alerting. Heartbeats go through the real V31
 * functions against a LIVE database as the non-superuser app role; the alert
 * channels are replaced by hooks (nothing is sent anywhere).
 */

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import {
  monitorOnce, parseExpected, reportChanges, resetMonitorState, runChecks, setAlertHook, setPingHook, type Check,
} from '../../src/lib/opsMonitor';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
const JOB_A = `test_job_a_${RUN}`;
const JOB_B = `test_job_b_${RUN}`;
const MIN = 60_000;

describe('expected heartbeats', () => {
  it('parses "name:minutes" lists and ignores junk', () => {
    expect(parseExpected('auto_sends:20, backup:1560')).toEqual([
      { name: 'auto_sends', maxAgeMinutes: 20 }, { name: 'backup', maxAgeMinutes: 1560 }]);
    expect(parseExpected('nominutes, bad:abc, zero:0, :5, ok:1')).toEqual([{ name: 'ok', maxAgeMinutes: 1 }]);
    expect(parseExpected('')).toEqual([]);
  });
});

describe('alerts on change (no database)', () => {
  const sent: Array<{ subject: string; body: string }> = [];
  const ok = (name: string, detail = 'fine'): Check => ({ name, ok: true, detail });
  const bad = (name: string, detail = 'broken'): Check => ({ name, ok: false, detail });
  const original = { ...env };

  afterEach(() => {
    Object.assign(env, original);
    setAlertHook(undefined);
    setPingHook(undefined);
    resetMonitorState();
    sent.length = 0;
    vi.restoreAllMocks();
  });
  const capture = () => setAlertHook(async (subject, body) => { sent.push({ subject, body }); });

  it('alerts once when something starts failing, reminds later, and says when it is fixed', async () => {
    capture();
    env.opsReminderHours = 6;
    const t0 = 1_800_000_000_000;
    expect(await reportChanges([ok('backup')], t0)).toEqual([]);                       // healthy: silence
    expect(await reportChanges([bad('backup', 'no backup for 27 h')], t0 + MIN)).toEqual(['ALERT: backup']);
    expect(await reportChanges([bad('backup')], t0 + 6 * MIN)).toEqual([]);            // same failure: not again
    expect(await reportChanges([bad('backup')], t0 + 5 * 60 * MIN)).toEqual([]);       // 5 h: still quiet
    expect(await reportChanges([bad('backup')], t0 + 7 * 60 * MIN)).toEqual(['REMINDER: backup']);
    expect(await reportChanges([ok('backup', 'reported 3 min ago')], t0 + 8 * 60 * MIN)).toEqual(['RESOLVED: backup']);
    expect(await reportChanges([ok('backup')], t0 + 9 * 60 * MIN)).toEqual([]);
    expect(await reportChanges([bad('backup')], t0 + 10 * 60 * MIN)).toEqual(['ALERT: backup']);   // it can fail again

    expect(sent.map((m) => m.subject)).toEqual([
      '[ALERT] backup', '[STILL FAILING] backup', '[RESOLVED] backup', '[ALERT] backup']);
    expect(sent[0].body).toBe('backup: no backup for 27 h');
  });

  it('tracks each check on its own, and a check that was never healthy still alerts once', async () => {
    capture();
    const t = 1_800_000_000_000;
    expect(await reportChanges([bad('database'), ok('redis')], t)).toEqual(['ALERT: database']);
    expect(await reportChanges([bad('database'), bad('redis')], t + MIN)).toEqual(['ALERT: redis']);
  });

  it('reminders can be switched off', async () => {
    capture();
    env.opsReminderHours = 0;
    const t = 1_800_000_000_000;
    await reportChanges([bad('x')], t);
    expect(await reportChanges([bad('x')], t + 100 * 60 * MIN)).toEqual([]);
  });

  it('posts to the chat webhook in the shape Slack and Discord both read', async () => {
    env.alertWebhookUrl = 'https://hooks.example.test/abc';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await reportChanges([bad('database', 'not answering')], 1_800_000_000_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.example.test/abc');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.text).toBe('[ALERT] database\ndatabase: not answering');
    expect(body.content).toBe(body.text);
  });

  it('a webhook that is down does not break the monitor', async () => {
    env.alertWebhookUrl = 'https://hooks.example.test/abc';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'));
    await expect(reportChanges([bad('database')], 1_800_000_000_000)).resolves.toEqual(['ALERT: database']);
  });
});

describeIfDb('monitor checks against the database (live DB)', () => {
  const original = { ...env };
  const operator = request.agent(buildApp());
  const customer = request.agent(buildApp());
  const beat = (name: string, detail?: string) => query(`SELECT ops_heartbeat($1, $2)`, [name, detail ?? null]);
  const find = (checks: Check[], name: string) => checks.find((c) => c.name === name)!;

  beforeAll(async () => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.dashboardUrl = 'http://dash.test';
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    env.opsExpectedHeartbeats = `${JOB_A}:10,${JOB_B}:60`;
    env.opsGraceMinutes = 0;
    env.opsDbSizeAlertGb = 0;
    env.redisUrl = '';
    expect((await operator.post('/api/auth/login').send({ email: 'operator@appson.test', password: 'operator-password-1' })).status).toBe(200);
  });

  afterAll(async () => {
    Object.assign(env, original);
    setAlertHook(undefined);
    setPingHook(undefined);
    resetMonitorState();
    await closePool();
  });

  it('a job that has never reported is a failure once the start-up grace is over', async () => {
    const checks = await runChecks();
    expect(find(checks, 'database')).toMatchObject({ ok: true });
    expect(find(checks, JOB_A)).toMatchObject({ ok: false, detail: 'has never reported' });
    expect(find(checks, JOB_B)).toMatchObject({ ok: false });
    // …but not during it.
    env.opsGraceMinutes = 10_000;
    expect(find(await runChecks(), JOB_A)).toMatchObject({ ok: true, detail: expect.stringMatching(/starting up/) });
    env.opsGraceMinutes = 0;
  });

  it('heartbeats make a job healthy, and silence makes it stale', async () => {
    await beat(JOB_A, 'tick');
    await beat(JOB_B);
    let checks = await runChecks();
    expect(find(checks, JOB_A)).toMatchObject({ ok: true, age_minutes: 0 });
    expect(find(checks, JOB_B)).toMatchObject({ ok: true });

    // Three hours of silence: A (10 min) and B (60 min) both go stale.
    checks = await runChecks(Date.now() + 180 * MIN);
    expect(find(checks, JOB_A)).toMatchObject({ ok: false, age_minutes: expect.any(Number) });
    expect(find(checks, JOB_A).detail).toMatch(/expected every 10 min or less/);
    expect(find(checks, JOB_B).ok).toBe(false);
    // A fresh heartbeat heals only that job.
    await beat(JOB_A);
    checks = await runChecks(Date.now() + 5 * MIN);
    expect(find(checks, JOB_A).ok).toBe(true);
  });

  it('the dead-mans switch is pinged only when every check passes, and alerts fire through the cycle', async () => {
    const alerts: string[] = [];
    const pings: string[] = [];
    setAlertHook(async (s) => { alerts.push(s); });
    setPingHook(async (url) => { pings.push(url); });
    env.opsPingUrl = 'https://hc.example.test/uuid';
    resetMonitorState();

    await beat(JOB_A);
    await beat(JOB_B);
    await monitorOnce();
    expect(pings).toEqual(['https://hc.example.test/uuid']);
    expect(alerts).toEqual([]);

    await monitorOnce(Date.now() + 180 * MIN);          // everything stale
    expect(pings).toHaveLength(1);                       // no ping: that silence is the alarm
    expect(alerts.sort()).toEqual([`[ALERT] ${JOB_A}`, `[ALERT] ${JOB_B}`].sort());
    await monitorOnce(Date.now() + 181 * MIN);
    expect(alerts).toHaveLength(2);                      // not repeated

    await beat(JOB_A);
    await beat(JOB_B);
    await monitorOnce();
    expect(alerts.filter((a) => a.startsWith('[RESOLVED]'))).toHaveLength(2);
    expect(pings).toHaveLength(2);
  });

  it('the database-size check alerts over the limit', async () => {
    env.opsDbSizeAlertGb = 1000;
    expect(find(await runChecks(), 'database_size')).toMatchObject({ ok: true });
    env.opsDbSizeAlertGb = 0.000001;
    expect(find(await runChecks(), 'database_size')).toMatchObject({ ok: false });
    env.opsDbSizeAlertGb = 0;
  });

  it('platform admins see the checks; customers and anonymous callers do not', async () => {
    const res = await operator.get('/api/platform/health');
    expect(res.status).toBe(200);
    expect(res.body.data.checks.map((c: Check) => c.name)).toEqual(expect.arrayContaining(['database', JOB_A, JOB_B]));
    expect(res.body.data).toMatchObject({ alerts_configured: true, dead_mans_switch: true });

    expect((await request(buildApp()).get('/api/platform/health')).status).toBe(401);
    const org = await customer.post('/api/auth/signup').send({
      full_name: 'Cy', company: `Ops Co ${RUN}`, email: `cy.${RUN}@ops-test.example`, password: 'a-long-password-1', accept_terms: true });
    expect(org.status).toBe(201);
    expect((await customer.get('/api/platform/health')).status).toBe(403);
    // Clean up the customer company.
    const { runWithTenant } = await import('../../src/lib/tenantContext');
    const uid = (await customer.get('/api/auth/me')).body.data.user.uid;
    await runWithTenant({ orgId: org.body.data.org.org_id, userId: uid, role: 'owner' }, async () => {
      await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
      await query(`DELETE FROM organizations WHERE id = $1`, [org.body.data.org.org_id]);
    });
  });

  it('only the heartbeat functions can touch the table', async () => {
    const direct = await query(`SELECT * FROM ops_heartbeats`);
    expect(direct.rowCount).toBe(0);   // FORCE RLS, no policy: the app role sees nothing directly
    const viaFn = await query<{ name: string }>(`SELECT * FROM ops_heartbeats_read()`);
    expect(viaFn.rows.map((r) => r.name)).toEqual(expect.arrayContaining([JOB_A, JOB_B]));
  });
});
