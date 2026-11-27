/**
 * Answering replies: the company's choice of how the assistant answers, and what a person does with one
 * conversation (send or change the draft, write their own, take over, hand back).
 */

import { Bot, Loader2, Send, Trash2, UserRound } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { useConversationState, useDiscardDraft, useSendReply, type ConversationState } from '../../hooks/useInbox';
import { useOrganization, useUpdateOrganization } from '../../hooks/useWorkspace';
import { msg, t } from '../../i18n';
import { errorMessage, useAuth } from '../../lib/authContext';
import { cn } from '../../lib/cn';

export type ReplyMode = 'off' | 'draft' | 'auto';

const MODES: Array<{ value: ReplyMode; title: string; text: string }> = [
  { value: 'draft', title: msg('Draft for me'), text: msg('The assistant writes an answer. Nothing is sent until you press Send.') },
  { value: 'auto', title: msg('Answer automatically'), text: msg('The assistant answers routine replies itself and says it is automatic. Calls, prices, complaints and anything it is unsure about come to you.') },
  { value: 'off', title: msg('Off'), text: msg('Replies are collected here. You answer them yourself.') },
];

/** Why a conversation is waiting for a person (orchestrator agents/conversation_agent.py, scripts/answer_replies.py). */
const REASONS: Record<string, string> = {
  approve: msg('A draft is ready: read it and send it.'),
  call_request: msg('They want a call. Agree a time with them.'),
  pricing: msg('They asked about price or terms.'),
  complaint: msg('They sound unhappy or raised a concern.'),
  other: msg('This one needs a person.'),
  unsure: msg('The assistant was not sure how to answer.'),
  check: msg('Check the draft before sending: it contains something the assistant could not confirm.'),
  many_replies: msg('The assistant has answered several times in a row: take a look.'),
  campaign_paused: msg('The campaign is not running, so nothing was sent.'),
  ai_unavailable: msg('The AI is not available for your company right now.'),
  ai_failed: msg('The assistant could not write an answer.'),
  whatsapp_window: msg('More than 24 hours have passed on WhatsApp: only an approved template can be sent.'),
  channel: msg('Answer this one on LinkedIn.'),
  taken_over: msg('A new message in a conversation you are handling.'),
};

export const reasonText = (code: string): string => t(REASONS[code] ?? REASONS.other);

export function ReplyModeCard(): React.ReactElement | null {
  const { user, bypassMode } = useAuth();
  const org = useOrganization();
  const update = useUpdateOrganization();
  const canChange = bypassMode || !user?.role || user.role === 'owner' || user.role === 'admin';
  const mode = org.data?.reply_mode;
  if (!mode) return null;

  async function choose(value: ReplyMode) {
    try {
      await update.mutateAsync({ reply_mode: value });
      toast.success(t('Saved'));
    } catch (e) {
      toast.error(errorMessage(e, t('Could not save that.')));
    }
  }

  return (
    <fieldset className="glass mb-4 rounded-xl p-4" disabled={!canChange || update.isPending}>
      <legend className="sr-only">{t('How replies are answered')}</legend>
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Bot className="h-4 w-4 text-primary" aria-hidden="true" />
        {t('How replies are answered')}
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {MODES.map((m) => (
          <label key={m.value} className={cn('flex items-start gap-2.5 rounded-lg border p-3', canChange && 'cursor-pointer',
            mode === m.value ? 'border-primary bg-primary/5' : 'border-border')}>
            <input type="radio" name="reply-mode" className="mt-1 accent-[hsl(var(--primary))]" checked={mode === m.value} onChange={() => choose(m.value)} />
            <span>
              <span className="block text-sm font-medium">{t(m.title)}</span>
              <span className="block text-xs text-muted-foreground">{t(m.text)}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** What a person can do with one conversation. */
export function ReplyBox({ state }: { state: ConversationState }): React.ReactElement | null {
  const { user, bypassMode } = useAuth();
  const send = useSendReply();
  const discard = useDiscardDraft();
  const change = useConversationState();
  const [text, setText] = React.useState(state.draft_body ?? '');
  // A new draft replaces what is in the box; typing is never overwritten by a refresh of the same one.
  React.useEffect(() => { setText(state.draft_body ?? ''); }, [state.draft_id, state.conversation_id]);
  const canWrite = bypassMode || user?.role !== 'viewer';
  const sendable = state.channel === 'email' || state.channel === 'whatsapp';
  const busy = send.isPending || discard.isPending || change.isPending;

  const run = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work();
      toast.success(done);
    } catch (e) {
      toast.error(errorMessage(e, t('Could not save that.')));
    }
  };

  return (
    <div className="space-y-2 border-t border-border/60 p-3">
      {state.needs_person_reason && (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
          <UserRound className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span><strong>{t('Needs you')}: </strong>{reasonText(state.needs_person_reason)}</span>
        </p>
      )}
      {canWrite && sendable && (
        <>
          <label className="label" htmlFor={`reply-${state.conversation_id}`}>
            {state.draft_id ? t('Draft answer from the assistant') : t('Your answer')}
          </label>
          <textarea id={`reply-${state.conversation_id}`} className="input min-h-[6rem] w-full text-sm" dir="auto" maxLength={4000}
            value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary text-xs" disabled={busy || !text.trim()}
              onClick={() => run(async () => { await send.mutateAsync({ id: state.conversation_id, body: text.trim(), draftId: state.draft_id ?? undefined }); setText(''); },
                t('Your answer is queued: it goes out within a few minutes.'))}>
              {send.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Send className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden="true" />}
              {t('Send answer')}
            </button>
            {state.draft_id && (
              <button type="button" className="btn-ghost text-xs" disabled={busy}
                onClick={() => run(async () => { await discard.mutateAsync({ id: state.conversation_id, draftId: state.draft_id! }); setText(''); }, t('Draft removed'))}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> {t('Discard draft')}
              </button>
            )}
          </div>
        </>
      )}
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          {state.needs_person_reason && (
            <button type="button" className="btn-secondary text-xs" disabled={busy}
              onClick={() => run(() => change.mutateAsync({ id: state.conversation_id, handled: true }), t('Marked as handled'))}>
              {t('Mark as handled')}
            </button>
          )}
          {state.handled_by === 'ai' ? (
            <button type="button" className="btn-ghost text-xs" disabled={busy}
              onClick={() => run(() => change.mutateAsync({ id: state.conversation_id, handled_by: 'person' }), t('The assistant will stay out of this conversation.'))}>
              {t('I will handle this one')}
            </button>
          ) : (
            <button type="button" className="btn-ghost text-xs" disabled={busy}
              onClick={() => run(() => change.mutateAsync({ id: state.conversation_id, handled_by: 'ai' }), t('The assistant will help with this conversation again.'))}>
              {t('Let the assistant help again')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
