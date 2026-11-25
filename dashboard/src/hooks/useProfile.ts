/**
 * Business profile queries + mutations (GET/PUT /api/profile, the
 * onboarding AI helpers, and finishing onboarding).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';
import type {
  AiUse,
  Offering,
  Profile,
  ProfileResponse,
  Section,
  Understanding,
} from '../lib/profile';

export const PROFILE_KEY = ['profile'] as const;

export function useProfile() {
  return useQuery({
    queryKey: PROFILE_KEY,
    queryFn: async () => (await api.get<ProfileResponse>('/api/profile')).data,
  });
}

export function useSaveSection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ section, value }: { section: Section; value: object }) =>
      (await api.put<Pick<ProfileResponse, 'profile' | 'completeness'>>(`/api/profile/${section}`, value)).data,
    onSuccess: (data) => {
      qc.setQueryData<ProfileResponse>(PROFILE_KEY, (old) => (old ? { ...old, ...data } : old));
    },
  });
}

export interface WebsiteDraft {
  draft: Partial<Pick<Profile, 'company' | 'offer'>>;
  sources: string[];
  ai: AiUse;
}

/** AI calls change the allowance shown on screen, so refetch the profile after. */
function useAiMutation<TVars, TData>(fn: (v: TVars) => Promise<TData>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => qc.invalidateQueries({ queryKey: PROFILE_KEY }),
  });
}

export function useReadWebsite() {
  return useAiMutation(async (url: string) =>
    (await api.post<WebsiteDraft>('/api/profile/read-website', { url })).data,
  );
}

export function useUnderstanding() {
  return useAiMutation<void, Understanding>(async () => (await api.post<Understanding>('/api/profile/understanding')).data);
}

export interface SampleProspect {
  name: string;
  title?: string;
  company: string;
  country?: string;
  context?: string;
}

export function useSampleMessage() {
  return useAiMutation(async (b: { channel: 'email' | 'whatsapp'; prospect: SampleProspect }) =>
    (await api.post<{ message: string; channel: string; ai: AiUse }>('/api/profile/sample-message', b)).data,
  );
}

export function useCompleteOnboarding() {
  return useMutation({
    mutationFn: async (offering?: Offering) =>
      (await api.post<{ onboarding_completed_at: string; offering_id: string | null }>(
        '/api/onboarding/complete',
        offering ? { offering } : {},
      )).data,
  });
}
