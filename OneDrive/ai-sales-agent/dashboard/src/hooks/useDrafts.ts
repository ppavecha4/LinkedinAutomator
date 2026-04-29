/**
 * React Query hooks for the LinkedIn drafts queue.
 *
 *   useLinkedInDrafts(campaignId?)  — list of pending operator-action drafts
 *   useMarkDraftSent()              — flip a row to OPERATOR_SENT
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';

export interface LinkedInDraft {
  id: string;
  contact_id: string;
  campaign_id: string;
  channel: 'linkedin' | 'email' | 'whatsapp';
  subject: string | null;
  body: string;
  status: 'DRAFTED' | 'OPERATOR_SENT' | string;
  pitch_type: string | null;
  sequence_step: number | null;
  linkedin_profile_url: string | null;
  created_at: string;
  contact_name: string | null;
  contact_title: string | null;
  contact_linkedin_url: string | null;
  company_name: string | null;
  campaign_name: string | null;
  sender_name: string | null;
}

export function useLinkedInDrafts(campaignId?: string) {
  const qs = new URLSearchParams({ channel: 'linkedin' });
  if (campaignId) qs.set('campaign_id', campaignId);
  return useQuery({
    queryKey: ['drafts', 'linkedin', campaignId ?? 'all'],
    queryFn: async () => {
      const { data } = await api.get<LinkedInDraft[]>(
        `/api/messages/drafts?${qs.toString()}`,
      );
      return data;
    },
    // Refresh while the operator is on the page so newly-arrived drafts
    // appear without needing a manual reload.
    refetchInterval: 20_000,
  });
}

export function useMarkDraftSent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (messageId: string) => {
      const { data } = await api.post<{
        message_id: string;
        status: string;
        operator_sent_at: string;
        already_sent: boolean;
      }>(`/api/messages/${messageId}/mark-sent`);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['drafts', 'linkedin'] });
      // Funnel + campaign metrics include OPERATOR_SENT in their `contacted`
      // counters, so refresh those too.
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      qc.invalidateQueries({ queryKey: ['analytics'] });
    },
  });
}
