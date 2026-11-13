/**
 * SaaS phase 1 — db/client.ts applies the tenant context.
 *
 * `pg` is mocked, so this runs without a database. It pins the exact
 * statement sequence: inside a tenant, every statement runs in a
 * transaction whose first statement is set_config('app.current_org', <org>,
 * true); outside a tenant nothing changes.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  pool: [] as Array<{ text: string; params?: unknown[] }>,
  client: [] as Array<{ text: string; params?: unknown[] }>,
  connects: 0,
  releases: 0,
  failOn: null as string | null,
}));

vi.mock('pg', () => {
  class Pool {
    on(): void {}
    async query(text: string, params?: unknown[]) {
      calls.pool.push({ text, params });
      return { rows: [{ via: 'pool' }], rowCount: 1 };
    }
    async connect() {
      calls.connects += 1;
      return {
        async query(text: string, params?: unknown[]) {
          calls.client.push({ text, params });
          if (calls.failOn && text === calls.failOn) throw new Error('boom');
          return { rows: [{ via: 'client' }], rowCount: 1 };
        },
        release() {
          calls.releases += 1;
        },
      };
    }
    async end(): Promise<void> {}
  }
  return { Pool };
});

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

let db: typeof import('../src/db/client');
let tenant: typeof import('../src/lib/tenantContext');

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgres://mocked/db';
  db = await import('../src/db/client');
  tenant = await import('../src/lib/tenantContext');
});

beforeEach(() => {
  calls.pool.length = 0;
  calls.client.length = 0;
  calls.connects = 0;
  calls.releases = 0;
  calls.failOn = null;
});

describe('query() tenant context', () => {
  it('outside a tenant uses the pool directly (unchanged behaviour)', async () => {
    const r = await db.query('SELECT 1', []);
    expect(r.rows[0]).toEqual({ via: 'pool' });
    expect(calls.pool).toEqual([{ text: 'SELECT 1', params: [] }]);
    expect(calls.connects).toBe(0);
  });

  it('inside a tenant wraps the statement with set_config in a transaction', async () => {
    const r = await tenant.runWithTenant(
      { orgId: ORG, userId: USER, role: 'owner' },
      () => db.query('SELECT * FROM campaigns WHERE id = $1', ['c1']),
    );
    expect(r.rows[0]).toEqual({ via: 'client' });
    expect(calls.pool).toEqual([]);
    expect(calls.client).toEqual([
      { text: 'BEGIN', params: undefined },
      { text: 'SELECT set_config($1, $2, true)', params: ['app.current_org', ORG] },
      { text: 'SELECT * FROM campaigns WHERE id = $1', params: ['c1'] },
      { text: 'COMMIT', params: undefined },
    ]);
    expect(calls.releases).toBe(1);
  });

  it('keeps the tenant across awaits inside the request', async () => {
    await tenant.runWithTenant({ orgId: ORG, userId: USER, role: 'member' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      await db.query('SELECT 2');
    });
    expect(calls.client[1]).toEqual({
      text: 'SELECT set_config($1, $2, true)',
      params: ['app.current_org', ORG],
    });
  });
});

describe('withTransaction() tenant context', () => {
  it('sets the org right after BEGIN, before the caller runs', async () => {
    await tenant.runWithTenant({ orgId: ORG, userId: USER, role: 'admin' }, () =>
      db.withTransaction(async (client) => {
        await client.query('INSERT INTO campaigns DEFAULT VALUES');
      }),
    );
    expect(calls.client.map((c) => c.text)).toEqual([
      'BEGIN',
      'SELECT set_config($1, $2, true)',
      'INSERT INTO campaigns DEFAULT VALUES',
      'COMMIT',
    ]);
  });

  it('outside a tenant does not call set_config', async () => {
    await db.withTransaction(async (client) => {
      await client.query('SELECT 3');
    });
    expect(calls.client.map((c) => c.text)).toEqual(['BEGIN', 'SELECT 3', 'COMMIT']);
  });

  it('rolls back and releases when the statement fails', async () => {
    calls.failOn = 'SELECT broken';
    await expect(
      tenant.runWithTenant({ orgId: ORG, userId: USER, role: 'owner' }, () =>
        db.query('SELECT broken'),
      ),
    ).rejects.toThrow('boom');
    expect(calls.client.map((c) => c.text)).toEqual([
      'BEGIN',
      'SELECT set_config($1, $2, true)',
      'SELECT broken',
      'ROLLBACK',
    ]);
    expect(calls.releases).toBe(1);
  });
});

describe('runWithTenant()', () => {
  it('rejects a non-uuid org id', () => {
    expect(() =>
      tenant.runWithTenant({ orgId: "x'; DROP TABLE campaigns; --", userId: USER, role: 'owner' }, () => 1),
    ).toThrow(/uuid/);
  });

  it('exposes nothing outside a run', () => {
    expect(tenant.currentTenant()).toBeUndefined();
  });
});
