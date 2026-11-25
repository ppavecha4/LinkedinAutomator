/**
 * Progress — linear bar + circular ring variants.
 *
 * Linear: Radix progress with gradient fill.
 * Ring:   Pure SVG, animated via stroke-dashoffset.
 */
import * as ProgressPrimitive from '@radix-ui/react-progress';
import * as React from 'react';

import { cn } from '../../lib/cn';

/* ── Linear ────────────────────────────────────────────────────── */
export const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn(
      'relative h-2 w-full overflow-hidden rounded-full bg-muted',
      className,
    )}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className="h-full w-full flex-1 bg-brand-gradient transition-transform duration-500"
      style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;

/* ── Ring ──────────────────────────────────────────────────────── */
interface ProgressRingProps {
  value: number; // 0-100
  size?: number;
  strokeWidth?: number;
  className?: string;
  children?: React.ReactNode;
  tone?: 'primary' | 'emerald' | 'violet' | 'amber' | 'sky';
}

const RING_TONES: Record<NonNullable<ProgressRingProps['tone']>, string> = {
  primary: 'stroke-primary',
  emerald: 'stroke-emerald-500',
  violet: 'stroke-violet-500',
  amber: 'stroke-amber-500',
  sky: 'stroke-sky-500',
};

export function ProgressRing({
  value,
  size = 56,
  strokeWidth = 5,
  className,
  children,
  tone = 'primary',
}: ProgressRingProps): React.ReactElement {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const clamped = Math.max(0, Math.min(100, value));
  const dashoffset = circumference - (clamped / 100) * circumference;

  return (
    <div
      className={cn('relative inline-flex items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className="stroke-muted"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashoffset}
          className={cn(
            RING_TONES[tone],
            'transition-[stroke-dashoffset] duration-700 ease-out',
          )}
        />
      </svg>
      {children && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold tabular-nums">
          {children}
        </div>
      )}
    </div>
  );
}
