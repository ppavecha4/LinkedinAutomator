/**
 * Home page — bento hero stat grid + glass campaign cards + live activity.
 *
 * Metrics auto-refresh via React Query (15s) + WebSocket broadcasts for
 * real-time "+1 meeting" / "+1 reply" nudges.
 */

import { motion } from 'framer-motion';
import {
  Activity,
  Archive,
  CalendarCheck,
  Copy,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  PlusCircle,
  Radio,
  Sparkles,
  Target,
  TrendingUp,
  Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import StatusBadge from '../components/StatusBadge';
import { AnimatedNumber } from '../components/ui/animated-number';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import {
  useCampaigns,
  useCloneCampaign,
  useSetCampaignStatus,
} from '../hooks/useCampaigns';
import { useWebSocket } from '../hooks/useWebSocket';
import { cn } from '../lib/cn';
import { formatNumber } from '../lib/format';
import type { Campaign, WsEvent } from '../lib/types';

/* ────────────────────────────────────────────────────────────────
 *  Mini-funnel rail
 * ──────────────────────────────────────────────────────────────── */
function MiniFunnel({ c }: { c: Campaign }) {
  const total = Math.max(1, c.total_prospects ?? 0);
  const pct = (n: number | undefined) =>
    `${Math.min(100, Math.round(((n ?? 0) / total) * 100))}%`;
  const rails: { w: string; fill: string; label: string }[] = [
    { w: pct(c.total_prospects), fill: 'bg-muted-foreground/40', label: 'Discovered' },
    { w: pct(c.contacted), fill: 'bg-sky-500', label: 'Contacted' },
    { w: pct(c.replied), fill: 'bg-emerald-500', label: 'Replied' },
    { w: pct(c.meeting_booked), fill: 'bg-violet-500', label: 'Booked' },
  ];
  return (
    <div className="mt-3 space-y-1.5">
      {rails.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="w-16 text-[10px] uppercase tracking-wider text-muted-foreground">
            {r.label}
          </div>
          <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: r.w }}
              transition={{ duration: 0.8, delay: 0.1 * i, ease: [0.16, 1, 0.3, 1] }}
              className={cn('h-full rounded-full', r.fill)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
 *  Campaign card with spotlight hover
 * ──────────────────────────────────────────────────────────────── */
function CampaignCard({ campaign, index }: { campaign: Campaign; index: number }) {
  const setStatus = useSetCampaignStatus();
  const cloneCampaign = useCloneCampaign();
  const navigate = useNavigate();
  const [confirmArchive, setConfirmArchive] = useState(false);
  const canPause = campaign.status === 'ACTIVE';
  const canResume = campaign.status === 'PAUSED';

  // Action handlers — wrapped to fire toasts on success/error so the
  // operator sees feedback for every menu action.
  const handlePause = () =>
    setStatus.mutate(
      { id: campaign.id, status: 'PAUSED' },
      {
        onSuccess: () => toast.success(`Paused: ${campaign.name}`),
        onError: (e) => toast.error(`Pause failed: ${(e as Error).message}`),
      },
    );
  const handleResume = () =>
    setStatus.mutate(
      { id: campaign.id, status: 'ACTIVE' },
      {
        onSuccess: () => toast.success(`Resumed: ${campaign.name}`),
        onError: (e) => toast.error(`Resume failed: ${(e as Error).message}`),
      },
    );
  const handleClone = () =>
    cloneCampaign.mutate(campaign.id, {
      onSuccess: (newCampaign) => {
        toast.success('Campaign duplicated', {
          description: 'Renaming and sending you to the editor…',
        });
        navigate(`/campaigns/${newCampaign.id}/edit`);
      },
      onError: (e) =>
        toast.error(`Duplicate failed: ${(e as Error).message}`),
    });
  const handleArchiveConfirmed = () =>
    setStatus.mutate(
      { id: campaign.id, status: 'ARCHIVED' },
      {
        onSuccess: () => {
          toast.success(`Archived: ${campaign.name}`, {
            description:
              'It will no longer appear in the campaigns list. Reopen by changing status from the API.',
          });
          setConfirmArchive(false);
        },
        onError: (e) => toast.error(`Archive failed: ${(e as Error).message}`),
      },
    );

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.05, ease: [0.16, 1, 0.3, 1] }}
      onMouseMove={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        const rect = el.getBoundingClientRect();
        el.style.setProperty('--spotlight-x', `${e.clientX - rect.left}px`);
        el.style.setProperty('--spotlight-y', `${e.clientY - rect.top}px`);
      }}
      className="spotlight glass rounded-2xl p-5 space-y-4 hover:shadow-2xl hover:shadow-primary/10 hover:-translate-y-0.5 transition-all"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold text-foreground truncate">
            {campaign.name}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 truncate">
            {campaign.goal}
          </div>
        </div>
        <StatusBadge status={campaign.status} />
      </div>

      {/* Metric tiles */}
      <div className="grid grid-cols-4 gap-2">
        {(
          [
            { icon: Users, label: 'Prospects', v: campaign.total_prospects ?? 0 },
            { icon: Mail, label: 'Contacted', v: campaign.contacted ?? 0 },
            { icon: MessageSquare, label: 'Replies', v: campaign.replied ?? 0 },
            { icon: Target, label: 'Booked', v: campaign.meeting_booked ?? 0 },
          ] as const
        ).map((m) => {
          const Icon = m.icon;
          return (
            <div
              key={m.label}
              className="rounded-lg bg-muted/40 border border-border/40 p-2.5 text-center"
            >
              <div className="flex items-center justify-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                <Icon className="h-3 w-3" />
                {m.label}
              </div>
              <div className="mt-0.5 text-lg font-bold text-foreground">
                <AnimatedNumber value={m.v} />
              </div>
            </div>
          );
        })}
      </div>

      <MiniFunnel c={campaign} />

      {/* Pitch distribution */}
      <div className="flex h-1.5 rounded-full overflow-hidden">
        <div className="flex-1 bg-pitch-ai" title="AI Agents" />
        <div className="flex-1 bg-pitch-rpa" title="RPA / Workflow" />
        <div className="flex-1 bg-pitch-consulting" title="Consulting" />
      </div>

      <div className="flex items-center gap-2 justify-end pt-2 border-t border-border/60">
        {canPause && (
          <button
            className="btn-ghost text-xs h-7 px-3"
            onClick={handlePause}
            disabled={setStatus.isPending}
          >
            <Pause className="h-3 w-3" />
            Pause
          </button>
        )}
        {canResume && (
          <button
            className="btn-ghost text-xs h-7 px-3"
            onClick={handleResume}
            disabled={setStatus.isPending}
          >
            <Play className="h-3 w-3" />
            Resume
          </button>
        )}
        <Link
          to={`/prospects?campaign=${campaign.id}`}
          className="btn-secondary text-xs h-7 px-3"
        >
          View pipeline
        </Link>

        {/* Kebab menu — Edit / Duplicate / Archive */}
        <DropdownMenu>
          <DropdownMenuTrigger
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="More actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Manage</DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => navigate(`/campaigns/${campaign.id}/edit`)}
            >
              <Pencil className="h-4 w-4" />
              Edit campaign
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={handleClone}
              disabled={cloneCampaign.isPending}
            >
              <Copy className="h-4 w-4" />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setConfirmArchive(true)}
              className="text-destructive focus:text-destructive"
            >
              <Archive className="h-4 w-4" />
              Archive…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Archive confirmation — irreversible-ish, so always confirm */}
      <Dialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive campaign?</DialogTitle>
            <DialogDescription>
              <strong className="text-foreground">{campaign.name}</strong> will
              be removed from the campaigns list and stop processing prospects.
              You can still see its data via direct URL but it won't appear in
              the dashboard's lists or analytics by default.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 gap-2">
            <button
              className="btn-secondary text-sm h-9 px-4"
              onClick={() => setConfirmArchive(false)}
              disabled={setStatus.isPending}
            >
              Cancel
            </button>
            <button
              className="btn text-sm h-9 px-4 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleArchiveConfirmed}
              disabled={setStatus.isPending}
            >
              <Archive className="h-3.5 w-3.5" />
              {setStatus.isPending ? 'Archiving…' : 'Archive'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}

/* ────────────────────────────────────────────────────────────────
 *  Page
 * ──────────────────────────────────────────────────────────────── */
export default function ActiveCampaigns() {
  const { data: campaigns, isLoading, refetch } = useCampaigns();
  const [feed, setFeed] = useState<WsEvent[]>([]);

  useWebSocket({
    onEvent: (event) => {
      if (
        event.type === 'REPLY_RECEIVED' ||
        event.type === 'MEETING_BOOKED' ||
        event.type === 'PROSPECT_CONTACTED'
      ) {
        setFeed((prev) => [event, ...prev].slice(0, 30));
      }
      if (
        event.type === 'CAMPAIGN_STARTED' ||
        event.type === 'PROSPECT_CONTACTED' ||
        event.type === 'MEETING_BOOKED'
      ) {
        refetch();
      }
    },
  });

  const active = useMemo(
    () => (campaigns ?? []).filter((c) => c.status !== 'ARCHIVED'),
    [campaigns],
  );

  // Aggregate hero stats across all active campaigns.
  const totals = useMemo(() => {
    return active.reduce(
      (acc, c) => ({
        prospects: acc.prospects + (c.total_prospects ?? 0),
        contacted: acc.contacted + (c.contacted ?? 0),
        replied: acc.replied + (c.replied ?? 0),
        meetings: acc.meetings + (c.meeting_booked ?? 0),
      }),
      { prospects: 0, contacted: 0, replied: 0, meetings: 0 },
    );
  }, [active]);

  return (
    <div>
      <PageHeader
        eyebrow="Live"
        title="Campaigns"
        description="Every outbound run in flight. Metrics refresh every 15 seconds and stream live over WebSocket."
        icon={Sparkles}
        actions={
          <Link to="/campaigns/new" className="btn-primary">
            <PlusCircle className="h-4 w-4" />
            New campaign
          </Link>
        }
      />

      {/* ═══ Bento hero stats ═══════════════════════════════════════ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Total prospects"
          value={totals.prospects}
          icon={Users}
          tone="primary"
          deltaLabel="Across all campaigns"
        />
        <StatCard
          label="Contacted"
          value={totals.contacted}
          icon={Mail}
          tone="sky"
          deltaLabel="First-touch + follow-ups"
        />
        <StatCard
          label="Replies"
          value={totals.replied}
          icon={MessageSquare}
          tone="emerald"
          deltaLabel="Positive + neutral + unsub"
        />
        <StatCard
          label="Meetings booked"
          value={totals.meetings}
          icon={CalendarCheck}
          tone="violet"
          deltaLabel="Via Calendly webhook"
        />
      </div>

      {/* ═══ Campaign grid + activity rail ══════════════════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-3">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-3.5 w-3.5" />
              In flight
            </h2>
            <span className="text-xs text-muted-foreground">
              {active.length} {active.length === 1 ? 'campaign' : 'campaigns'}
            </span>
          </div>

          {isLoading && (
            <div className="glass rounded-2xl h-40 animate-shimmer" />
          )}

          {!isLoading && active.length === 0 && (
            <div className="glass rounded-2xl text-center py-16 px-6 bg-grid-subtle">
              <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-lg shadow-primary/30 mb-4">
                <Sparkles className="h-8 w-8" />
              </div>
              <div className="text-lg font-semibold mb-1">No campaigns yet</div>
              <div className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
                Kick off your first autonomous outbound run. The orchestrator
                will find, score, and reach prospects for you.
              </div>
              <Link to="/campaigns/new" className="btn-primary">
                <PlusCircle className="h-4 w-4" />
                Create your first campaign
              </Link>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {active.map((c, i) => (
              <CampaignCard key={c.id} campaign={c} index={i} />
            ))}
          </div>
        </div>

        {/* ─── Live activity rail ────────────────────────────────── */}
        <aside className="glass rounded-2xl p-5 h-fit sticky top-24">
          <div className="flex items-center gap-2 mb-4">
            <div className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15">
              <Radio className="h-4 w-4 text-emerald-500" />
              <span className="absolute inset-0 rounded-lg ring-2 ring-emerald-500/40 animate-ping" />
            </div>
            <div>
              <div className="text-sm font-semibold">Live feed</div>
              <div className="text-[11px] text-muted-foreground">
                WebSocket · real time
              </div>
            </div>
          </div>

          {feed.length === 0 ? (
            <div className="text-xs text-muted-foreground border border-dashed border-border/80 rounded-xl py-6 px-3 text-center">
              <Activity className="mx-auto h-5 w-5 mb-2 opacity-60" />
              Waiting for events. Replies, meetings, and contact events will
              appear here as they happen.
            </div>
          ) : (
            <ul className="space-y-3 max-h-[60vh] overflow-auto -mr-2 pr-2">
              {feed.map((event, idx) => (
                <motion.li
                  key={idx}
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25 }}
                  className="relative pl-4 py-1"
                >
                  <span className="absolute left-0 top-2 h-2 w-2 rounded-full bg-primary ring-4 ring-primary/20" />
                  <div className="text-xs font-semibold">
                    {event.type.replace(/_/g, ' ')}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {JSON.stringify(event)}
                  </div>
                </motion.li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
