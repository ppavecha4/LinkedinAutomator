/**
 * Words for the codes the server stores (statuses, roles, plans, channels, live events). The codes stay
 * as they are in the data; only what is shown changes with the screen language.
 */

import { msg, t } from '../i18n';

const LABELS: Record<string, string> = {
  // campaigns, prospects, messages, accounts
  ACTIVE: msg('Active'), PAUSED: msg('Paused'), DRAFT: msg('Draft'), COMPLETED: msg('Completed'), ARCHIVED: msg('Archived'),
  DISCOVERED: msg('Discovered'), ENRICHED: msg('Enriched'), CONTACTED: msg('Contacted'), REPLIED: msg('Replied'),
  MEETING_BOOKED: msg('Meeting booked'), UNSUBSCRIBED: msg('Unsubscribed'), DISQUALIFIED: msg('Disqualified'),
  DRAFTED: msg('Drafted'), QUEUED: msg('Queued'), SENT: msg('Sent'), OPERATOR_SENT: msg('Sent by hand'), DELIVERED: msg('Delivered'),
  OPENED: msg('Opened'), FAILED: msg('Failed'), BOUNCED: msg('Bounced'), SUPPRESSED: msg('Blocked'),
  PENDING: msg('Waiting'), APPROVED: msg('Approved'), REJECTED: msg('Rejected'), DISABLED: msg('Disabled'),
  SUSPENDED: msg('Suspended'), CANCELLED: msg('Cancelled'), VERIFIED: msg('Verified'), REVOKED: msg('Removed'), UNKNOWN: msg('Unknown'),
  // live events
  CAMPAIGN_STARTED: msg('Campaign started'), PROSPECT_CONTACTED: msg('Prospect contacted'), REPLY_RECEIVED: msg('Reply received'),
  MESSAGE_OPENED: msg('Message opened'), RATE_LIMIT_HIT: msg('Daily limit reached'), COMPLIANCE_BLOCK: msg('Blocked by a rule'),
  // channels (brand names stay as they are)
  email: msg('Email'), whatsapp: 'WhatsApp', linkedin: 'LinkedIn', voice: msg('AI phone calls'),
  // plans and roles
  free: msg('Free trial'), starter: msg('Starter'), growth: msg('Growth'), scale: msg('Scale'),
  owner: msg('owner'), admin: msg('admin'), member: msg('member'), viewer: msg('viewer'),
  // sales angles
  ai_agents: msg('AI Agents'), rpa_workflow: msg('RPA / Workflow'), consulting: msg('Consulting'),
};

export function label(code: string | null | undefined): string {
  if (!code) return '';
  const known = LABELS[code] ?? LABELS[code.toUpperCase()];
  if (known) return t(known);
  const words = code.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
