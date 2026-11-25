/**
 * ProspectTimeline — vertical event log per prospect.
 *
 * Renders the timeline returned by `useProspectTimeline()` (or any list
 * of `TimelineEvent`). Each verb gets a coloured dot + an icon + a
 * channel-tinted badge so an operator can scan the lifecycle at a
 * glance:
 *
 *   ● (green)  discovered                            now
 *   ● (sky)    enriched                              5s
 *   ● (sky)    [linkedin] message_drafted            5s
 *   ● (sky)    [linkedin] connection_requested  ↪ op 4m
 *   ● (emerald)[linkedin] connection_accepted   ↪ op 3h
 *   ● (sky)    [email]    message_sent              now
 *   ● (violet) [email]    message_opened        ↪ op 18m
 *   ● (rose)   [email]    message_replied       ↪ op 22m
 *
 * The `↪ op` annotation marks operator-recorded events vs automatic
 * captures from system/webhooks.
 */

import {
  Activity,
  Briefcase,
  Calendar,
  CheckCircle2,
  Eye,
  History,
  Inbox,
  Mail,
  MessageCircle,
  MessageSquare,
  PauseCircle,
  Send,
  Sparkles,
  Target,
  UserCheck,
  UserMinus,
  UserPlus,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import * as React from 'react';

import type { TimelineEvent } from '../hooks/useTimeline';
import { cn } from '../lib/cn';
import { formatRelative } from '../lib/format';
import { Skeleton } from './ui/skeleton';

interface VerbMeta {
  label: string;
  icon: LucideIcon;
  tone: string; // tailwind background colour for the dot
}

const VERB_META: Record<string, VerbMeta> = {
  discovered: { label: 'Discovered', icon: Sparkles, tone: 'bg-emerald-500' },
  enriched: { label: 'Enriched', icon: UserCheck, tone: 'bg-sky-500' },
  message_drafted: { label: 'Draft prepared', icon: MessageSquare, tone: 'bg-sky-500' },
  message_queued: { label: 'Queued for send', icon: PauseCircle, tone: 'bg-sky-500' },
  message_sent: { label: 'Sent', icon: Send, tone: 'bg-sky-500' },
  message_delivered: { label: 'Delivered', icon: CheckCircle2, tone: 'bg-sky-500' },
  message_opened: { label: 'Opened / seen', icon: Eye, tone: 'bg-violet-500' },
  message_clicked: { label: 'Link clicked', icon: Target, tone: 'bg-violet-500' },
  message_replied: { label: 'Replied', icon: Inbox, tone: 'bg-rose-500' },
  message_bounced: { label: 'Bounced', icon: XCircle, tone: 'bg-amber-500' },
  message_failed: { label: 'Send failed', icon: XCircle, tone: 'bg-rose-500' },
  connection_requested: { label: 'Connection request sent', icon: UserPlus, tone: 'bg-sky-500' },
  connection_accepted: { label: 'Connection accepted', icon: UserCheck, tone: 'bg-emerald-500' },
  connection_declined: { label: 'Connection declined', icon: UserMinus, tone: 'bg-rose-500' },
  meeting_booked: { label: 'Meeting booked', icon: Calendar, tone: 'bg-violet-500' },
  meeting_completed: { label: 'Meeting completed', icon: CheckCircle2, tone: 'bg-emerald-500' },
  opted_out: { label: 'Opted out', icon: UserMinus, tone: 'bg-rose-500' },
  note: { label: 'Note', icon: Activity, tone: 'bg-muted-foreground' },
};

const FALLBACK_META: VerbMeta = {
  label: 'Event',
  icon: Activity,
  tone: 'bg-muted-foreground',
};

const CHANNEL_ICON: Record<string, LucideIcon> = {
  email: Mail,
  linkedin: Briefcase,
  whatsapp: MessageCircle,
};

/** Compact one-line description of the event's payload, if useful. */
function describePayload(p: Record<string, unknown>): string {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.note === 'string' && p.note) return p.note;
  if (typeof p.reason === 'string' && p.reason) return p.reason;
  if (typeof p.via === 'string') return `via ${p.via}`;
  if (typeof p.to === 'string') return `to ${p.to}`;
  if (
    typeof p.email_revealed === 'boolean' ||
    typeof p.linkedin_url_revealed === 'boolean'
  ) {
    const bits: string[] = [];
    if (p.linkedin_url_revealed) bits.push('linkedin');
    if (p.email_revealed) bits.push('email');
    if (bits.length) return `unlocked ${bits.join(' + ')}`;
  }
  if (typeof p.body_chars === 'number') return `${p.body_chars} chars`;
  return '';
}

interface ProspectTimelineProps {
  events?: TimelineEvent[];
  isLoading?: boolean;
  emptyState?: React.ReactNode;
  showContactColumn?: boolean; // true on campaign-level timeline
  className?: string;
}

export function ProspectTimeline({
  events,
  isLoading,
  emptyState,
  showContactColumn,
  className,
}: ProspectTimelineProps): React.ReactElement {
  if (isLoading) {
    return (
      <div className={cn('space-y-3', className)}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    );
  }

  if (!events || events.length === 0) {
    return (
      <div
        className={cn(
          'text-xs text-muted-foreground py-6 text-center',
          className,
        )}
      >
        {emptyState ?? (
          <>
            <History className="mx-auto h-5 w-5 mb-2 opacity-60" />
            No events yet — discovery, sends, opens, and replies will
            appear here.
          </>
        )}
      </div>
    );
  }

  return (
    <ol
      className={cn(
        'relative border-l border-border/60 ml-3 space-y-4',
        className,
      )}
    >
      {events.map((e) => {
        const meta = VERB_META[e.event_type] ?? FALLBACK_META;
        const Icon = meta.icon;
        const ChannelIcon = e.channel ? CHANNEL_ICON[e.channel] : null;
        const detail = describePayload(e.payload);
        const operatorTagged = e.source === 'operator' || e.source === 'manual';
        return (
          <li key={e.id} className="pl-5 relative">
            <span
              className={cn(
                '-left-[7px] top-1.5 absolute flex h-3.5 w-3.5 items-center justify-center rounded-full ring-4 ring-background',
                meta.tone,
              )}
            />
            <div className="flex items-start gap-2">
              <Icon className="mt-0.5 h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {ChannelIcon && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-muted/60 px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <ChannelIcon className="h-2.5 w-2.5" />
                      {e.channel}
                    </span>
                  )}
                  <span className="text-sm font-medium leading-tight">
                    {meta.label}
                  </span>
                  {operatorTagged && (
                    <span className="text-[10px] text-muted-foreground/80">
                      · operator
                    </span>
                  )}
                </div>
                {showContactColumn && e.contact_name && (
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {e.contact_name}
                    {e.company_name ? ` · ${e.company_name}` : ''}
                  </div>
                )}
                {detail && (
                  <div className="text-[11px] text-muted-foreground mt-0.5 break-words">
                    {detail}
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground/80 mt-1">
                  {formatRelative(e.occurred_at)}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
