/**
 * Sparkline — minimal inline chart for StatCards.
 *
 * Pure SVG, no dependency on Recharts for this one (Recharts is way too
 * heavy for a 60×20 chart). Draws a smoothed polyline + filled area under
 * the curve, themed via the `tone` prop.
 */
import * as React from 'react';

import { cn } from '../../lib/cn';

type Tone = 'primary' | 'emerald' | 'violet' | 'amber' | 'sky';

const TONE_STROKE: Record<Tone, string> = {
  primary: 'hsl(var(--primary))',
  emerald: '#10b981',
  violet: '#8b5cf6',
  amber: '#f59e0b',
  sky: '#0ea5e9',
};

interface SparklineProps {
  data: number[];
  tone?: Tone;
  width?: number;
  height?: number;
  className?: string;
  strokeWidth?: number;
}

export function Sparkline({
  data,
  tone = 'primary',
  width = 96,
  height = 32,
  className,
  strokeWidth = 1.75,
}: SparklineProps): React.ReactElement {
  if (data.length < 2) {
    // Fall back to a flat line if there isn't enough data.
    return (
      <svg
        width={width}
        height={height}
        className={cn('overflow-visible', className)}
      >
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="hsl(var(--muted-foreground))"
          strokeOpacity={0.3}
          strokeWidth={strokeWidth}
          strokeDasharray="3 3"
        />
      </svg>
    );
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);

  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * (height - strokeWidth * 2) - strokeWidth;
    return [x, y] as const;
  });

  // Smooth the line via Catmull-Rom → cubic bezier.
  const path = points.reduce((acc, [x, y], i) => {
    if (i === 0) return `M ${x} ${y}`;
    const [px, py] = points[i - 1];
    const cx = (px + x) / 2;
    return `${acc} Q ${px} ${py} ${cx} ${(py + y) / 2} T ${x} ${y}`;
  }, '');

  const areaPath = `${path} L ${width} ${height} L 0 ${height} Z`;
  const stroke = TONE_STROKE[tone];
  const gradientId = `sparkline-${tone}-${React.useId().replace(/:/g, '')}`;

  return (
    <svg
      width={width}
      height={height}
      className={cn('overflow-visible', className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Highlight the last point */}
      <circle cx={points[points.length - 1][0]} cy={points[points.length - 1][1]} r={2.5} fill={stroke} />
    </svg>
  );
}
