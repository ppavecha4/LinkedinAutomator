/**
 * React Query hooks for the unified inbox.
 *
 *   useInbox(filters)          — conversation list (all channels)
 *   useInboxThread(contactId)  — full message thread for one contact
 *   useSendReply / useDiscardDraft / useConversationState — what a person does with a reply
 *
 * Auto-refreshes every 20s so webhook/poller-driven replies surface
 * without a manual reload.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';

export interface InboxConversation {
  conversation_id: string;
  contact_id: string;
  campaign_id: string;
  channel: 'email' | 'linkedin' | 'whatsapp';
  status: string;
  last_message_at: string | null;
  handled_by: 'ai' | 'person';
  needs_person_reason: string | null;
  full_name: string;
  title: string | null;
  email: string | null;
  linkedin_url: string | null;
  company_name: string | null;
  prospect_status: string;
  service_line: string | null;
  market_tier: string | null;
  campaign_name: string;
  last_direction: 'inbound' | 'outbound' | null;
  last_body: string | null;
  needs_reply: boolean;
}

export interface InboxThreadMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  channel: 'email' | 'linkedin' | 'whatsapp';
  sent_at: string;
  /** For our answers: where the send stands, and whether the assistant or a person wrote it. */
  delivery: string | null;
  kind: 'ai_reply' | 'person_reply' | null;
}

export interface ConversationState {
  conversation_id: string;
  channel: 'email' | 'linkedin' | 'whatsapp';
  status: string;
  handled_by: 'ai' | 'person';
  needs_person_reason: string | null;
  draft_id: string | null;
  draft_body: string | null;
}

export interface InboxThread {
  contact: {
    id: string;
    full_name: string;
    title: string | null;
    email: string | null;
    linkedin_url: string | null;
    whatsapp_number: string | null;
    company_name: string | null;
    prospect_status: string;
    country: string | null;
    service_line: string | null;
    capability: string | null;
    market_tier: string | null;
    campaign_id: string;
    campaign_name: string;
  } | null;
  messages: InboxThreadMessage[];
  conversations: ConversationState[];
}

interface InboxFilters {
  channel?: 'email' | 'linkedin' | 'whatsapp';
  unread?: boolean;
  attention?: boolean;
}

export function useInbox(filters: InboxFilters = {}) {
  const params = new URLSearchParams();
  if (filters.channel) params.set('channel', filters.channel);
  if (filters.unread) params.set('unread', 'true');
  if (filters.attention) params.set('attention', 'true');
  const qs = params.toString();
  return useQuery({
    queryKey: ['inbox', filters],
    queryFn: async () => {
      const { data } = await api.get<{
        conversations: InboxConversation[];
        total: number;
        unread: number;
        attention: number;
      }>(`/api/inbox${qs ? `?${qs}` : ''}`);
      return data;
    },
    refetchInterval: 20_000,
  });
}

export function useInboxThread(contactId: string | undefined) {
  return useQuery({
    queryKey: ['inbox', 'thread', contactId],
    enabled: !!contactId,
    queryFn: async () => {
      const { data } = await api.get<InboxThread>(`/api/inbox/${contactId}`);
      return data;
    },
    refetchInterval: 20_000,
  });
}

function useInboxAction<T>(run: (input: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: () => qc.invalidateQueries({ queryKey: ['inbox'] }),
  });
}

export function useSendReply() {
  return useInboxAction((v: { id: string; body: string; draftId?: string }) =>
    api.post(`/api/inbox/conversations/${v.id}/reply`, { body: v.body, ...(v.draftId ? { draft_id: v.draftId } : {}) }));
}

export function useDiscardDraft() {
  return useInboxAction((v: { id: string; draftId: string }) =>
    api.post(`/api/inbox/conversations/${v.id}/discard-draft`, { draft_id: v.draftId }));
}

export function useConversationState() {
  return useInboxAction((v: { id: string; handled_by?: 'ai' | 'person'; handled?: true }) => {
    const { id, ...change } = v;
    return api.patch(`/api/inbox/conversations/${id}`, change);
  });
}
