/**
 * Prospect + conversation hooks.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';
import type { Contact, Message, Prospect } from '../lib/types';

export function useProspect(id: string | undefined) {
  return useQuery({
    queryKey: ['prospect', id],
    queryFn: async () => {
      const { data } = await api.get<{ prospect: Prospect; contacts: Contact[] }>(
        `/api/prospects/${id}`,
      );
      return data;
    },
    enabled: !!id,
  });
}

export function useConversation(contactId: string | undefined) {
  return useQuery({
    queryKey: ['conversation', contactId],
    queryFn: async () => {
      const { data } = await api.get<{ contact: Contact; messages: Message[] }>(
        `/api/prospects/${contactId}/conversation`,
      );
      return data;
    },
    enabled: !!contactId,
  });
}

export function useSuppressContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contactId: string) => {
      const { data } = await api.post<{ suppressed: boolean; contact_id: string }>(
        `/api/prospects/${contactId}/suppress`,
        { reason: 'MANUAL' },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      qc.invalidateQueries({ queryKey: ['conversation'] });
    },
  });
}

/**
 * Regenerate-reply endpoint isn't implemented yet. The mutation exists so
 * the ConversationViewer can wire the button; currently it surfaces the
 * 404 gracefully (button disabled with note). Tracked in project memory.
 */
export function useRegenerateReply() {
  return useMutation({
    mutationFn: async (contactId: string) => {
      const { data } = await api.post<{ text: string }>(
        `/api/prospects/${contactId}/regenerate-reply`,
      );
      return data;
    },
  });
}
