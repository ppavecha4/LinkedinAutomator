/**
 * Settings › Plan & usage (SaaS phase 5). What the company's plan includes,
 * how much of it this month has used, and (when online payment is set up)
 * how to move to another plan. Anyone in the company can see usage; only
 * the owner can buy or manage the subscription.
 */

import { CreditCard, Gauge, Loader2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { PageHeader } from '../components/ui/page-header';
import { type Billing, type Meter, type PlanOption, useBilling, useCheckout, usePortal } from '../hooks/useBilling';
import { errorMessage, useAuth } from '../lib/authContext';
import { cn } from '../lib/cn';

const fmt = (n: number | null) => (n === null ? 'Unlimited' : n.toLocaleString());

const STATUS_NOTE: Record<string, string> = {
  past_due: 'Your last payment did not go through. Update your card, or your plan will end.',
  canceled: 'Your subscription has ended, so the free trial limits apply.',
  unpaid: 'Your subscription was stopped for non-payment, so the free trial limits apply.',
};

export default function Plan(): React.ReactElement {
  const { user } = useAuth();
  const { data, isLoading, error, refetch } = useBilling();
  const isOwner = !user?.role || user.role === 'owner';

  // Back from Stripe: say what happened, then re-read the plan (the webhook may take a moment).
  React.useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('checkout');
    if (!result) return;
    window.history.replaceState({}, '', window.location.pathname);
    if (result === 'success') {
      toast.success('Thanks! Your plan is being updated.');
      const timers = [2000, 6000, 15000].map((ms) => window.setTimeout(() => { void refetch(); }, ms));
      return () => timers.forEach(window.clearTimeout);
    }
    toast('Checkout cancelled. Nothing was charged.');
    return undefined;
  }, [refetch]);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Settings"
        title="Plan & usage"
        description="What your plan includes and how much of it you have used this month."
        icon={Gauge}
      />
      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" /></div>
      ) : error || !data ? (
        <p role="alert" className="text-sm text-destructive">{errorMessage(error, 'Could not load your plan.')}</p>
      ) : (
        <div className="max-w-4xl space-y-6">
          <Usage billing={data} isOwner={isOwner} />
          <Plans billing={data} isOwner={isOwner} />
        </div>
      )}
    </div>
  );
}

function Usage({ billing, isOwner }: { billing: Billing; isOwner: boolean }): React.ReactElement {
  const portal = usePortal();
  const note = billing.subscription.status ? STATUS_NOTE[billing.subscription.status] : undefined;
  const monthStart = new Date(billing.period_start);
  const resets = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
  const fmtDate = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

  async function openPortal() {
    try {
      window.location.assign(await portal.mutateAsync());
    } catch (e) {
      toast.error(errorMessage(e, 'Could not open billing.'));
    }
  }

  return (
    <section className="glass rounded-2xl p-6 space-y-5" aria-labelledby="usage-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="usage-title" className="text-base font-semibold">{billing.plan_label}</h2>
          <p className="text-xs text-muted-foreground">
            Messages reset on {fmtDate(resets)}
            {billing.subscription.renews_at && billing.subscription.status === 'active' ? ` · renews ${fmtDate(new Date(billing.subscription.renews_at))}` : ''}
          </p>
        </div>
        {isOwner && billing.payments_enabled && billing.subscription.has_customer && (
          <button type="button" className="btn-secondary" onClick={openPortal} disabled={portal.isPending}>
            {portal.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CreditCard className="h-4 w-4" aria-hidden="true" />}
            Manage billing
          </button>
        )}
      </div>
      {note && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">{note}</p>}
      <div className="grid gap-5 sm:grid-cols-3">
        <MeterBar label="Messages sent this month" meter={billing.messages} />
        <MeterBar label="Active campaigns" meter={billing.campaigns} />
        <MeterBar label="Team seats (people + invitations)" meter={billing.seats} />
      </div>
    </section>
  );
}

function MeterBar({ label, meter }: { label: string; meter: Meter }): React.ReactElement {
  const pct = meter.limit === null ? 0 : meter.limit === 0 ? 100 : Math.min(100, Math.round((meter.used / meter.limit) * 100));
  const tone = pct >= 100 ? 'bg-destructive' : pct >= 80 ? 'bg-amber-500' : 'bg-primary';
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground text-xs">{label}</span>
      </div>
      <p className="mt-1 text-lg font-semibold">
        {meter.used.toLocaleString()} <span className="text-sm font-normal text-muted-foreground">/ {fmt(meter.limit)}</span>
      </p>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={meter.limit ?? undefined}
        aria-valuenow={meter.used}
        className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
      >
        <div className={cn('h-full rounded-full transition-all', tone)} style={{ width: meter.limit === null ? '0%' : `${pct}%` }} />
      </div>
      {pct >= 100 && meter.limit !== null && <p className="mt-1 text-xs text-destructive">Limit reached</p>}
    </div>
  );
}

function Plans({ billing, isOwner }: { billing: Billing; isOwner: boolean }): React.ReactElement {
  const checkout = useCheckout();
  const [busy, setBusy] = React.useState<string | null>(null);
  const subscribed = ['active', 'trialing', 'past_due'].includes(billing.subscription.status ?? '');

  async function buy(plan: string) {
    setBusy(plan);
    try {
      window.location.assign(await checkout.mutateAsync(plan));
    } catch (e) {
      toast.error(errorMessage(e, 'Could not start checkout.'));
      setBusy(null);
    }
  }

  return (
    <section className="glass rounded-2xl p-6 space-y-4" aria-labelledby="plans-title">
      <h2 id="plans-title" className="text-base font-semibold">Plans</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {billing.plans.map((p) => (
          <PlanCard key={p.plan} p={p} action={
            p.current ? <span className="text-xs font-semibold text-primary">Your plan</span>
            : !billing.payments_enabled || !p.can_buy ? null
            : !isOwner ? <span className="text-xs text-muted-foreground">Ask your owner</span>
            : subscribed ? <span className="text-xs text-muted-foreground">Change it in Manage billing</span>
            : (
              <button type="button" className="btn-primary" onClick={() => buy(p.plan)} disabled={busy !== null}>
                {busy === p.plan && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                Choose {p.label}
              </button>
            )
          } />
        ))}
      </div>
      {!billing.payments_enabled && (
        <p className="text-xs text-muted-foreground">To change your plan, contact the platform team.</p>
      )}
    </section>
  );
}

function PlanCard({ p, action }: { p: PlanOption; action: React.ReactNode }): React.ReactElement {
  return (
    <div className={cn('rounded-xl border p-4 space-y-2', p.current ? 'border-primary bg-primary/5' : 'border-border')}>
      <h3 className="font-semibold">{p.label}</h3>
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        <li>{fmt(p.messages)} messages / month</li>
        <li>{fmt(p.campaigns)} active campaign{p.campaigns === 1 ? '' : 's'}</li>
        <li>{fmt(p.seats)} seat{p.seats === 1 ? '' : 's'}</li>
      </ul>
      <div className="pt-1 min-h-8">{action}</div>
    </div>
  );
}
