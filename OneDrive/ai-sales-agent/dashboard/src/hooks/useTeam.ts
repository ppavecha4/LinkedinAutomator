/**
 * Team: members, open invitations and the actions on them (owner/admin).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';

export type TeamRole = 'admin' | 'member' | 'viewer';

export interface TeamMember {
  user_id: string;
  email: string;
  full_name: string | null;
  role: 'owner' | TeamRole;
  last_login_at: string | null;
  email_verified: boolean;
  is_you: boolean;
}

export interface TeamInvite {
  id: string;
  email: string;
  role: TeamRole;
  created_at: string;
  expires_at: string;
  invited_by_name: string | null;
}

export interface TeamData {
  members: TeamMember[];
  invites: TeamInvite[];
  can_invite_roles: TeamRole[];
  email_enabled: boolean;
}

export interface LinkResult {
  link: string;
  emailed: boolean;
  email_error?: string;
}

const KEY = ['team'] as const;

export function useTeam(enabled = true) {
  return useQuery({
    queryKey: KEY,
    enabled,
    queryFn: async () => (await api.get<TeamData>('/api/team')).data,
  });
}

function useTeamMutation<TVars, TData>(fn: (v: TVars) => Promise<TData>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) });
}

export const useInvite = () =>
  useTeamMutation(async (b: { email: string; role: TeamRole }) =>
    (await api.post<LinkResult & { invite: TeamInvite }>('/api/team/invites', b)).data);

export const useRevokeInvite = () =>
  useTeamMutation(async (id: string) => (await api.delete(`/api/team/invites/${id}`)).data);

export const useChangeRole = () =>
  useTeamMutation(async (b: { userId: string; role: TeamRole }) =>
    (await api.patch(`/api/team/members/${b.userId}`, { role: b.role })).data);

export const useRemoveMember = () =>
  useTeamMutation(async (userId: string) => (await api.delete(`/api/team/members/${userId}`)).data);

export const useResetLink = () =>
  useTeamMutation(async (userId: string) =>
    (await api.post<LinkResult & { expires_in_minutes: number }>(`/api/team/members/${userId}/reset-link`)).data);
