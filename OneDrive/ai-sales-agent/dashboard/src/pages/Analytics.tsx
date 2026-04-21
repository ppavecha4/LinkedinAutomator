/**
 * Analytics page — themed Recharts + hero KPI strip + glass panels.
 *
 * Polls the API every 60s via React Query. Every panel gracefully
 * handles empty-state (before any campaign has real data).
 */

import {
  BarChart3,
  CalendarCheck,
  LineChart as LineChartIcon,
  Mail,
  MessageSquare,
  Target,
  TrendingUp,
  Users,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import FunnelChart from '../components/FunnelChart';
import StatusBadge from '../components/StatusBadge';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import {
  useCampaignRows,
  useChannelPerformance,
  useOverallFunnel,
  usePitchPerformance,
} from '../hooks/useAnalytics';
import { formatNumber, formatPercent, num } from '../lib/format';

const PITCH_LABELS: Record<string, string> = {
  ai_agents: 'AI Agents',
  rpa_workflow: 'RPA / Workflow',
  consulting: 'Consulting',
};

/**
 * Recharts tooltip that reads our design tokens — so the popover matches
 * the glass panels instead of the default white box.
 *
 * Typed as `Record<string, unknown>` because Recharts' Tooltip passes a
 * very wide prop type via `content={fn}` that varies by chart type; we
 * only destructure the 3 fields we actually use.
 */
function ChartTooltip(props: Record<string, unknown> & { format?: (v: number) => string }) {
  const active = props.active as boolean | undefined;
  const payload = props.payload as
    | Array<{ dataKey?: string | number; name?: string; value?: number; color?: string }>
    | undefined;
  const label = props.label as string | undefined;
  const format = props.format;
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-strong rounded-xl px-3 py-2 shadow-xl text-xs">
      {label && <div className="font-semibold mb-1">{label}</div>}
      <div className="space-y-0.5">
        {payload.map((p, i) => (
          <div key={String(p.dataKey ?? i)} className="flex items-center gap-2">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: p.color ?? 'currentColor' }}
            />
            <span className="text-muted-foreground">{p.name}:</span>
            <span className="font-medium text-foreground">
              {format && typeof p.value === 'number' ? format(p.value) : p.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Analytics() {
  const funnel = useOverallFunnel();
  const pitch = usePitchPerformance();
  const channel = useChannelPerformance();
  const rows = useCampaignRows();

  const pitchData = (pitch.data ?? []).map((row) => ({
    label: PITCH_LABELS[row.pitch_type] ?? row.pitch_type,
    reply: num(row.reply_rate_pct),
    meeting: num(row.meeting_rate_pct),
  }));
  const channelData = (channel.data ?? []).map((row) => ({
    label: row.channel,
    sent: num(row.sent),
    delivered: num(row.delivered),
    replied: num(row.replied),
  }));

  // Hero KPI aggregates read off the funnel response — the panel below
  // already renders the same numbers as bars, these are the big headline
  // tiles above it.
  const f = (funnel.data?.funnel ?? {}) as Record<string, number | undefined>;
  const heroStats = {
    discovered: num(f.discovered),
    contacted: num(f.contacted),
    replied: num(f.replied),
    meetings: num(f.meeting_booked),
  };

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Insights"
        title="Analytics"
        description="Full-funnel metrics across every campaign. Polled every 60 seconds, rounded to whole numbers."
        icon={BarChart3}
      />

      {/* ═══ Hero KPI strip ═══════════════════════════════════════ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Prospects discovered"
          value={heroStats.discovered}
          icon={Users}
          tone="primary"
        />
        <StatCard
          label="Contacted"
          value={heroStats.contacted}
          icon={Mail}
          tone="sky"
        />
        <StatCard
          label="Replies"
          value={heroStats.replied}
          icon={MessageSquare}
          tone="emerald"
        />
        <StatCard
          label="Meetings booked"
          value={heroStats.meetings}
          icon={CalendarCheck}
          tone="violet"
        />
      </div>

      {/* ═══ Funnel ═════════════════════════════════════════════ */}
      <section className="glass rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <TrendingUp className="h-4 w-4" />
          </div>
          <h2 className="text-base font-semibold">Overall funnel</h2>
        </div>
        <FunnelChart metrics={funnel.data?.funnel} />
      </section>

      {/* ═══ Pitch + Channel row ════════════════════════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="glass rounded-2xl p-6">
          <div className="flex items-center gap-2 mb-1">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/15 text-violet-500">
              <Target className="h-4 w-4" />
            </div>
            <h2 className="text-base font-semibold">Pitch performance</h2>
          </div>
          <p className="text-xs text-muted-foreground mb-4 ml-10">
            Which pitch angle converts best (higher is better).
          </p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={pitchData}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickLine={false}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `${v}%`}
                  domain={[0, 'auto']}
                />
                <Tooltip
                  content={(props) => (
                    <ChartTooltip
                      {...props}
                      format={(v: number) => formatPercent(v)}
                    />
                  )}
                  cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                  iconType="circle"
                />
                <Bar
                  dataKey="reply"
                  name="Reply rate"
                  fill="hsl(var(--primary))"
                  radius={[6, 6, 0, 0]}
                />
                <Bar
                  dataKey="meeting"
                  name="Meeting rate"
                  fill="#10b981"
                  radius={[6, 6, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {pitchData.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-2">
              No pitch data yet.
            </div>
          )}
        </section>

        <section className="glass rounded-2xl p-6">
          <div className="flex items-center gap-2 mb-1">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/15 text-sky-500">
              <LineChartIcon className="h-4 w-4" />
            </div>
            <h2 className="text-base font-semibold">Channel performance</h2>
          </div>
          <p className="text-xs text-muted-foreground mb-4 ml-10">
            Sent → delivered → replied per channel.
          </p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={channelData}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickLine={false}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  content={(props) => (
                    <ChartTooltip
                      {...props}
                      format={(v: number) => formatNumber(v)}
                    />
                  )}
                  cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                  iconType="circle"
                />
                <Bar
                  dataKey="sent"
                  name="Sent"
                  fill="hsl(var(--muted-foreground))"
                  radius={[6, 6, 0, 0]}
                />
                <Bar
                  dataKey="delivered"
                  name="Delivered"
                  fill="hsl(var(--primary))"
                  radius={[6, 6, 0, 0]}
                />
                <Bar
                  dataKey="replied"
                  name="Replied"
                  fill="#10b981"
                  radius={[6, 6, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {channelData.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-2">
              No channel data yet.
            </div>
          )}
        </section>
      </div>

      {/* ═══ Campaign comparison table ═════════════════════════ */}
      <section className="glass rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border/60 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
            <BarChart3 className="h-4 w-4" />
          </div>
          <h2 className="text-base font-semibold">Campaign comparison</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-6 py-3 text-left font-semibold">Name</th>
                <th className="px-4 py-3 text-left font-semibold">Status</th>
                <th className="px-4 py-3 text-right font-semibold">Prospects</th>
                <th className="px-4 py-3 text-right font-semibold">Reply %</th>
                <th className="px-4 py-3 text-right font-semibold">Meeting %</th>
                <th className="px-6 py-3 text-right font-semibold">Launched</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {(rows.data ?? []).map((row) => (
                <tr key={row.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-6 py-3 font-medium text-foreground">{row.name}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatNumber(row.total_prospects)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatPercent(row.reply_rate_pct)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatPercent(row.meeting_rate_pct)}
                  </td>
                  <td className="px-6 py-3 text-right text-xs text-muted-foreground">
                    {new Date(row.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
              {(rows.data ?? []).length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-12 text-center text-xs text-muted-foreground"
                  >
                    No campaigns yet — launch one from the Campaigns page.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ═══ Recent meetings placeholder ═══════════════════════ */}
      <section className="glass rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-500">
            <CalendarCheck className="h-4 w-4" />
          </div>
          <h2 className="text-base font-semibold">Recent meetings</h2>
        </div>
        <p className="text-xs text-muted-foreground mb-3 ml-10">
          Meetings booked across all campaigns.
        </p>
        <div className="text-xs text-muted-foreground py-8 border border-dashed border-border/80 rounded-xl text-center bg-grid-subtle">
          No <code className="text-foreground/70">/api/meetings</code> endpoint
          yet — this feed populates once the meetings-list endpoint is added.
        </div>
      </section>
    </div>
  );
}
