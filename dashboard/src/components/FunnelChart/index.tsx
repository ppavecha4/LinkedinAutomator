/**
 * FunnelChart — horizontal Recharts bar chart with conversion % between stages.
 *
 * Used on the Analytics page and the campaign detail drawer. Input is the
 * FunnelMetrics shape (six numeric stages). Handles zero totals gracefully.
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatNumber, num } from '../../lib/format';
import type { FunnelMetrics } from '../../lib/types';

interface Props {
  metrics: FunnelMetrics | undefined;
}

const STAGE_ORDER: Array<{ key: keyof FunnelMetrics; label: string }> = [
  { key: 'discovered', label: 'Discovered' },
  { key: 'enriched', label: 'Enriched' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'opened', label: 'Opened' },
  { key: 'replied', label: 'Replied' },
  { key: 'meeting_booked', label: 'Meeting Booked' },
];

export default function FunnelChart({ metrics }: Props) {
  const safe: FunnelMetrics = {
    discovered: num(metrics?.discovered),
    enriched: num(metrics?.enriched),
    contacted: num(metrics?.contacted),
    opened: num(metrics?.opened),
    replied: num(metrics?.replied),
    meeting_booked: num(metrics?.meeting_booked),
  };

  const data = STAGE_ORDER.map((stage, idx) => {
    const value = safe[stage.key];
    const prev = idx > 0 ? safe[STAGE_ORDER[idx - 1].key] : 0;
    const conversion =
      idx > 0 && prev > 0 ? Math.round((value / prev) * 100) : null;
    return {
      stage: stage.label,
      count: value,
      conversion,
    };
  });

  const allZero = data.every((d) => d.count === 0);

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ left: 50, right: 80 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis type="number" stroke="#64748b" allowDecimals={false} />
          <YAxis
            type="category"
            dataKey="stage"
            stroke="#64748b"
            width={120}
          />
          <Tooltip
            formatter={(value: number, _name, item) => {
              const conv = item?.payload?.conversion;
              if (conv != null) {
                return [`${formatNumber(value)}  (${conv}% vs prev)`, 'count'];
              }
              return [formatNumber(value), 'count'];
            }}
          />
          <Bar dataKey="count" fill="#2563eb" radius={[0, 4, 4, 0]}>
            <LabelList
              dataKey="count"
              position="right"
              formatter={(v: number) => formatNumber(v)}
              fill="#334155"
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {allZero && (
        <div className="-mt-80 h-80 flex items-center justify-center text-sm text-slate-400">
          No activity yet — launch a campaign to populate the funnel.
        </div>
      )}
    </div>
  );
}
