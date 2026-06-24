/**
 * React Query hooks for the prospect/campaign timeline.
 *
 *   useProspectTimeline(contactId)   — all events for one prospect
 *   useCampaignTimeline(campaignId)  — rolled-up campaign timeline
 *   useRecordEvent()                 — POST a manual event
 *
 * The timeline is the read+write surface backed by `prospect_events`
 * (V11). Auto-refreshes every 30s so concurrent operator actions or
 * webhook events show up without manual reload.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';

export interface TimelineEvent {
  id: string;
  campaign_id: string;
  prospect_id: string;
  contact_id: string | null;
  message_id: string | null;
  channel: 'email' | 'linkedin' | 'whatsapp' | null;
  event_type: string;
  source: 'system' | 'operator' | 'webhook' | 'manual';
  actor_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
  // Only present on the campaign-timeline endpoint:
  contact_name?: string | null;
  contact_title?: string | null;
  company_name?: string | null;
}

export function useProspectTimeline(contactId: string | undefined) {
  return useQuery({
    queryKey: ['timeline', 'prospect', contactId],
    queryFn: async () => {
      const { data } = await api.get<TimelineEvent[]>(
        `/api/prospects/${contactId}/timeline?limit=100`,
      );
      return data;
    },
    enabled: !!contactId,
    refetchInterval: 30_000,
  });
}

export function useCampaignTimeline(campaignId: string | undefined) {
  return useQuery({
    queryKey: ['timeline', 'campaign', campaignId],
    queryFn: async () => {
      const { data } = await api.get<TimelineEvent[]>(
        `/api/campaigns/${campaignId}/timeline?limit=100`,
      );
      return data;
    },
    enabled: !!campaignId,
    refetchInterval: 30_000,
  });
}

export interface RecordEventInput {
  contactId: string;
  event_type:
    | 'connection_requested'
    | 'connection_accepted'
    | 'connection_declined'
    | 'message_opened'
    | 'message_replied'
    | 'message_bounced'
    | 'meeting_booked'
    | 'meeting_completed'
    | 'opted_out'
    | 'note';
  channel?: 'email' | 'linkedin' | 'whatsapp';
  message_id?: string;
  payload?: Record<string, unknown>;
}

export function useRecordEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecordEventInput) => {
      const { contactId, ...body } = input;
      const { data } = await api.post<TimelineEvent>(
        `/api/prospects/${contactId}/events`,
        body,
      );
      return data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['timeline', 'prospect', vars.contactId] });
      qc.invalidateQueries({ queryKey: ['timeline', 'campaign'] });
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      qc.invalidateQueries({ queryKey: ['analytics'] });
    },
  });
}
