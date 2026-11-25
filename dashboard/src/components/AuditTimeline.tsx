/**
 * AuditTimeline — vertical timeline of campaign change history.
 *
 * Reads `GET /api/campaigns/:id/audit-log` (newest-first), renders each
 * row as a single line:
 *
 *     ●  4 minutes ago — updated tone (consultative → direct)
 *     ●  6 minutes ago — cloned to "Copy of …"
 *     ●  10 minutes ago — created
 *
 * Lives on the right side of the edit page. Auto-refreshes every 30s
 * via the hook so concurrent edits surface without a manual reload.
 */

import {
  Archive,
  CheckCircle2,
  Copy,
  History,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  type LucideIcon,
} from 'lucide-react';
import * as React from 'react';

import { useCampaignAuditLog, type AuditLogEntry } from '../hooks/useCampaigns';
import { cn } from '../lib/cn';
import { formatRelative } from '../lib/format';
import { Skeleton } from './ui/skeleton';

interface ActionMeta {
  label: string;
  icon: LucideIcon;
  tone: string; // tailwind colour for the dot
}

const ACTION_META: Record<string, ActionMeta> = {
  created: {
    label: 'Created',
    icon: Plus,
    tone: 'bg-emerald-500',
  },
  updated: {
    label: 'Edited',
    icon: Pencil,
    tone: 'bg-primary',
  },
  launched: {
    label: 'Launched',
    icon: Rocket,
    tone: 'bg-violet-500',
  },
  paused: {
    label: 'Paused',
    icon: Pause,
    tone: 'bg-amber-500',
  },
  resumed: {
    label: 'Resumed',
    icon: Play,
    tone: 'bg-emerald-500',
  },
  archived: {
    label: 'Archived',
    icon: Archive,
    tone: 'bg-rose-500',
  },
  unarchived: {
    label: 'Unarchived',
    icon: RefreshCw,
    tone: 'bg-emerald-500',
  },
  cloned: {
    label: 'Cloned',
    icon: Copy,
    tone: 'bg-sky-500',
  },
  completed: {
    label: 'Completed',
    icon: CheckCircle2,
    tone: 'bg-emerald-600',
  },
};

const FALLBACK_META: ActionMeta = {
  label: 'Status changed',
  icon: History,
  tone: 'bg-muted-foreground',
};

/** Convert one audit entry's `changes` object to a human-readable string. */
function describeChanges(entry: AuditLogEntry): string {
  const c = entry.changes || {};
  // Status-only transitions surface their before→after pair.
  if (c.status && typeof c.status === 'object') {
    const s = c.status as { before?: string; after?: string };
    if (s.before && s.after) return `${s.before} → ${s.after}`;
  }
  // Notes from cloned / launched / system actions.
  if (typeof c.note === 'string' && c.note) return c.note;

  // Edit actions: list the changed fields.
  const fieldNames = Object.keys(c).filter(
    (k) => !['note', 'cloned_from', 'new_campaign_id'].includes(k),
  );
  if (fieldNames.length === 0) return '';
  if (fieldNames.length <= 3) {
    return fieldNames
      .map((k) => {
        const change = c[k] as { before?: unknown; after?: unknown };
        if (
          change &&
          typeof change === 'object' &&
          'before' in change &&
          'after' in change
        ) {
          // Inline the diff for short scalar values.
          const b = String(change.before ?? '');
          const a = String(change.after ?? '');
          if (b.length + a.length < 60) return `${k}: ${b} → ${a}`;
        }
        return k;
      })
      .join(', ');
  }
  return `${fieldNames.length} fields changed`;
}

interface AuditTimelineProps {
  campaignId: string;
  className?: string;
}

export function AuditTimeline({
  campaignId,
  className,
}: AuditTimelineProps): React.ReactElement {
  const { data, isLoading } = useCampaignAuditLog(campaignId);

  return (
    <aside className={cn('glass rounded-2xl p-5', className)}>
      <div className="flex items-center gap-2 mb-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <History className="h-4 w-4" />
        </div>
        <div>
          <div className="text-sm font-semibold">Change history</div>
          <div className="text-[11px] text-muted-foreground">
            Auto-refreshes every 30s
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : !data || data.length === 0 ? (
        <div className="text-xs text-muted-foreground py-6 text-center">
          No history yet — edits and status changes will appear here.
        </div>
      ) : (
        <ol className="relative border-l border-border/60 ml-3 space-y-4 max-h-[60vh] overflow-y-auto pr-2">
          {data.map((entry) => {
            const meta = ACTION_META[entry.action] ?? FALLBACK_META;
            const Icon = meta.icon;
            const detail = describeChanges(entry);
            return (
              <li key={entry.id} className="pl-5 relative">
                <span
                  className={cn(
                    '-left-[7px] top-1.5 absolute flex h-3.5 w-3.5 items-center justify-center rounded-full ring-4 ring-background',
                    meta.tone,
                  )}
                />
                <div className="flex items-start gap-2">
                  <Icon className="mt-0.5 h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium leading-tight">
                      {meta.label}
                    </div>
                    {detail && (
                      <div className="text-[11px] text-muted-foreground mt-0.5 break-words">
                        {detail}
                      </div>
                    )}
                    <div className="text-[10px] text-muted-foreground/80 mt-1">
                      {formatRelative(entry.created_at)}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

