/**
 * Overview — the new home page.
 *
 * Hero KPI strip (4 StatCards, real totals only) + Tabs for
 *   Snapshot · Live feed · Top performers
 *
 * Design choices (senior UI/UX rationale):
 *   - One hero area, one tab strip — no side panel, no visual clutter
 *   - No trend lines or growth figures until the API returns real history
 *   - Live feed tab shows the WebSocket stream as a timeline
 *   - Top performers tab shows ranked campaign table with progress rings
 *   - Skeleton loaders instead of shimmer blocks on async boundaries
 *   - EmptyState component for the zero-data path
 */

import { motion } from 'framer-motion';
import {
  Activity,
  ArrowRight,
  CalendarCheck,
  Inbox,
  Mail,
  MessageSquare,
  PlusCircle,
  Radio,
  Sparkles,
  Target,
  TrendingUp,
  Users,
} from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router-dom';

import { label } from '../lib/labels';
import { t, tn } from '../i18n';
import { LifecycleFunnel } from '../components/LifecycleFunnel';
import { SetupBanner } from '../components/SetupBanner';
import StatusBadge from '../components/StatusBadge';
import { PageHeader } from '../components/ui/page-header';
import { ProgressRing } from '../components/ui/progress';
import { EmptyState } from '../components/ui/empty-state';
import { Skeleton } from '../components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { AnimatedNumber } from '../components/ui/animated-number';
import { useCampaigns } from '../hooks/useCampaigns';
import { useWebSocket } from '../hooks/useWebSocket';
import { cn } from '../lib/cn';
import { formatNumber } from '../lib/format';
import type { Campaign, WsEvent } from '../lib/types';

/* ────────────────────────────────────────────────────────────────
 *  The hero tiles.
 * ──────────────────────────────────────────────────────────────── */
interface HeroStatProps {
  label: string;
  value: number;
  tone: 'primary' | 'emerald' | 'violet' | 'sky';
  icon: React.ComponentType<{ className?: string }>;
}

const TONE_STYLE = {
  primary: { chip: 'bg-primary/15 text-primary', glow: 'shadow-primary/20' },
  emerald: {
    chip: 'bg-emerald-500/15 text-emerald-500 dark:text-emerald-400',
    glow: 'shadow-emerald-500/20',
  },
  violet: {
    chip: 'bg-violet-500/15 text-violet-500 dark:text-violet-400',
    glow: 'shadow-violet-500/20',
  },
  sky: {
    chip: 'bg-sky-500/15 text-sky-500 dark:text-sky-400',
    glow: 'shadow-sky-500/20',
  },
} as const;

function HeroStat({ label, value, tone, icon: Icon }: HeroStatProps) {
  const item = TONE_STYLE[tone];
  return (
    <div
      onMouseMove={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        const r = el.getBoundingClientRect();
        el.style.setProperty('--spotlight-x', `${e.clientX - r.left}px`);
        el.style.setProperty('--spotlight-y', `${e.clientY - r.top}px`);
      }}
      className={cn(
        'spotlight glass rounded-2xl p-5 transition-all hover:shadow-xl',
        item.glow,
      )}
    >
      <div className="mb-4">
        <div
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-xl',
            item.chip,
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-3xl font-bold tracking-tight text-foreground tabular-nums">
        <AnimatedNumber value={value} />
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
 *  Top performers table row
 * ──────────────────────────────────────────────────────────────── */
function TopRow({ c }: { c: Campaign }) {
  const total = Math.max(1, c.total_prospects ?? 0);
  const bookedPct = ((c.meeting_booked ?? 0) / total) * 100;
  const repliedPct = ((c.replied ?? 0) / total) * 100;

  return (
    <Link
      to={`/prospects?campaign=${c.id}`}
      className="group flex items-center gap-4 rounded-xl p-3 hover:bg-accent/40 transition-colors"
    >
      <ProgressRing value={bookedPct} size={52} tone="primary">
        <span className="text-[10px]">{Math.round(bookedPct)}%</span>
      </ProgressRing>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="font-medium truncate">{c.name}</div>
          <StatusBadge status={c.status} />
        </div>
        <div className="text-xs text-muted-foreground mt-0.5 truncate">
          {c.goal}
        </div>
      </div>
      <div className="hidden md:flex items-center gap-6 text-xs">
        <div className="text-end">
          <div className="text-[10px] text-muted-foreground uppercase">
            {t('Prospects')}
          </div>
          <div className="font-semibold tabular-nums">
            {formatNumber(c.total_prospects ?? 0)}
          </div>
        </div>
        <div className="text-end">
          <div className="text-[10px] text-muted-foreground uppercase">
            {t('Replied')}
          </div>
          <div className="font-semibold tabular-nums">
            {Math.round(repliedPct)}%
          </div>
        </div>
        <div className="text-end">
          <div className="text-[10px] text-muted-foreground uppercase">
            {t('Booked')}
          </div>
          <div className="font-semibold tabular-nums">
            {c.meeting_booked ?? 0}
          </div>
        </div>
      </div>
      <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors rtl:rotate-180" />
    </Link>
  );
}

/* ────────────────────────────────────────────────────────────────
 *  Page
 * ──────────────────────────────────────────────────────────────── */
export default function Overview(): React.ReactElement {
  const { data: campaigns, isLoading, refetch } = useCampaigns();
  const [feed, setFeed] = React.useState<WsEvent[]>([]);

  useWebSocket({
    onEvent: (event) => {
      if (
        event.type === 'REPLY_RECEIVED' ||
        event.type === 'MEETING_BOOKED' ||
        event.type === 'PROSPECT_CONTACTED'
      ) {
        setFeed((prev) => [event, ...prev].slice(0, 30));
      }
      if (event.type === 'CAMPAIGN_STARTED' || event.type === 'MEETING_BOOKED') {
        refetch();
      }
    },
  });

  const active = React.useMemo(
    () => (campaigns ?? []).filter((c) => c.status !== 'ARCHIVED'),
    [campaigns],
  );

  const totals = React.useMemo(
    () =>
      active.reduce(
        (acc, c) => ({
          prospects: acc.prospects + (c.total_prospects ?? 0),
          contacted: acc.contacted + (c.contacted ?? 0),
          replied: acc.replied + (c.replied ?? 0),
          meetings: acc.meetings + (c.meeting_booked ?? 0),
        }),
        { prospects: 0, contacted: 0, replied: 0, meetings: 0 },
      ),
    [active],
  );

  // Ranked for "Top performers" — by meetings booked desc.
  const ranked = React.useMemo(
    () =>
      [...active].sort(
        (a, b) => (b.meeting_booked ?? 0) - (a.meeting_booked ?? 0),
      ),
    [active],
  );

  return (
    <div>
      <PageHeader
        eyebrow={t('Live · auto-refresh 15s')}
        title={t('Overview')}
        description={t('Your autonomous outbound at a glance. KPIs, activity, and top performers across every campaign.')}
        icon={Sparkles}
        actions={
          <Link to="/campaigns/new" className="btn-primary">
            <PlusCircle className="h-4 w-4" />
            {t('New campaign')}
          </Link>
        }
      />

      <SetupBanner />

      {/* ═══ Hero KPI strip ═══════════════════════════════════════ */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <HeroStat
            label={t('Total prospects')}
            value={totals.prospects}
            tone="primary"
            icon={Users}
          />
          <HeroStat
            label={t('Contacted')}
            value={totals.contacted}
            tone="sky"
            icon={Mail}
          />
          <HeroStat
            label={t('Replies')}
            value={totals.replied}
            tone="emerald"
            icon={MessageSquare}
          />
          <HeroStat
            label={t('Meetings booked')}
            value={totals.meetings}
            tone="violet"
            icon={CalendarCheck}
          />
        </div>
      )}

      {/* ═══ Lifecycle funnel ═════════════════════════════════════ */}
      <div className="mb-8">
        <LifecycleFunnel />
      </div>

      {/* ═══ Tabs: Snapshot | Live feed | Top performers ═════════ */}
      <Tabs defaultValue="snapshot" className="space-y-6">
        <TabsList>
          <TabsTrigger value="snapshot">
            <TrendingUp className="h-3.5 w-3.5" />
            {t('Snapshot')}
          </TabsTrigger>
          <TabsTrigger value="feed">
            <Radio className="h-3.5 w-3.5" />
            {t('Live feed')}
            {feed.length > 0 && (
              <span className="ms-1 rounded-full bg-emerald-500/20 text-emerald-500 px-1.5 text-[10px] font-semibold">
                {feed.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="performers">
            <Target className="h-3.5 w-3.5" />
            {t('Top performers')}
          </TabsTrigger>
        </TabsList>

        {/* ── Snapshot ─ */}
        <TabsContent value="snapshot" className="mt-6">
          {isLoading ? (
            <Skeleton className="h-64 rounded-2xl" />
          ) : active.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title={t('No campaigns yet')}
              description={t('Your autonomous outbound pipeline will populate here once you launch your first campaign.')}
              action={
                <Link to="/campaigns/new" className="btn-primary">
                  <PlusCircle className="h-4 w-4" />
                  {t('Create your first campaign')}
                </Link>
              }
            />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Active campaigns at a glance */}
              <div className="lg:col-span-2 glass rounded-2xl p-6">
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h3 className="text-base font-semibold">{t('In flight')}</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {tn(active.length, '{count} campaign running · click to open the pipeline', '{count} campaigns running · click to open the pipeline')}
                    </p>
                  </div>
                  <Link
                    to="/campaigns"
                    className="text-xs text-primary hover:underline"
                  >
                    {t('View all →')}
                  </Link>
                </div>
                <div className="space-y-1 -mx-3">
                  {ranked.slice(0, 5).map((c) => (
                    <TopRow key={c.id} c={c} />
                  ))}
                </div>
              </div>

              {/* Activity mini-feed (short version, full version lives in the Live feed tab) */}
              <aside className="glass rounded-2xl p-6">
                <div className="flex items-center gap-2 mb-4">
                  <div className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15">
                    <Activity className="h-4 w-4 text-emerald-500" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{t('Latest')}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {t('Real-time WebSocket')}
                    </div>
                  </div>
                </div>
                {feed.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-6">
                    {t('Waiting for live events…')}
                  </div>
                ) : (
                  <ul className="space-y-2.5 text-xs">
                    {feed.slice(0, 6).map((event, idx) => (
                      <motion.li
                        key={idx}
                        initial={{ opacity: 0, x: 6 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="flex items-start gap-2"
                      >
                        <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary ring-2 ring-primary/20 shrink-0" />
                        <div className="min-w-0">
                          <div className="font-medium text-foreground">
                            {label(event.type)}
                          </div>
                          <div className="text-muted-foreground truncate">
                            {t('just now')}
                          </div>
                        </div>
                      </motion.li>
                    ))}
                  </ul>
                )}
              </aside>
            </div>
          )}
        </TabsContent>

        {/* ── Live feed (full timeline) ─ */}
        <TabsContent value="feed" className="mt-6">
          <div className="glass rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-5">
              <div className="relative flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/15">
                <Radio className="h-4 w-4 text-emerald-500" />
                <span className="absolute inset-0 rounded-lg ring-2 ring-emerald-500/40 animate-ping" />
              </div>
              <div>
                <h3 className="text-base font-semibold">{t('Live feed')}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('Every reply, meeting, and contacted prospect as it happens')}
                </p>
              </div>
            </div>
            {feed.length === 0 ? (
              <EmptyState
                icon={Radio}
                title={t('No live events yet')}
                description={t('Replies, meetings, and contact events will stream here the moment the orchestrator emits them.')}
              />
            ) : (
              <ol className="relative border-s border-border/60 ms-4 space-y-6">
                {feed.map((event, idx) => (
                  <motion.li
                    key={idx}
                    initial={{ opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.3, delay: idx * 0.02 }}
                    className="ps-6"
                  >
                    <span className="absolute -start-[7px] mt-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary ring-4 ring-background" />
                    <div className="text-sm font-semibold">
                      {label(event.type)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 font-mono truncate">
                      {JSON.stringify(event)}
                    </div>
                  </motion.li>
                ))}
              </ol>
            )}
          </div>
        </TabsContent>

        {/* ── Top performers ─ */}
        <TabsContent value="performers" className="mt-6">
          {active.length === 0 ? (
            <EmptyState
              icon={Target}
              title={t('No ranked campaigns yet')}
              description={t('Launch a campaign to start seeing performance rankings here.')}
            />
          ) : (
            <div className="glass rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
                  <Target className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-base font-semibold">
                    {t('Ranked by meetings booked')}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('Conversion ring = bookings / discovered')}
                  </p>
                </div>
              </div>
              <div className="space-y-1 -mx-3">
                {ranked.map((c) => (
                  <Tooltip key={c.id}>
                    <TooltipTrigger asChild>
                      <div>
                        <TopRow c={c} />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>{t('Click to open pipeline')}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
