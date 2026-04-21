/**
 * Shared domain types mirroring the API's response shapes.
 *
 * Keep these in sync with services/api/src/routes/*.ts. If the API response
 * shape changes, the React Query hooks need to be reviewed.
 */

export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ARCHIVED';
export type PitchType = 'ai_agents' | 'rpa_workflow' | 'consulting';
export type Channel = 'email' | 'linkedin' | 'whatsapp';
export type ProspectStatus =
  | 'DISCOVERED'
  | 'ENRICHED'
  | 'CONTACTED'
  | 'REPLIED'
  | 'MEETING_BOOKED'
  | 'UNSUBSCRIBED'
  | 'DISQUALIFIED';

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  goal: string;
  tone: string;
  sender_company: string;
  sender_name: string;
  value_proposition: string;
  icp_criteria: Record<string, unknown>;
  daily_limits: Record<string, number>;
  batch_size: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Present on the list endpoint only (metrics join):
  total_prospects?: number;
  contacted?: number;
  replied?: number;
  meeting_booked?: number;
  messages_sent?: number;
}

export interface SequenceStep {
  id?: string;
  step_number: number;
  channel: Channel;
  action: string;
  delay_days: number;
  template_subject?: string | null;
  template_body?: string | null;
}

export interface CampaignDetail {
  campaign: Campaign;
  sequence_steps: SequenceStep[];
  metrics: {
    discovered?: string | number;
    enriched?: string | number;
    contacted?: string | number;
    replied?: string | number;
    meeting_booked?: string | number;
  };
}

export interface FunnelMetrics {
  discovered: number;
  enriched: number;
  contacted: number;
  opened: number;
  replied: number;
  meeting_booked: number;
}

export interface ChannelPerformanceRow {
  channel: Channel;
  sent: number;
  delivered: number;
  opened: number;
  replied: number;
  bounced: number;
  reply_rate_pct: string | null;
}

export interface PitchPerformanceRow {
  pitch_type: PitchType;
  total_contacted: number;
  replied: number;
  meetings: number;
  reply_rate_pct: string | null;
  meeting_rate_pct: string | null;
}

export interface CampaignAnalytics {
  funnel: FunnelMetrics;
  channel_breakdown: ChannelPerformanceRow[];
  pitch_performance: PitchPerformanceRow[];
}

export interface OverallAnalytics {
  funnel: FunnelMetrics;
  channel_performance: ChannelPerformanceRow[];
  pitch_performance: PitchPerformanceRow[];
}

export interface CampaignRow {
  id: string;
  name: string;
  status: CampaignStatus;
  created_at: string;
  total_prospects: number;
  contacted: number;
  replied: number;
  meetings: number;
  reply_rate_pct: string | null;
  meeting_rate_pct: string | null;
}

export interface Contact {
  id: string;
  prospect_id?: string;
  full_name: string;
  title: string | null;
  email: string | null;
  linkedin_urn: string | null;
  whatsapp_number?: string | null;
  is_decision_maker?: boolean;
}

export interface Prospect {
  id: string;
  campaign_id: string;
  company_name: string;
  company_domain: string | null;
  company_size: string | null;
  industry: string | null;
  country: string | null;
  status: ProspectStatus;
  pitch_type: PitchType | null;
  pitch_scores: Record<string, number> | null;
  enrichment_data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  contacts?: Contact[];
  latest_message?: {
    id: string;
    channel: Channel;
    status: string;
    sent_at: string | null;
  } | null;
}

export interface Message {
  id: string;
  channel: Channel;
  direction: 'outbound' | 'inbound';
  subject: string | null;
  body: string;
  status: string;
  pitch_type: PitchType | null;
  sequence_step: number | null;
  sent_at: string | null;
  delivered_at: string | null;
  opened_at: string | null;
  replied_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export interface ApiResponseBody<T> {
  data: T;
  pagination?: Pagination;
  error?: { code: string; message: string; details?: unknown };
}

export interface WsEvent {
  type:
    | 'CAMPAIGN_STARTED'
    | 'PROSPECT_CONTACTED'
    | 'REPLY_RECEIVED'
    | 'MEETING_BOOKED'
    | 'MESSAGE_OPENED'
    | 'RATE_LIMIT_HIT'
    | 'COMPLIANCE_BLOCK'
    | 'HELLO'
    | 'SUBSCRIBED'
    | 'pong';
  campaign_id?: string;
  timestamp?: string;
  [key: string]: unknown;
}
