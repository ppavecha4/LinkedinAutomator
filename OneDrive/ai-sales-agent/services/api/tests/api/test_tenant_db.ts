/**
 * SaaS phase 1 — tenant context against a LIVE Postgres.
 *
 * Proves the setting really reaches Postgres (what V17's RLS policies will
 * read) and is transaction-local. Skipped when DATABASE_URL is unset, like
 * test_campaigns.ts.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { closePool, getPool, query, withTransaction } from '../../src/db/client';
import { runWithTenant } from '../../src/lib/tenantContext';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const ORG = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const READ = "SELECT current_setting('app.current_org', true) AS org";

describeIfDb('tenant context on a live database', () => {
  afterAll(async () => {
    await closePool();
  });

  it('query() inside a tenant sees app.current_org', async () => {
    const r = await runWithTenant({ orgId: ORG, userId: USER, role: 'owner' }, () =>
      query<{ org: string }>(READ),
    );
    expect(r.rows[0].org).toBe(ORG);
  });

  it('withTransaction() inside a tenant sees app.current_org', async () => {
    const org = await runWithTenant({ orgId: ORG, userId: USER, role: 'owner' }, () =>
      withTransaction(async (c) => (await c.query<{ org: string }>(READ)).rows[0].org),
    );
    expect(org).toBe(ORG);
  });

  it('outside a tenant the setting is empty', async () => {
    const r = await query<{ org: string | null }>(READ);
    expect(r.rows[0].org ?? '').toBe('');
  });

  it('the setting does not survive on a pooled connection after the request', async () => {
    // Use every pooled connection once inside a tenant, then check them all.
    const pool = getPool();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        runWithTenant({ orgId: ORG, userId: USER, role: 'owner' }, () => query(READ)),
      ),
    );
    const clients = await Promise.all(Array.from({ length: 10 }, () => pool.connect()));
    try {
      for (const c of clients) {
        const r = await c.query<{ org: string | null }>(READ);
        expect(r.rows[0].org ?? '').toBe('');
      }
    } finally {
      clients.forEach((c) => c.release());
    }
  });
});
