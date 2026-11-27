/**
 * Settings › Connected accounts › WhatsApp messages (slice 9.1).
 *
 * WhatsApp only lets a business start a chat with a template Meta approved. This panel is the
 * whole job for a non-technical owner: "write my messages" (the AI drafts a first message and a
 * follow-up per language), read or tweak them, "send for approval", then watch the status. Approved
 * ones are used by the sender automatically: nothing is pasted anywhere.
 */

import { CheckCircle2, Clock, Loader2, MessageCircle, Pencil, RefreshCw, Send, Sparkles, Trash2, TriangleAlert, XCircle } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { t, tServer, tn } from '../../i18n';
import {
  type LanguageReadiness,
  type TemplateStatus,
  useDraftTemplates,
  useEditTemplate,
  useRefreshTemplates,
  useRemoveTemplate,
  useSubmitTemplates,
  useWhatsAppTemplates,
  type WhatsAppTemplate,
} from '../../hooks/useWhatsAppTemplates';
import { errorMessage } from '../../lib/authContext';
import { cn } from '../../lib/cn';
import { LANGUAGES, languageName } from '../../lib/profile';

const KIND_LABEL = { first: t('First message'), followup: t('Follow-up') } as const;

const STATUS: Record<TemplateStatus | 'NONE', { label: string; tone: string; icon: React.ReactElement }> = {
  NONE: { label: t('Not written yet'), tone: 'text-muted-foreground', icon: <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> },
  DRAFT: { label: t('Ready to send for approval'), tone: 'text-foreground', icon: <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> },
  PENDING: { label: t('Waiting for WhatsApp'), tone: 'text-amber-600', icon: <Clock className="h-3.5 w-3.5" aria-hidden="true" /> },
  APPROVED: { label: t('Approved'), tone: 'text-emerald-600', icon: <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> },
  REJECTED: { label: t('Rejected'), tone: 'text-destructive', icon: <XCircle className="h-3.5 w-3.5" aria-hidden="true" /> },
  PAUSED: { label: t('Paused by WhatsApp'), tone: 'text-destructive', icon: <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" /> },
  DISABLED: { label: t('Turned off by WhatsApp'), tone: 'text-destructive', icon: <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" /> },
};

function Badge({ status }: { status: TemplateStatus | null }): React.ReactElement {
  const s = STATUS[status ?? 'NONE'];
  return <span className={cn('inline-flex items-center gap-1 text-xs font-medium', s.tone)}>{s.icon}{s.label}</span>;
}

export function WhatsAppMessages({ canManage }: { canManage: boolean }): React.ReactElement {
  const view = useWhatsAppTemplates();
  const draft = useDraftTemplates();
  const submit = useSubmitTemplates();
  const refresh = useRefreshTemplates();
  const [extra, setExtra] = React.useState('');

  const data = view.data;
  const busy = draft.isPending || submit.isPending || refresh.isPending;
  const toSend = (data?.templates ?? []).filter((item) => item.status === 'DRAFT' || item.status === 'REJECTED').length;
  const drafts = (data?.templates ?? []).filter((item) => item.status === 'DRAFT').length;
  const hasAny = (data?.templates.length ?? 0) > 0;

  async function write(languages?: string[]) {
    try {
      const r = await draft.mutateAsync(languages ? { languages } : undefined);
      if (r.problems.length) {
        toast.warning(t('Some messages could not be written'), {
          description: r.problems.map((p) => `${languageName(p.language)} ${KIND_LABEL[p.kind as 'first' | 'followup'] ?? p.kind}: ${p.issues.map(tServer).join(' ')}`).join('\n'),
        });
      } else if (r.saved > 0) {
        toast.success(t('Your messages are written'), { description: t('Read them, then send them for approval.') });
      } else if (r.kept.length) {
        toast.message(t('Nothing to write'), { description: t('Those messages are already with WhatsApp.') });
      }
    } catch (e) {
      toast.error(errorMessage(e, t('Could not write the messages.')));
    }
  }

  async function send() {
    try {
      const r = await submit.mutateAsync(undefined);
      const failed = r.results.filter((x) => !x.ok);
      const okCount = r.results.length - failed.length;
      if (okCount) toast.success(tn(okCount, '{count} message sent to WhatsApp for approval', '{count} messages sent to WhatsApp for approval'), { description: t('This usually takes from a few minutes to a day. We will use them as soon as they are approved.') });
      if (failed.length) toast.error(t('Some messages were not sent'), { description: failed.map((f) => `${languageName(f.language)} ${KIND_LABEL[f.kind as 'first' | 'followup'] ?? f.kind}: ${tServer(f.error ?? '')}`).join('\n') });
    } catch (e) {
      toast.error(errorMessage(e, t('Could not send the messages.')));
    }
  }

  async function check() {
    try {
      const r = await refresh.mutateAsync();
      toast.message(r.changed ? tn(r.changed, '{count} message got an answer', '{count} messages got an answer') : t('No news yet'), { description: r.checked ? undefined : t('Nothing is waiting for WhatsApp.') });
    } catch (e) {
      toast.error(errorMessage(e, t('Could not check.')));
    }
  }

  const addable = LANGUAGES.filter((l) => !(data?.languages ?? []).some((x) => x.language === l));

  return (
    <section className="glass rounded-2xl p-5 space-y-4" aria-labelledby="wa-messages-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="wa-messages-title" className="flex items-center gap-2 text-base font-semibold">
            <MessageCircle className="h-4 w-4 text-primary" aria-hidden="true" />{' '}{t('WhatsApp messages')}
          </h2>
          <p className="mt-1 max-w-xl text-xs text-muted-foreground">
            {t('WhatsApp only lets a business start a chat with messages it has approved. We write them for you from your business profile and get them approved. You do not copy anything between accounts.')}
          </p>
        </div>
        {canManage && data && (
          <div className="flex flex-wrap gap-2">
            {hasAny && (
              <button type="button" className="btn-ghost text-xs" onClick={check} disabled={busy}>
                {refresh.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
                {t('Check status')}
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={() => write()} disabled={busy}>
              {draft.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
              {hasAny ? t('Rewrite my messages') : t('Write my messages')}
            </button>
            {toSend > 0 && (
              <button type="button" className="btn-primary" onClick={send} disabled={busy || !data.connected}>
                {submit.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
                {t('Send for approval')}
              </button>
            )}
          </div>
        )}
      </div>

      {view.isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={t('Loading')} />}
      {view.error && <p role="alert" className="text-sm text-destructive">{errorMessage(view.error, t('Could not load your WhatsApp messages.'))}</p>}

      {data && !data.connected && (
        <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          {t('Connect WhatsApp above first: it is how the messages are sent to WhatsApp for approval.')}
        </p>
      )}
      {data && !hasAny && (
        <p className="text-sm text-muted-foreground">
          {t('Nothing written yet. “Write my messages” creates a first message and a follow-up in {value}.', { value: data.suggested_languages.map(languageName).join(', ') })}
        </p>
      )}
      {drafts > 0 && data?.connected && (
        <p className="text-xs text-muted-foreground">{t('Read them first: you can change any wording. When you are happy, “Send for approval”.')}</p>
      )}

      {data?.languages.map((l) => (
        <LanguageBlock key={l.language} readiness={l} templates={data.templates.filter((item) => item.language === l.language)} canManage={canManage} onRewrite={() => write([l.language])} busy={busy} />
      ))}

      {canManage && data && hasAny && addable.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <label htmlFor="wa-add-language" className="text-xs text-muted-foreground">{t('Also write them in')}</label>
          <select id="wa-add-language" className="input h-8 w-auto py-0 text-xs" value={extra} onChange={(e) => setExtra(e.target.value)}>
            <option value="">{t('choose a language…')}</option>
            {addable.map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
          </select>
          <button type="button" className="btn-ghost text-xs" disabled={!extra || busy} onClick={() => { void write([extra]); setExtra(''); }}>{t('Add')}</button>
        </div>
      )}
    </section>
  );
}

function LanguageBlock({ readiness, templates, canManage, onRewrite, busy }: {
  readiness: LanguageReadiness; templates: WhatsAppTemplate[]; canManage: boolean; onRewrite: () => void; busy: boolean;
}): React.ReactElement {
  return (
    <div className="rounded-xl border border-border/70 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{languageName(readiness.language)}</h3>
        {readiness.ready
          ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />{' '}{t('Ready to send')}</span>
          : <span className="text-xs text-muted-foreground">{t('Needs both messages approved')}</span>}
      </div>
      {(['first', 'followup'] as const).map((kind) => {
        const item = templates.find((x) => x.kind === kind);
        return item
          ? <TemplateItem key={kind} item={item} canManage={canManage} onRewrite={onRewrite} busy={busy} />
          : <div key={kind} className="flex items-center justify-between text-sm"><span>{KIND_LABEL[kind]}</span><Badge status={null} /></div>;
      })}
    </div>
  );
}

function TemplateItem({ item, canManage, onRewrite, busy }: { item: WhatsAppTemplate; canManage: boolean; onRewrite: () => void; busy: boolean }): React.ReactElement {
  const edit = useEditTemplate();
  const remove = useRemoveTemplate();
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(item.body);
  const [issues, setIssues] = React.useState<string[]>([]);
  const editable = item.status === 'DRAFT' || item.status === 'REJECTED';

  async function save() {
    try {
      const r = await edit.mutateAsync({ id: item.id, body: text });
      setIssues(r.issues);
      setEditing(false);
    } catch (e) {
      setIssues([errorMessage(e, t('Could not save.'))]);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{KIND_LABEL[item.kind]}</span>
        <Badge status={item.status} />
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea className="input min-h-[7rem] w-full text-sm" value={text} onChange={(e) => setText(e.target.value)} maxLength={1024} aria-label={t('{value} text', { value: KIND_LABEL[item.kind] })} />
          <p className="text-xs text-muted-foreground">{t('Keep')}{' '}<code>{'{{1}}'}</code>{' '}{t('(first name) and')}{' '}<code>{'{{2}}'}</code>{' '}{t('(their company) and the “Reply STOP” line.')}</p>
          {issues.length > 0 && <ul role="alert" className="list-disc ps-5 text-xs text-destructive">{issues.map((i) => <li key={i}>{tServer(i)}</li>)}</ul>}
          <div className="flex gap-2">
            <button type="button" className="btn-primary text-xs" onClick={save} disabled={edit.isPending}>{t('Save')}</button>
            <button type="button" className="btn-ghost text-xs" onClick={() => { setEditing(false); setText(item.body); setIssues([]); }}>{t('Cancel')}</button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-sm leading-relaxed">{item.body}</p>
      )}
      {item.status === 'REJECTED' && (
        <p role="alert" className="text-xs text-destructive">{t('WhatsApp said: {reason}. Change the wording or let the AI rewrite it, then send it again.', { reason: item.rejection_reason || t('no reason given') })}</p>
      )}
      {(item.status === 'PAUSED' || item.status === 'DISABLED') && (
        <p role="alert" className="text-xs text-destructive">{item.rejection_reason ? t('WhatsApp stopped this message: {reason}. It is not being used.', { reason: item.rejection_reason }) : t('WhatsApp stopped this message. It is not being used.')}</p>
      )}
      {canManage && editable && !editing && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost text-xs" onClick={() => { setText(item.body); setEditing(true); }}><Pencil className="h-3.5 w-3.5" aria-hidden="true" />{' '}{t('Edit')}</button>
          {item.status === 'REJECTED' && (
            <button type="button" className="btn-ghost text-xs" onClick={onRewrite} disabled={busy}><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />{' '}{t('Rewrite with AI')}</button>
          )}
          <button type="button" className="btn-ghost text-xs" onClick={() => remove.mutate(item.id)} disabled={remove.isPending}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />{' '}{t('Remove')}</button>
        </div>
      )}
    </div>
  );
}
