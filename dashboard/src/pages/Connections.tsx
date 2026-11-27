/**
 * Settings › Connected accounts (SaaS phase 2, slice 2.5). Each card is an
 * account the org can use (only channels it is entitled to). Saving
 * encrypts the secret server-side (credential vault); secrets are never
 * shown again, so "Manage" asks for them afresh. Below: organization
 * defaults used when a contact has no language or country of their own.
 *
 * Saving an account checks it with the provider straight away
 * (POST /api/credentials/:id/verify, slice 3.4); campaigns only send
 * through VERIFIED accounts. A failed check shows the provider's reason.
 */

import { CheckCircle2, CircleDashed, KeyRound, Loader2, Plug, RefreshCw, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import * as React from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';

import { t, tServer } from '../i18n';
import { CountrySelect, Field } from '../components/profile/fields';
import { ConnectWhatsApp } from '../components/whatsapp/ConnectWhatsApp';
import { WhatsAppMessages } from '../components/whatsapp/WhatsAppMessages';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { PageHeader } from '../components/ui/page-header';
import { Progress } from '../components/ui/progress';
import {
  useCredentials,
  useOrganization,
  useRemoveCredential,
  useSaveCredential,
  useUpdateOrganization,
  useVerifyCredential,
} from '../hooks/useWorkspace';
import { errorMessage, useAuth } from '../lib/authContext';
import { cn } from '../lib/cn';
import { LANGUAGES, languageName } from '../lib/profile';
import {
  ACCOUNT_KINDS,
  type AccountKind,
  CHECKABLE,
  connectedFor,
  type Credential,
  type Provider,
  type ProviderField,
  verifiedFor,
} from '../lib/workspace';

export default function Connections(): React.ReactElement {
  const org = useOrganization();
  const creds = useCredentials();
  const { user } = useAuth();
  const canManage = !user?.role || user.role === 'owner' || user.role === 'admin';

  // Deep links from "Get ready to send": ?connect=<provider> opens that account's dialog, #id scrolls to a section.
  const [params, setParams] = useSearchParams();
  const connectParam = params.get('connect');
  const { hash } = useLocation();
  const loaded = !org.isLoading && !creds.isLoading;
  React.useEffect(() => {
    if (loaded && hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [loaded, hash]);

  const kinds = ACCOUNT_KINDS.filter((k) => !k.channel || org.data?.channels.includes(k.channel));
  const countable = kinds.filter((k) => !k.comingSoon);
  // WhatsApp also counts when it is connected one-click through Meta (slice 10.2).
  const done = countable.filter((k) => verifiedFor(creds.data, [...k.providers.map((p) => p.id), ...(k.id === 'whatsapp' ? ['whatsapp_meta'] : [])])).length;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={t('Settings')}
        title={t('Connected accounts')}
        description={t('Outreach is sent from your accounts, not ours. Keys are encrypted the moment you save them and are never shown again.')}
        icon={Plug}
      />
      {org.isLoading || creds.isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label={t('Loading')} />
        </div>
      ) : org.error || creds.error ? (
        <p role="alert" className="text-sm text-destructive">{errorMessage(org.error ?? creds.error, t('Could not load your accounts.'))}</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-4">
            {org.data?.operator && (
              <p className="rounded-xl border border-primary/30 bg-primary/10 p-4 text-sm">
                {t('This is the operator workspace: it runs on the keys in the server\'s environment file. Accounts saved here are stored but not used.')}
              </p>
            )}
            {kinds.map((k) => (
              <React.Fragment key={k.id}>
                {/* One-click WhatsApp through Meta (slice 10.2): hidden until the server has Meta's app settings. */}
                {k.id === 'whatsapp' && !org.data?.operator && <ConnectWhatsApp canManage={canManage} />}
                <AccountCard
                  kind={k}
                  creds={creds.data ?? []}
                  canManage={canManage}
                  autoOpen={!!connectParam && k.providers.some((p) => p.id === connectParam)}
                  onAutoOpened={() => setParams((p) => { p.delete('connect'); return p; }, { replace: true })}
                />
                {/* The AI writes the WhatsApp templates and gets them approved (slice 9.1). */}
                {k.id === 'whatsapp' && !org.data?.operator && <WhatsAppMessages canManage={canManage} />}
              </React.Fragment>
            ))}
            {!canManage && (
              <p className="text-xs text-muted-foreground">{t('Only owners and admins can connect or change accounts.')}</p>
            )}
          </div>
          <aside className="space-y-5">
            <section className="glass rounded-2xl p-5">
              <div className="flex items-baseline justify-between">
                <h2 className="text-base font-semibold">{t('Setup progress')}</h2>
                <span className="text-sm tabular-nums text-muted-foreground">{t('{done} of {count} verified', { done, count: countable.length })}</span>
              </div>
              <Progress value={countable.length ? (done / countable.length) * 100 : 0} className="mt-3" aria-label={t('{done} of {count} accounts verified', { done, count: countable.length })} />
              <p className="mt-3 text-xs text-muted-foreground">
                {t('A campaign can launch once every channel it uses has a verified account. Unverified accounts send nothing.')}
              </p>
            </section>
            {org.data && <OrgDefaults canManage={canManage} />}
          </aside>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ cred }: { cred: Credential | undefined }): React.ReactElement {
  if (!cred) {
    return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><CircleDashed className="h-3.5 w-3.5" aria-hidden="true" />{t('Not connected')}</span>;
  }
  if (cred.status === 'VERIFIED') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />{t('Verified')}</span>;
  }
  if (cred.status === 'FAILED') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive"><XCircle className="h-3.5 w-3.5" aria-hidden="true" />{t('Check failed')}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400">
      <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />{CHECKABLE.has(cred.provider) ? t('Not checked yet') : t('Saved')}
    </span>
  );
}

function AccountCard({ kind, creds, canManage, autoOpen = false, onAutoOpened }: {
  kind: AccountKind; creds: Credential[]; canManage: boolean; autoOpen?: boolean; onAutoOpened?: () => void;
}): React.ReactElement {
  const cred = connectedFor(creds, kind.providers.map((p) => p.id));
  const provider = cred ? kind.providers.find((p) => p.id === cred.provider) : undefined;
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (autoOpen && canManage && !kind.comingSoon) { setOpen(true); onAutoOpened?.(); }
  }, [autoOpen, canManage, kind.comingSoon, onAutoOpened]);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const remove = useRemoveCredential();
  const verify = useVerifyCredential();
  const summary = provider?.summary ? cred?.meta[provider.summary] : undefined;

  async function checkAgain() {
    try {
      const r = await verify.mutateAsync(cred!.id);
      if (r.status === 'VERIFIED') toast.success(t('{title} verified', { title: kind.title }));
      else toast.error(t('{title} check failed', { title: kind.title }), { description: r.last_error ?? undefined });
    } catch (e) {
      toast.error(errorMessage(e, t('Could not check this account.')));
    }
  }

  return (
    <section className={cn('glass rounded-2xl p-5', kind.comingSoon && 'opacity-70')} aria-labelledby={`acct-${kind.id}`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 id={`acct-${kind.id}`} className="text-base font-semibold">{kind.title}</h2>
            <span className="text-xs text-muted-foreground">{kind.subtitle}</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{kind.why}</p>
          {cred && (
            <p className="mt-2 text-sm">
              {provider?.name ?? cred.provider}
              {summary ? <span className="text-muted-foreground"> · {String(summary)}</span> : null}
            </p>
          )}
          {cred?.status === 'FAILED' && cred.last_error && (
            <p role="status" className="mt-2 text-sm text-destructive">{tServer(cred.last_error)}</p>
          )}
        </div>
        <div className="shrink-0">
          {kind.comingSoon ? <span className="text-xs font-medium text-muted-foreground">{t('Coming soon')}</span> : <StatusBadge cred={cred} />}
        </div>
      </div>
      {!kind.comingSoon && canManage && (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {cred && CHECKABLE.has(cred.provider) && cred.status !== 'VERIFIED' && (
            <button type="button" className="btn-ghost px-2.5 py-1.5 text-xs" onClick={checkAgain} disabled={verify.isPending}>
              {verify.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
              {cred.status === 'FAILED' ? t('Check again') : t('Check now')}
            </button>
          )}
          {cred && (
            <button type="button" className="btn-ghost px-2.5 py-1.5 text-xs text-destructive" onClick={() => setConfirmRemove(true)} aria-label={t('Disconnect {title}', { title: kind.title })}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />{' '}{t('Disconnect')}
            </button>
          )}
          <button type="button" className={cred ? 'btn-secondary px-3 py-1.5 text-xs' : 'btn-primary px-3 py-1.5 text-xs'} onClick={() => setOpen(true)}>
            {cred ? t('Manage') : t('Connect')}
          </button>
        </div>
      )}

      {open && <ConnectDialog kind={kind} current={cred} onClose={() => setOpen(false)} />}

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Disconnect {title}?', { title: kind.title })}</DialogTitle>
            <DialogDescription>
              {t('The saved key is destroyed and can\'t be recovered. Campaigns that use {value} can\'t launch until you connect an account again.', { value: kind.title.toLowerCase() })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button type="button" className="btn-ghost" onClick={() => setConfirmRemove(false)}>{t('Keep it')}</button>
            <button
              type="button"
              className="btn bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={async () => {
                try {
                  await remove.mutateAsync(cred!.id);
                  toast.success(t('{title} disconnected', { title: kind.title }));
                  setConfirmRemove(false);
                } catch (e) {
                  toast.error(errorMessage(e, t('Could not disconnect.')));
                }
              }}
            >
              {remove.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {t('Disconnect')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ConnectDialog({ kind, current, onClose }: { kind: AccountKind; current: Credential | undefined; onClose: () => void }): React.ReactElement {
  const [providerId, setProviderId] = React.useState(current?.provider ?? kind.providers[0].id);
  const provider = kind.providers.find((p) => p.id === providerId) as Provider;
  const [values, setValues] = React.useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    if (current && current.provider === providerId) {
      for (const [k, x] of Object.entries(current.meta)) v[k] = String(x);
      // Per-language entries (template_sid_es …) back into "es=HX…, …".
      for (const f of kind.providers.find((p) => p.id === providerId)?.fields ?? []) {
        const prefix = f.langPrefix;
        if (!prefix) continue;
        v[f.key] = Object.entries(current.meta)
          .filter(([k]) => k.startsWith(`${prefix}_`))
          .map(([k, x]) => `${k.slice(prefix.length + 1)}=${String(x)}`)
          .join(', ');
      }
    }
    return v;
  });
  const [error, setError] = React.useState<string | null>(null);
  const save = useSaveCredential();
  const verify = useVerifyCredential();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const secret: Record<string, string> = {};
    const meta: Record<string, string | number> = {};
    for (const f of provider.fields) {
      const v = (values[f.key] ?? '').trim();
      if (f.langPrefix) {
        for (const part of v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)) {
          const m = /^([a-z]{2,3})\s*[=:]\s*(HX[0-9a-fA-F]{32})$/i.exec(part);
          if (!m) {
            setError(t('{label}: write each as language=Content SID, e.g. es=HX… ("{part}" isn\'t).', { label: f.label, part }));
            return;
          }
          meta[`${f.langPrefix}_${m[1].toLowerCase()}`] = m[2];
        }
        continue;
      }
      if (!v) {
        if (f.optional) continue;
        setError(t('{label} is required.', { label: f.label }));
        return;
      }
      if (f.pattern && !f.pattern.test(v)) {
        setError(f.patternMessage ?? t('{label} doesn\'t look right.', { label: f.label }));
        return;
      }
      if (f.secret) secret[f.key] = v;
      else meta[f.key] = f.type === 'number' ? Number(v) : v;
    }
    try {
      const saved = await save.mutateAsync({ provider: provider.id, secret, meta });
      if (!CHECKABLE.has(provider.id)) {
        toast.success(t('{title} saved', { title: kind.title }), { description: t('Encrypted and stored.') });
        onClose();
        return;
      }
      // Check it with the provider right away; campaigns only use verified accounts.
      const checked = await verify.mutateAsync(saved.id);
      if (checked.status === 'VERIFIED') {
        toast.success(t('{title} connected and verified', { title: kind.title }));
        onClose();
      } else {
        setError(t('Saved, but the check failed: {reason}', { reason: checked.last_error ? tServer(checked.last_error) : t('unknown reason') }));
      }
    } catch (err) {
      setError(errorMessage(err, t('Could not save. Check the fields and try again.')));
    }
  }

  const renderField = (f: ProviderField) => (
    <Field key={f.key} label={`${f.label}${f.optional ? ` ${t('(optional)')}` : ''}`} hint={f.hint} htmlFor={`cx-${f.key}`}>
      <input
        id={`cx-${f.key}`}
        className="input font-mono text-sm"
        type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : 'text'}
        autoComplete={f.secret ? 'new-password' : 'off'}
        placeholder={f.placeholder}
        value={values[f.key] ?? ''}
        onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
      />
    </Field>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{current ? t('Update {title}', { title: kind.title }) : t('Connect {title}', { title: kind.title })}</DialogTitle>
          <DialogDescription>
            {current ? t('Enter the key again to replace it; saved keys are never shown.') : kind.why}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" autoComplete="off">
          {kind.providers.length > 1 && (
            <Field label={t('Provider')} htmlFor="cx-provider">
              <select id="cx-provider" className="input" value={providerId} onChange={(e) => { setProviderId(e.target.value); setValues({}); setError(null); }}>
                {kind.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          )}
          {provider.fields.filter((f) => !f.advanced).map(renderField)}
          {provider.fields.some((f) => f.advanced) && (
            <details className="rounded-lg border border-border/70 p-3" open={provider.fields.some((f) => f.advanced && !!values[f.key])}>
              <summary className="cursor-pointer text-sm font-medium">{t('Advanced options (you can skip these)')}</summary>
              <div className="mt-3 space-y-4">{provider.fields.filter((f) => f.advanced).map(renderField)}</div>
            </details>
          )}
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t('Keys are encrypted before they are stored, tied to your organization, and never shown again.')}
          </p>
          {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <button type="button" className="btn-ghost" onClick={onClose}>{t('Cancel')}</button>
            <button type="submit" className="btn-primary" disabled={save.isPending || verify.isPending}>
              {(save.isPending || verify.isPending) && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {verify.isPending ? t('Checking…') : CHECKABLE.has(provider.id) ? t('Save and check') : t('Save')}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OrgDefaults({ canManage }: { canManage: boolean }): React.ReactElement {
  const { data: org } = useOrganization();
  const update = useUpdateOrganization();
  const timezones = React.useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
    } catch {
      return ['UTC'];
    }
  }, []);
  if (!org) return <></>;

  const patch = async (p: Parameters<typeof update.mutateAsync>[0]) => {
    try {
      await update.mutateAsync(p);
      toast.success(t('Saved'));
    } catch (e) {
      toast.error(errorMessage(e, t('Could not save.')));
    }
  };

  return (
    <section className="glass rounded-2xl p-5 space-y-4">
      <h2 className="text-base font-semibold">{t('Organization defaults')}</h2>
      <Field label={t('Default language')} htmlFor="od-lang">
        <select id="od-lang" className="input" disabled={!canManage} value={org.default_language} onChange={(e) => patch({ default_language: e.target.value })}>
          {(LANGUAGES as readonly string[]).includes(org.default_language) ? null : <option value={org.default_language}>{languageName(org.default_language)}</option>}
          {LANGUAGES.map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
        </select>
      </Field>
      <Field label={t('Home country')} htmlFor="od-country">
        <CountrySelect id="od-country" value={org.default_country ?? undefined} onChange={(c) => patch({ default_country: c ?? null })} />
      </Field>
      <Field label={t('Time zone')} htmlFor="od-tz">
        <select id="od-tz" className="input" disabled={!canManage} value={org.timezone} onChange={(e) => patch({ timezone: e.target.value })}>
          {timezones.includes(org.timezone) ? null : <option value={org.timezone}>{org.timezone}</option>}
          {timezones.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </Field>
      <p className="text-xs text-muted-foreground">{t('Used when a contact has no language or country of their own.')}</p>
    </section>
  );
}
