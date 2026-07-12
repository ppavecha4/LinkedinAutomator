/**
 * React Query hooks for the unified inbox.
 *
 *   useInbox(filters)          — conversation list (all channels)
 *   useInboxThread(contactId)  — full message thread for one contact
 *
 * Auto-refreshes every 20s so webhook/poller-driven replies surface
 * without a manual reload.
 */

import { useQuery } from '@tanstack/react-query';

import { api } from '../lib/api';

export interface InboxConversation {
  conversation_id: string;
  contact_id: string;
  campaign_id: string;
  channel: 'email' | 'linkedin' | 'whatsapp';
  status: string;
  last_message_at: string | null;
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
}

interface InboxFilters {
  channel?: 'email' | 'linkedin' | 'whatsapp';
  unread?: boolean;
}

export function useInbox(filters: InboxFilters = {}) {
  const params = new URLSearchParams();
  if (filters.channel) params.set('channel', filters.channel);
  if (filters.unread) params.set('unread', 'true');
  const qs = params.toString();
  return useQuery({
    queryKey: ['inbox', filters],
    queryFn: async () => {
      const { data } = await api.get<{
        conversations: InboxConversation[];
        total: number;
        unread: number;
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
