/**
 * AI phone calls: the list, one call's transcript, who can be called, and
 * queueing calls (voice channel).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';

export type CallStatus =
  | 'QUEUED' | 'DIALING' | 'IN_PROGRESS' | 'COMPLETED' | 'NO_ANSWER' | 'BUSY' | 'VOICEMAIL' | 'FAILED' | 'BLOCKED' | 'CANCELLED';

export interface CallRow {
  id: string;
  status: CallStatus;
  outcome: string | null;
  to_number: string | null;
  language: string | null;
  created_at: string;
  answered_at: string | null;
  duration_seconds: number | null;
  failure_reason: string | null;
  summary: string | null;
  campaign_id: string | null;
  contact_name: string | null;
  company_name: string | null;
}

export interface TranscriptTurn {
  who: 'agent' | 'user';
  text: string;
  t: number;
  interrupted?: boolean;
}

export interface CallDetail extends CallRow {
  transcript: TranscriptTurn[];
}

export interface Eligibility {
  total: number;
  eligible: number;
  no_phone: number;
  suppressed: number;
  not_contactable: number;
  no_basis: number;
  already_called: number;
}

export function useCalls(campaignId?: string) {
  return useQuery({
    queryKey: ['calls', campaignId ?? 'all'],
    queryFn: async () => (await api.get<CallRow[]>(`/api/calls?limit=100${campaignId ? `&campaign_id=${campaignId}` : ''}`)).data,
    refetchInterval: 10_000,
  });
}

export function useCall(id: string | null) {
  return useQuery({
    queryKey: ['call', id],
    enabled: !!id,
    queryFn: async () => (await api.get<CallDetail>(`/api/calls/${id}`)).data,
  });
}

export function useEligibility(campaignId: string | undefined) {
  return useQuery({
    queryKey: ['calls', 'eligibility', campaignId],
    enabled: !!campaignId,
    queryFn: async () => (await api.get<Eligibility>(`/api/campaigns/${campaignId}/calls/eligibility`)).data,
  });
}

function useCallsMutation<T, V>(fn: (v: V) => Promise<T>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['calls'] }) });
}

export const useQueueCalls = () =>
  useCallsMutation(async (campaignId: string) =>
    (await api.post<{ queued: number; skipped: Record<string, number> }>(`/api/campaigns/${campaignId}/calls`, {})).data);

export const useConfirmConsent = () =>
  useCallsMutation(async (campaignId: string) =>
    (await api.post<{ marked: number }>(`/api/campaigns/${campaignId}/voice-opt-in`, { attestation: true })).data);

export const useCancelCall = () =>
  useCallsMutation(async (id: string) => (await api.post<{ cancelled: boolean }>(`/api/calls/${id}/cancel`)).data);
