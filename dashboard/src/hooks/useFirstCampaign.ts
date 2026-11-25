/**
 * The first campaign, proposed (slice 9.3). The proposal is the exact body for POST /api/campaigns, so
 * creating it goes through the normal campaign path; nothing is sent until the owner launches.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';
import type { OrgChannel } from '../lib/workspace';

export interface FirstCampaignBody {
  name: string;
  goal: string;
  sender_name: string;
  sender_company: string;
  offering_id: string;
  channels: OrgChannel[];
  languages: null;
  language_fallback: 'country';
  sequence_steps: Array<{ step_number: number; channel: OrgChannel; action: 'follow_up'; delay_days: number }>;
}

export interface FirstCampaignView {
  existing_campaigns: number;
  latest: { id: string; name: string; status: string } | null;
  proposal: {
    body: FirstCampaignBody;
    summary: {
      offering: string;
      goal: string;
      channels: OrgChannel[];
      audience: string[];
      follow_ups: { count: number; gap_days: number; channels: OrgChannel[] };
      languages: string;
    };
  } | null;
  blockers: string[];
}

const KEY = ['first-campaign'];

export function useFirstCampaign(enabled = true) {
  return useQuery({
    queryKey: KEY,
    enabled,
    staleTime: 15_000,
    queryFn: async () => (await api.get<FirstCampaignView>('/api/setup/first-campaign')).data,
  });
}

/** Creates the proposed campaign as a draft through the normal endpoint. Returns its id. */
export function useCreateFirstCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: FirstCampaignBody) => (await api.post<{ id: string }>('/api/campaigns', body)).data.id,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });
}
