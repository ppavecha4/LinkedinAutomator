/**
 * Plan, usage this month, and paying for a plan (slices 4.1 / 4.2).
 */

import { useMutation, useQuery } from '@tanstack/react-query';

import { api } from '../lib/api';

export interface Meter {
  limit: number | null;
  used: number;
}

export interface PlanOption {
  plan: string;
  label: string;
  messages: number | null;
  campaigns: number | null;
  seats: number | null;
  can_buy: boolean;
  current: boolean;
}

/** This month's AI, paid by the platform (slice 8.1 / 8.2). Dollars; budget null = unlimited. */
export interface AiUsage {
  platform_cost_usd: number;
  own_key_cost_usd: number;
  calls: number;
  budget_usd: number | null;
  /** The platform has its own AI account, so a company needs none of its own. */
  managed: boolean;
  /** This month's platform-paid AI has reached the plan's budget. */
  exhausted: boolean;
}

export interface Billing {
  plan: string;
  plan_label: string;
  period_start: string;
  messages: Meter;
  campaigns: Meter;
  seats: Meter;
  ai: AiUsage;
  subscription: { status: string | null; renews_at: string | null; has_customer: boolean };
  payments_enabled: boolean;
  plans: PlanOption[];
}

export function useBilling() {
  return useQuery({
    queryKey: ['billing'],
    queryFn: async () => (await api.get<Billing>('/api/billing')).data,
    staleTime: 30_000,
  });
}

/** Both return the address of a Stripe page to send the browser to. */
export function useCheckout() {
  return useMutation({
    mutationFn: async (plan: string) => (await api.post<{ url: string }>('/api/billing/checkout', { plan })).data.url,
  });
}

export function usePortal() {
  return useMutation({
    mutationFn: async () => (await api.post<{ url: string }>('/api/billing/portal', {})).data.url,
  });
}
