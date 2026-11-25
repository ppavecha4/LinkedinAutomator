/**
 * Analytics hooks — poll every 60s per spec (analytics doesn't need WS realtime).
 */

import { useQuery } from '@tanstack/react-query';

import { api } from '../lib/api';
import type {
  CampaignRow,
  ChannelPerformanceRow,
  OverallAnalytics,
  PitchPerformanceRow,
} from '../lib/types';

const POLL_INTERVAL_MS = 60_000;

export function useOverallFunnel() {
  return useQuery({
    queryKey: ['analytics', 'funnel'],
    queryFn: async () => {
      const { data } = await api.get<OverallAnalytics>('/api/analytics/funnel');
      return data;
    },
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useCampaignRows() {
  return useQuery({
    queryKey: ['analytics', 'campaigns'],
    queryFn: async () => {
      const { data } = await api.get<CampaignRow[]>('/api/analytics/campaigns');
      return data;
    },
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function usePitchPerformance() {
  return useQuery({
    queryKey: ['analytics', 'pitch'],
    queryFn: async () => {
      const { data } = await api.get<PitchPerformanceRow[]>(
        '/api/analytics/pitch-performance',
      );
      return data;
    },
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useChannelPerformance() {
  return useQuery({
    queryKey: ['analytics', 'channels'],
    queryFn: async () => {
      const { data } = await api.get<ChannelPerformanceRow[]>('/api/analytics/channels');
      return data;
    },
    refetchInterval: POLL_INTERVAL_MS,
  });
}
