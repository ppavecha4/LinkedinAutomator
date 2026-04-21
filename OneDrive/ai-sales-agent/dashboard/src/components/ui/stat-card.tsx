/**
 * StatCard — bento-style KPI tile used in page hero sections.
 *
 * Composition:
 *   - Icon chip in the top-left (tinted by `tone`)
 *   - Eyebrow label
 *   - Huge animated number
 *   - Optional delta (arrow + colour by sign)
 *   - Glass background + spotlight hover
 */
import { ArrowDownRight, ArrowUpRight, type LucideIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '../../lib/cn';
import { AnimatedNumber } from './animated-number';

type Tone = 'primary' | 'emerald' | 'violet' | 'amber' | 'sky';

const TONE_STYLES: Record<Tone, { bg: string; text: string; glow: string }> = {
  primary: {
    bg: 'bg-primary/15',
    text: 'text-primary',
    glow: 'shadow-primary/20',
  },
  emerald: {
    bg: 'bg-emerald-500/15',
    text: 'text-emerald-500 dark:text-emerald-400',
    glow: 'shadow-emerald-500/20',
  },
  violet: {
    bg: 'bg-violet-500/15',
    text: 'text-violet-500 dark:text-violet-400',
    glow: 'shadow-violet-500/20',
  },
  amber: {
    bg: 'bg-amber-500/15',
    text: 'text-amber-600 dark:text-amber-400',
    glow: 'shadow-amber-500/20',
  },
  sky: {
    bg: 'bg-sky-500/15',
    text: 'text-sky-500 dark:text-sky-400',
    glow: 'shadow-sky-500/20',
  },
};

export interface StatCardProps {
  label: string;
  value: number;
  tone?: Tone;
  icon?: LucideIcon;
  format?: (n: number) => string;
  /** Percentage delta vs previous period. Positive = good, negative = bad. */
  delta?: number;
  deltaLabel?: string;
  className?: string;
}

export function StatCard({
  label,
  value,
  tone = 'primary',
  icon: Icon,
  format,
  delta,
  deltaLabel,
  className,
}: StatCardProps): React.ReactElement {
  const t = TONE_STYLES[tone];
  const deltaPositive = typeof delta === 'number' && delta >= 0;

  return (
    <div
      onMouseMove={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        const rect = el.getBoundingClientRect();
        el.style.setProperty('--spotlight-x', `${e.clientX - rect.left}px`);
        el.style.setProperty('--spotlight-y', `${e.clientY - rect.top}px`);
      }}
      className={cn(
        'spotlight glass rounded-2xl p-5 transition-all',
        'hover:shadow-xl',
        t.glow,
        className,
      )}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        {Icon && (
          <div
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-xl',
              t.bg,
              t.text,
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
        )}
      </div>
      <div className="flex items-baseline gap-2">
        <div className="text-3xl font-bold tracking-tight text-foreground">
          <AnimatedNumber value={value} format={format} />
        </div>
        {typeof delta === 'number' && (
          <div
            className={cn(
              'flex items-center gap-0.5 text-xs font-medium',
              deltaPositive
                ? 'text-emerald-500 dark:text-emerald-400'
                : 'text-rose-500 dark:text-rose-400',
            )}
          >
            {deltaPositive ? (
              <ArrowUpRight className="h-3 w-3" />
            ) : (
              <ArrowDownRight className="h-3 w-3" />
            )}
            {Math.abs(delta).toFixed(1)}%
          </div>
        )}
      </div>
      {deltaLabel && (
        <div className="mt-1 text-xs text-muted-foreground">{deltaLabel}</div>
      )}
    </div>
  );
}
