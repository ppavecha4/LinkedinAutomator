/**
 * React Query hooks for campaign endpoints.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';
import type {
  Campaign,
  CampaignDetail,
  CampaignAnalytics,
  CampaignStatus,
  Prospect,
} from '../lib/types';

export function useCampaigns(status?: CampaignStatus) {
  const qs = status ? `?status=${status}` : '';
  return useQuery({
    queryKey: ['campaigns', status ?? 'all'],
    queryFn: async () => {
      const { data } = await api.get<Campaign[]>(`/api/campaigns${qs}`);
      return data;
    },
    refetchInterval: 15_000,
  });
}

export function useCampaign(id: string | undefined) {
  return useQuery({
    queryKey: ['campaign', id],
    queryFn: async () => {
      const { data } = await api.get<CampaignDetail>(`/api/campaigns/${id}`);
      return data;
    },
    enabled: !!id,
  });
}

export function useCampaignAnalytics(id: string | undefined) {
  return useQuery({
    queryKey: ['campaign-analytics', id],
    queryFn: async () => {
      const { data } = await api.get<CampaignAnalytics>(`/api/campaigns/${id}/analytics`);
      return data;
    },
    enabled: !!id,
    refetchInterval: 60_000,
  });
}

export function useCampaignProspects(id: string | undefined) {
  return useQuery({
    queryKey: ['campaign-prospects', id],
    queryFn: async () => {
      const { data } = await api.get<Prospect[]>(`/api/campaigns/${id}/prospects`);
      return data;
    },
    enabled: !!id,
  });
}

export interface CreateCampaignInput {
  name: string;
  goal: string;
  tone: string;
  sender_company: string;
  sender_name: string;
  value_proposition: string;
  icp_criteria: Record<string, unknown>;
  sequence_steps: Array<{
    step_number: number;
    channel: 'email' | 'linkedin' | 'whatsapp';
    action: string;
    delay_days: number;
    template_subject?: string;
    template_body?: string;
  }>;
  daily_limits: { email?: number; linkedin?: number; whatsapp?: number };
  batch_size: number;
}

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCampaignInput) => {
      const { data } = await api.post<Campaign>('/api/campaigns', input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });
}

export function useLaunchCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<{
        queued: boolean;
        sqs_message_id: string;
        estimated_prospects: number;
      }>(`/api/campaigns/${id}/launch`);
      return data;
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      qc.invalidateQueries({ queryKey: ['campaign', id] });
    },
  });
}

export function useSetCampaignStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: CampaignStatus }) => {
      const { data } = await api.patch<Campaign>(`/api/campaigns/${id}/status`, { status });
      return data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      qc.invalidateQueries({ queryKey: ['campaign', vars.id] });
    },
  });
}

/**
 * Prospect-count estimate endpoint is not implemented in the API yet.
 * This hook exists so the ICP step can show a placeholder and flip to
 * real data later with zero UI changes. Tracked in project memory.
 */
export function useEstimateProspects(_icp: Record<string, unknown>) {
  return useQuery({
    queryKey: ['estimate', 'placeholder'],
    queryFn: async () => ({
      estimate: null,
      message: 'estimate endpoint not yet wired',
    }),
    staleTime: Infinity,
  });
}
