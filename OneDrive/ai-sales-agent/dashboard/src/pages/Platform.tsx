/**
 * Platform (SaaS phase 3, slice 3.8): every customer company in one
 * place, for the people who run the product. Visible only to platform
 * admins. Suspending a company signs its people out immediately and
 * pauses its campaigns; changes are recorded in the audit tab.
 */

import { Building2, Loader2, Pencil, Search } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { PageHeader } from '../components/ui/page-header';
import {
  type OrgStatus,
  PLANS,
  type Plan,
  type PlatformOrg,
  useUpdateOrg,
  usePlatformAudit,
  usePlatformMembers,
  usePlatformOrgs,
} from '../hooks/usePlatform';
import { errorMessage, useAuth } from '../lib/authContext';
import { cn } from '../lib/cn';
import { CHANNEL_LABEL, type OrgChannel } from '../lib/workspace';

const ALL_CHANNELS: OrgChannel[] = ['email', 'whatsapp', 'voice', 'linkedin'];
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

const STATUS_STYLE: Record<OrgStatus, string> = {
  ACTIVE: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  SUSPENDED: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  CANCELLED: 'bg-muted text-muted-foreground',
};

export default function Platform(): React.ReactElement {
  const { user } = useAuth();
  const allowed = user?.platform_admin === true;
  const orgs = usePlatformOrgs(allowed);
  const [tab, setTab] = React.useState<'companies' | 'audit'>('companies');
  const [filter, setFilter] = React.useState('');
  const [editing, setEditing] = React.useState<PlatformOrg | null>(null);
  const [suspending, setSuspending] = React.useState<PlatformOrg | null>(null);
  const update = useUpdateOrg();

  const shown = (orgs.data ?? []).filter((o) => !filter.trim() || `${o.name} ${o.slug}`.toLowerCase().includes(filter.trim().toLowerCase()));

  async function setStatus(o: PlatformOrg, status: OrgStatus) {
    try {
      const r = await update.mutateAsync({ id: o.id, patch: { status } });
      toast.success(status === 'ACTIVE' ? `${o.name} reactivated` : `${o.name} suspended`, {
        description: status === 'ACTIVE' ? 'Their people can sign in again. Paused campaigns stay paused until they resume them.' : `${r.paused_campaigns} campaign${r.paused_campaigns === 1 ? '' : 's'} paused, everyone signed out.`,
      });
    } catch (e) {
      toast.error(errorMessage(e, 'Could not change the status.'));
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Platform" title="Companies" description="Every company using the product: plan, channels, status and usage." icon={Building2} />
      {!allowed ? (
        <p className="text-sm text-muted-foreground">Only platform administrators can see this page.</p>
      ) : (
        <>
          <div role="tablist" aria-label="Platform sections" className="flex gap-1 rounded-xl bg-muted/60 p-1 w-fit">
            {(['companies', 'audit'] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={cn('rounded-lg px-4 py-1.5 text-sm font-semibold capitalize', tab === t ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                {t === 'audit' ? 'Change log' : 'Companies'}
              </button>
            ))}
          </div>

          {tab === 'audit' ? <Audit /> : orgs.isLoading ? (
            <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" /></div>
          ) : orgs.error ? (
            <p role="alert" className="text-sm text-destructive">{errorMessage(orgs.error, 'Could not load companies.')}</p>
          ) : (
            <section className="glass rounded-2xl p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">{shown.length} of {orgs.data?.length} companies</p>
                <label className="relative">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <input className="input w-64 pl-9" placeholder="Find a company" aria-label="Find a company" value={filter} onChange={(e) => setFilter(e.target.value)} />
                </label>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      {['Company', 'Plan', 'Status', 'Channels', 'People', 'Campaigns', 'Sent (30d)', 'Last activity', ''].map((h) => <th key={h} className="py-2 pr-3 font-semibold">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((o) => (
                      <tr key={o.id} className="border-t border-border/50 align-top">
                        <td className="py-3 pr-3">
                          <div className="font-medium">{o.name}{o.operator && <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">operator</span>}</div>
                          <div className="text-xs text-muted-foreground">joined {when(o.created_at)}{!o.onboarding_completed_at ? ' · setup unfinished' : ''}</div>
                        </td>
                        <td className="py-3 pr-3 capitalize">{o.plan}</td>
                        <td className="py-3 pr-3"><span className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', STATUS_STYLE[o.status])}>{o.status.toLowerCase()}</span></td>
                        <td className="py-3 pr-3 text-xs">{o.channels.map((c) => CHANNEL_LABEL[c]).join(', ')}</td>
                        <td className="py-3 pr-3 tabular-nums">{o.members}</td>
                        <td className="py-3 pr-3 tabular-nums">{o.active_campaigns} active / {o.campaigns}</td>
                        <td className="py-3 pr-3 tabular-nums">{o.sent_30d.toLocaleString()}</td>
                        <td className="py-3 pr-3 text-xs">{when(o.last_activity)}</td>
                        <td className="py-3 text-right whitespace-nowrap">
                          <button type="button" className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => setEditing(o)} aria-label={`Edit ${o.name}`}>
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Edit
                          </button>
                          {!o.operator && (o.status === 'ACTIVE' ? (
                            <button type="button" className="btn-ghost px-2.5 py-1.5 text-xs text-destructive" onClick={() => setSuspending(o)} aria-label={`Suspend ${o.name}`}>Suspend</button>
                          ) : (
                            <button type="button" className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => setStatus(o, 'ACTIVE')} disabled={update.isPending} aria-label={`Reactivate ${o.name}`}>Reactivate</button>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {editing && <EditDialog org={editing} onClose={() => setEditing(null)} />}

      <Dialog open={!!suspending} onOpenChange={(o) => !o && setSuspending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Suspend {suspending?.name}?</DialogTitle>
            <DialogDescription>
              Everyone in this company is signed out right away, their active campaigns are paused, and nothing is sent until you reactivate it. Their data is kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button type="button" className="btn-ghost" onClick={() => setSuspending(null)}>Cancel</button>
            <button type="button" className="btn bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={update.isPending}
              onClick={async () => { await setStatus(suspending!, 'SUSPENDED'); setSuspending(null); }}>
              {update.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Suspend
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EditDialog({ org, onClose }: { org: PlatformOrg; onClose: () => void }): React.ReactElement {
  const update = useUpdateOrg();
  const members = usePlatformMembers(org.id);
  const [plan, setPlan] = React.useState<Plan>(org.plan);
  const [channels, setChannels] = React.useState<OrgChannel[]>(org.channels);
  const [extra, setExtra] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const dirty = plan !== org.plan || channels.slice().sort().join() !== org.channels.slice().sort().join() || extra > 0;

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const patch: Parameters<typeof update.mutateAsync>[0]['patch'] = {};
    if (plan !== org.plan) patch.plan = plan;
    if (channels.slice().sort().join() !== org.channels.slice().sort().join()) patch.channels = channels;
    if (extra > 0) patch.add_ai_calls = extra;
    try {
      await update.mutateAsync({ id: org.id, patch });
      toast.success(`${org.name} updated`);
      onClose();
    } catch (err) {
      setError(errorMessage(err, 'Could not save.'));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{org.name}</DialogTitle>
          <DialogDescription>Plan, which channels they may use, and their free onboarding AI uses ({org.onboarding_ai_calls} used).</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSave} className="space-y-4">
          <div>
            <label htmlFor="pl-plan" className="label">Plan</label>
            <select id="pl-plan" className="input" value={plan} onChange={(e) => setPlan(e.target.value as Plan)}>
              {PLANS.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
            </select>
          </div>
          <fieldset>
            <legend className="label">Channels they may use</legend>
            <div className="flex flex-wrap gap-3">
              {ALL_CHANNELS.map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]" checked={channels.includes(c)}
                    onChange={(e) => setChannels(e.target.checked ? [...channels, c] : channels.filter((x) => x !== c))} />
                  {CHANNEL_LABEL[c]}
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">A channel can't be removed while one of their campaigns still uses it. LinkedIn is for Appson only.</p>
          </fieldset>
          <div>
            <label htmlFor="pl-ai" className="label">Give more free onboarding AI uses</label>
            <input id="pl-ai" type="number" min={0} max={1000} className="input w-32" value={extra} onChange={(e) => setExtra(Math.max(0, Number(e.target.value) || 0))} />
          </div>
          <div>
            <h3 className="label">People</h3>
            {members.isLoading ? <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading people" /> : (
              <ul className="max-h-40 space-y-1 overflow-y-auto text-sm">
                {(members.data ?? []).map((m) => (
                  <li key={m.user_id} className="flex justify-between gap-3">
                    <span className="truncate">{m.full_name ? `${m.full_name} · ` : ''}{m.email}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{m.role} · last in {when(m.last_login_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={!dirty || channels.length === 0 || update.isPending}>
              {update.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Save
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function describe(changes: Record<string, unknown>): string {
  const parts: string[] = [];
  const ba = (k: string) => {
    const v = changes[k] as { before: unknown; after: unknown } | undefined;
    return v ? `${k}: ${[v.before].flat().join(', ')} → ${[v.after].flat().join(', ')}` : null;
  };
  for (const k of ['status', 'plan', 'channels']) { const p = ba(k); if (p) parts.push(p); }
  if (changes.campaigns_paused) parts.push(`${changes.campaigns_paused} campaigns paused`);
  if (changes.onboarding_ai_allowance_added) parts.push(`+${changes.onboarding_ai_allowance_added} free AI uses`);
  return parts.join(' · ');
}

function Audit(): React.ReactElement {
  const { data, isLoading, error } = usePlatformAudit();
  if (isLoading) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" /></div>;
  if (error) return <p role="alert" className="text-sm text-destructive">{errorMessage(error, 'Could not load the change log.')}</p>;
  if (!data?.length) return <p className="text-sm text-muted-foreground">No changes yet.</p>;
  return (
    <section className="glass rounded-2xl p-5">
      <ul className="divide-y divide-border/50 text-sm">
        {data.map((a) => (
          <li key={a.id} className="py-3">
            <div><span className="font-medium">{a.org_name ?? 'A company'}</span> <span className="text-muted-foreground">— {describe(a.changes) || a.action}</span></div>
            <div className="text-xs text-muted-foreground">{a.actor_email} · {new Date(a.created_at).toLocaleString()}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
