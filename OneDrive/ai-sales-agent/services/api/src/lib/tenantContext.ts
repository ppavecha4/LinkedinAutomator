/**
 * Per-request tenant context (SaaS phase 1, see docs/saas-architecture.md).
 *
 * The auth middleware resolves which organization a request acts for and
 * runs the rest of the request inside `runWithTenant()`. Anything further
 * down the call chain (route handlers, `db/client.ts`) reads it with
 * `currentTenant()`, so no route has to pass an org id around by hand.
 *
 * `db/client.ts` turns the context into the Postgres setting
 * `app.current_org` (transaction-local), which the V17 row-level-security
 * policies will filter on. Until V17 ships, the setting is informational:
 * V16's column defaults still put every insert in the legacy org.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** The legacy single-operator org created by V16__organizations.sql. */
export const LEGACY_ORG_ID = '00000000-0000-0000-0000-0000000000a1';

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';
export const ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member', 'viewer'];

export interface TenantContext {
  orgId: string;
  userId: string;
  role: OrgRole;
}

const storage = new AsyncLocalStorage<TenantContext>();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
}

/** Run `fn` (and everything it awaits) as `ctx`'s tenant. */
export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  if (!isUuid(ctx.orgId)) {
    throw new Error(`runWithTenant: orgId must be a uuid, got ${String(ctx.orgId)}`);
  }
  return storage.run(ctx, fn);
}

/** The tenant this code is running for, or undefined outside a request. */
export function currentTenant(): TenantContext | undefined {
  return storage.getStore();
}
