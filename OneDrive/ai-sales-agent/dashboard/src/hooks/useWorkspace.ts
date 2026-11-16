/**
 * Organization settings, connected accounts and saved offerings.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';
import type { Offering } from '../lib/profile';
import type { Credential, Organization } from '../lib/workspace';

export function useOrganization() {
  return useQuery({
    queryKey: ['organization'],
    queryFn: async () => (await api.get<Organization>('/api/organization')).data,
    staleTime: 60_000,
  });
}

export function useUpdateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<Pick<Organization, 'name' | 'default_language' | 'default_country' | 'timezone'>>) =>
      (await api.patch<Organization>('/api/organization', patch)).data,
    onSuccess: (data) => qc.setQueryData(['organization'], data),
  });
}

export function useCredentials() {
  return useQuery({
    queryKey: ['credentials'],
    queryFn: async () => (await api.get<Credential[]>('/api/credentials')).data,
  });
}

export function useSaveCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: { provider: string; secret: Record<string, string>; meta: Record<string, string | number> }) =>
      (await api.put<Credential>(`/api/credentials/${b.provider}`, { secret: b.secret, meta: b.meta })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credentials'] }),
  });
}

export function useVerifyCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.post<Credential>(`/api/credentials/${id}/verify`)).data,
    onSettled: () => qc.invalidateQueries({ queryKey: ['credentials'] }),
  });
}

export function useRemoveCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete<Credential>(`/api/credentials/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credentials'] }),
  });
}

export interface SavedOffering extends Offering {
  id: string;
  source_prompt: string | null;
  created_at: string;
  updated_at: string;
}

export function useOfferings() {
  return useQuery({
    queryKey: ['offerings'],
    queryFn: async () => (await api.get<SavedOffering[]>('/api/offerings')).data,
  });
}
