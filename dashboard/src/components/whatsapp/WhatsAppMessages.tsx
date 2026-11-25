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

const KIND_LABEL = { first: 'First message', followup: 'Follow-up' } as const;

const STATUS: Record<TemplateStatus | 'NONE', { label: string; tone: string; icon: React.ReactElement }> = {
  NONE: { label: 'Not written yet', tone: 'text-muted-foreground', icon: <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> },
  DRAFT: { label: 'Ready to send for approval', tone: 'text-foreground', icon: <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> },
  PENDING: { label: 'Waiting for WhatsApp', tone: 'text-amber-600', icon: <Clock className="h-3.5 w-3.5" aria-hidden="true" /> },
  APPROVED: { label: 'Approved', tone: 'text-emerald-600', icon: <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> },
  REJECTED: { label: 'Rejected', tone: 'text-destructive', icon: <XCircle className="h-3.5 w-3.5" aria-hidden="true" /> },
  PAUSED: { label: 'Paused by WhatsApp', tone: 'text-destructive', icon: <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" /> },
  DISABLED: { label: 'Turned off by WhatsApp', tone: 'text-destructive', icon: <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" /> },
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
  const toSend = (data?.templates ?? []).filter((t) => t.status === 'DRAFT' || t.status === 'REJECTED').length;
  const drafts = (data?.templates ?? []).filter((t) => t.status === 'DRAFT').length;
  const hasAny = (data?.templates.length ?? 0) > 0;

  async function write(languages?: string[]) {
    try {
      const r = await draft.mutateAsync(languages ? { languages } : undefined);
      if (r.problems.length) {
        toast.warning('Some messages could not be written', {
          description: r.problems.map((p) => `${languageName(p.language)} ${KIND_LABEL[p.kind as 'first' | 'followup'] ?? p.kind}: ${p.issues.join(' ')}`).join('\n'),
        });
      } else if (r.saved > 0) {
        toast.success('Your messages are written', { description: 'Read them, then send them for approval.' });
      } else if (r.kept.length) {
        toast.message('Nothing to write', { description: 'Those messages are already with WhatsApp.' });
      }
    } catch (e) {
      toast.error(errorMessage(e, 'Could not write the messages.'));
    }
  }

  async function send() {
    try {
      const r = await submit.mutateAsync(undefined);
      const failed = r.results.filter((x) => !x.ok);
      const okCount = r.results.length - failed.length;
      if (okCount) toast.success(`${okCount} message${okCount === 1 ? '' : 's'} sent to WhatsApp for approval`, { description: 'This usually takes from a few minutes to a day. We will use them as soon as they are approved.' });
      if (failed.length) toast.error('Some messages were not sent', { description: failed.map((f) => `${languageName(f.language)} ${KIND_LABEL[f.kind as 'first' | 'followup'] ?? f.kind}: ${f.error}`).join('\n') });
    } catch (e) {
      toast.error(errorMessage(e, 'Could not send the messages.'));
    }
  }

  async function check() {
    try {
      const r = await refresh.mutateAsync();
      toast.message(r.changed ? `${r.changed} message${r.changed === 1 ? '' : 's'} got an answer` : 'No news yet', { description: r.checked ? undefined : 'Nothing is waiting for WhatsApp.' });
    } catch (e) {
      toast.error(errorMessage(e, 'Could not check.'));
    }
  }

  const addable = LANGUAGES.filter((l) => !(data?.languages ?? []).some((x) => x.language === l));

  return (
    <section className="glass rounded-2xl p-5 space-y-4" aria-labelledby="wa-messages-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="wa-messages-title" className="flex items-center gap-2 text-base font-semibold">
            <MessageCircle className="h-4 w-4 text-primary" aria-hidden="true" /> WhatsApp messages
          </h2>
          <p className="mt-1 max-w-xl text-xs text-muted-foreground">
            WhatsApp only lets a business start a chat with messages it has approved. We write them for you from your business profile and
            get them approved. You do not copy anything between accounts.
          </p>
        </div>
        {canManage && data && (
          <div className="flex flex-wrap gap-2">
            {hasAny && (
              <button type="button" className="btn-ghost text-xs" onClick={check} disabled={busy}>
                {refresh.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
                Check status
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={() => write()} disabled={busy}>
              {draft.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
              {hasAny ? 'Rewrite my messages' : 'Write my messages'}
            </button>
            {toSend > 0 && (
              <button type="button" className="btn-primary" onClick={send} disabled={busy || !data.connected}>
                {submit.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
                Send for approval
              </button>
            )}
          </div>
        )}
      </div>

      {view.isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />}
      {view.error && <p role="alert" className="text-sm text-destructive">{errorMessage(view.error, 'Could not load your WhatsApp messages.')}</p>}

      {data && !data.connected && (
        <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          Connect WhatsApp above first: it is how the messages are sent to WhatsApp for approval.
        </p>
      )}
      {data && !hasAny && (
        <p className="text-sm text-muted-foreground">
          Nothing written yet. “Write my messages” creates a first message and a follow-up in {data.suggested_languages.map(languageName).join(', ')}.
        </p>
      )}
      {drafts > 0 && data?.connected && (
        <p className="text-xs text-muted-foreground">Read them first: you can change any wording. When you are happy, “Send for approval”.</p>
      )}

      {data?.languages.map((l) => (
        <LanguageBlock key={l.language} readiness={l} templates={data.templates.filter((t) => t.language === l.language)} canManage={canManage} onRewrite={() => write([l.language])} busy={busy} />
      ))}

      {canManage && data && hasAny && addable.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <label htmlFor="wa-add-language" className="text-xs text-muted-foreground">Also write them in</label>
          <select id="wa-add-language" className="input h-8 w-auto py-0 text-xs" value={extra} onChange={(e) => setExtra(e.target.value)}>
            <option value="">choose a language…</option>
            {addable.map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
          </select>
          <button type="button" className="btn-ghost text-xs" disabled={!extra || busy} onClick={() => { void write([extra]); setExtra(''); }}>Add</button>
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
          ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Ready to send</span>
          : <span className="text-xs text-muted-foreground">Needs both messages approved</span>}
      </div>
      {(['first', 'followup'] as const).map((kind) => {
        const t = templates.find((x) => x.kind === kind);
        return t
          ? <TemplateItem key={kind} t={t} canManage={canManage} onRewrite={onRewrite} busy={busy} />
          : <div key={kind} className="flex items-center justify-between text-sm"><span>{KIND_LABEL[kind]}</span><Badge status={null} /></div>;
      })}
    </div>
  );
}

function TemplateItem({ t, canManage, onRewrite, busy }: { t: WhatsAppTemplate; canManage: boolean; onRewrite: () => void; busy: boolean }): React.ReactElement {
  const edit = useEditTemplate();
  const remove = useRemoveTemplate();
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(t.body);
  const [issues, setIssues] = React.useState<string[]>([]);
  const editable = t.status === 'DRAFT' || t.status === 'REJECTED';

  async function save() {
    try {
      const r = await edit.mutateAsync({ id: t.id, body: text });
      setIssues(r.issues);
      setEditing(false);
    } catch (e) {
      setIssues([errorMessage(e, 'Could not save.')]);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{KIND_LABEL[t.kind]}</span>
        <Badge status={t.status} />
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea className="input min-h-[7rem] w-full text-sm" value={text} onChange={(e) => setText(e.target.value)} maxLength={1024} aria-label={`${KIND_LABEL[t.kind]} text`} />
          <p className="text-xs text-muted-foreground">Keep <code>{'{{1}}'}</code> (first name) and <code>{'{{2}}'}</code> (their company) and the “Reply STOP” line.</p>
          {issues.length > 0 && <ul role="alert" className="list-disc pl-5 text-xs text-destructive">{issues.map((i) => <li key={i}>{i}</li>)}</ul>}
          <div className="flex gap-2">
            <button type="button" className="btn-primary text-xs" onClick={save} disabled={edit.isPending}>Save</button>
            <button type="button" className="btn-ghost text-xs" onClick={() => { setEditing(false); setText(t.body); setIssues([]); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-sm leading-relaxed">{t.body}</p>
      )}
      {t.status === 'REJECTED' && (
        <p role="alert" className="text-xs text-destructive">WhatsApp said: {t.rejection_reason || 'no reason given'}. Change the wording or let the AI rewrite it, then send it again.</p>
      )}
      {(t.status === 'PAUSED' || t.status === 'DISABLED') && (
        <p role="alert" className="text-xs text-destructive">WhatsApp stopped this message{t.rejection_reason ? `: ${t.rejection_reason}` : ''}. It is not being used.</p>
      )}
      {canManage && editable && !editing && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost text-xs" onClick={() => { setText(t.body); setEditing(true); }}><Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Edit</button>
          {t.status === 'REJECTED' && (
            <button type="button" className="btn-ghost text-xs" onClick={onRewrite} disabled={busy}><Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> Rewrite with AI</button>
          )}
          <button type="button" className="btn-ghost text-xs" onClick={() => remove.mutate(t.id)} disabled={remove.isPending}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Remove</button>
        </div>
      )}
    </div>
  );
}
