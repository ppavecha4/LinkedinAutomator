/**
 * Platform administration: every company, and what admins changed.
 * Only works for platform admins (the API answers 403 otherwise).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';
import type { OrgChannel } from '../lib/workspace';

export type Plan = 'free' | 'starter' | 'growth' | 'scale' | 'enterprise';
export type OrgStatus = 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';

export const PLANS: Plan[] = ['free', 'starter', 'growth', 'scale', 'enterprise'];

export interface PlatformOrg {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  status: OrgStatus;
  channels: OrgChannel[];
  created_at: string;
  onboarding_completed_at: string | null;
  onboarding_ai_calls: number;
  members: number;
  campaigns: number;
  active_campaigns: number;
  sent_30d: number;
  last_activity: string | null;
  operator: boolean;
}

export interface PlatformMember {
  user_id: string;
  email: string;
  full_name: string | null;
  role: string;
  last_login_at: string | null;
  email_verified: boolean;
}

export interface AuditEntry {
  id: string;
  actor_email: string;
  org_name: string | null;
  action: string;
  changes: Record<string, unknown>;
  created_at: string;
}

export interface OrgPatch {
  status?: OrgStatus;
  plan?: Plan;
  channels?: OrgChannel[];
  add_ai_calls?: number;
}

export function usePlatformOrgs(enabled = true) {
  return useQuery({
    queryKey: ['platform', 'orgs'],
    enabled,
    queryFn: async () => (await api.get<PlatformOrg[]>('/api/platform/orgs')).data,
  });
}

export function usePlatformMembers(orgId: string | null) {
  return useQuery({
    queryKey: ['platform', 'members', orgId],
    enabled: !!orgId,
    queryFn: async () => (await api.get<PlatformMember[]>(`/api/platform/orgs/${orgId}/members`)).data,
  });
}

export function usePlatformAudit() {
  return useQuery({
    queryKey: ['platform', 'audit'],
    queryFn: async () => (await api.get<AuditEntry[]>('/api/platform/audit')).data,
  });
}

export function useUpdateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: { id: string; patch: OrgPatch }) =>
      (await api.patch<{ paused_campaigns: number }>(`/api/platform/orgs/${b.id}`, b.patch)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform'] }),
  });
}

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
  age_minutes?: number;
}

export interface PlatformHealth {
  ok: boolean;
  checks: HealthCheck[];
  alerts_configured: boolean;
  dead_mans_switch: boolean;
}

/** The same checks the monitor alerts on (database, redis, cron and backup heartbeats). */
export function usePlatformHealth(enabled: boolean) {
  return useQuery({
    queryKey: ['platform', 'health'],
    queryFn: async () => (await api.get<PlatformHealth>('/api/platform/health')).data,
    enabled,
    refetchInterval: 60_000,
  });
}
