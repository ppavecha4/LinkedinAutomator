/**
 * StatusBadge — campaign status pill (ACTIVE=green / PAUSED=amber / DRAFT=gray / etc.).
 */

import clsx from 'clsx';

import type { CampaignStatus, ProspectStatus } from '../lib/types';

type AnyStatus = CampaignStatus | ProspectStatus | string;

const STYLES: Record<string, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-800',
  PAUSED: 'bg-amber-100 text-amber-800',
  DRAFT: 'bg-slate-100 text-slate-700',
  COMPLETED: 'bg-blue-100 text-blue-800',
  ARCHIVED: 'bg-slate-200 text-slate-600',
  DISCOVERED: 'bg-slate-100 text-slate-700',
  ENRICHED: 'bg-indigo-100 text-indigo-700',
  CONTACTED: 'bg-blue-100 text-blue-800',
  REPLIED: 'bg-emerald-100 text-emerald-800',
  MEETING_BOOKED: 'bg-violet-100 text-violet-800',
  UNSUBSCRIBED: 'bg-rose-100 text-rose-700',
  DISQUALIFIED: 'bg-slate-200 text-slate-500',
};

export default function StatusBadge({ status }: { status: AnyStatus }) {
  const cls = STYLES[status] ?? 'bg-slate-100 text-slate-700';
  return (
    <span
      className={clsx(
        'inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium',
        cls,
      )}
    >
      {status.replace('_', ' ')}
    </span>
  );
}
