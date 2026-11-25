/**
 * Connect WhatsApp through Meta (slice 10.2): what the browser needs to open Meta's sign-up window,
 * and the call that finishes the connection on the server.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';
import type { Credential } from '../lib/workspace';

export interface MetaSignupConfig {
  enabled: boolean;
  app_id?: string;
  config_id?: string;
  graph_version?: string;
}

/** `enabled` is false until the server has the Meta app settings: the button then never shows. */
export function useMetaSignupConfig() {
  return useQuery({
    queryKey: ['whatsapp-meta-config'],
    queryFn: async () => (await api.get<MetaSignupConfig>('/api/whatsapp/meta/config')).data,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

export function useConnectMeta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: { code: string; waba_id: string; phone_number_id?: string }) =>
      (await api.post<Credential>('/api/whatsapp/meta/connect', b)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credentials'] }),
  });
}
