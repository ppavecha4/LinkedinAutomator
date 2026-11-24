/**
 * WhatsApp message templates: the AI writes them, Meta approves them (slice 9.1).
 * Every call returns the whole picture again, so the screen only ever shows what the server says.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';

export type TemplateStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED';

export interface WhatsAppTemplate {
  id: string;
  kind: 'first' | 'followup';
  language: string;
  body: string;
  status: TemplateStatus;
  rejection_reason: string | null;
  submitted_at: string | null;
  approved_at: string | null;
}

export interface LanguageReadiness {
  language: string;
  first: TemplateStatus | null;
  followup: TemplateStatus | null;
  ready: boolean;
}

export interface TemplatesView {
  templates: WhatsAppTemplate[];
  languages: LanguageReadiness[];
  twilio_connected: boolean;
  suggested_languages: string[];
}

export interface DraftOutcome extends TemplatesView {
  saved: number;
  kept: Array<{ kind: string; language: string }>;
  problems: Array<{ kind: string; language: string; issues: string[] }>;
}

export interface SubmitOutcome extends TemplatesView {
  results: Array<{ id: string; kind: string; language: string; ok: boolean; error?: string }>;
}

const KEY = ['whatsapp-templates'];

export function useWhatsAppTemplates(enabled = true) {
  return useQuery({
    queryKey: KEY,
    enabled,
    queryFn: async () => (await api.get<TemplatesView>('/api/whatsapp/templates')).data,
    // While anything waits for Meta, look again every minute (the server also checks on its own).
    refetchInterval: (q) => (q.state.data?.templates.some((t) => t.status === 'PENDING') ? 60_000 : false),
  });
}

function useView<I, O extends TemplatesView>(call: (input: I) => Promise<O>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (data) => qc.setQueryData<TemplatesView>(KEY, {
      templates: data.templates, languages: data.languages, twilio_connected: data.twilio_connected, suggested_languages: data.suggested_languages,
    }),
  });
}

export const useDraftTemplates = () =>
  useView<{ languages?: string[] } | undefined, DraftOutcome>(async (b) => (await api.post<DraftOutcome>('/api/whatsapp/templates/draft', b ?? {})).data);

export const useSubmitTemplates = () =>
  useView<{ ids?: string[] } | undefined, SubmitOutcome>(async (b) => (await api.post<SubmitOutcome>('/api/whatsapp/templates/submit', b ?? {})).data);

export const useRefreshTemplates = () =>
  useView<void, TemplatesView & { checked: number; changed: number }>(async () =>
    (await api.post<TemplatesView & { checked: number; changed: number }>('/api/whatsapp/templates/refresh', {})).data);

export const useRemoveTemplate = () =>
  useView<string, TemplatesView>(async (id) => (await api.delete<TemplatesView>(`/api/whatsapp/templates/${id}`)).data);

export function useEditTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: string; body: string }) =>
      (await api.patch<{ template: WhatsAppTemplate; issues: string[] }>(`/api/whatsapp/templates/${v.id}`, { body: v.body })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
