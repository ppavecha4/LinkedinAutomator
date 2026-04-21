/**
 * PitchBadge — coloured pill for a PitchType value.
 *
 *   AI_AGENTS    → blue
 *   RPA_WORKFLOW → green
 *   CONSULTING   → amber
 */

import clsx from 'clsx';

import type { PitchType } from '../../lib/types';

interface Props {
  pitch: PitchType | null | undefined;
  className?: string;
}

const LABELS: Record<PitchType, string> = {
  ai_agents: 'AI Agents',
  rpa_workflow: 'RPA / Workflow',
  consulting: 'Consulting',
};

const STYLES: Record<PitchType, string> = {
  ai_agents: 'bg-blue-50 text-blue-700 border-blue-200',
  rpa_workflow: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  consulting: 'bg-amber-50 text-amber-700 border-amber-200',
};

export default function PitchBadge({ pitch, className }: Props) {
  if (!pitch) {
    return (
      <span className={clsx('inline-flex rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs font-medium text-slate-500', className)}>
        —
      </span>
    );
  }
  return (
    <span
      className={clsx(
        'inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium',
        STYLES[pitch],
        className,
      )}
    >
      {LABELS[pitch]}
    </span>
  );
}
