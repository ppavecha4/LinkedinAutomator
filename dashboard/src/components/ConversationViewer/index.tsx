/**
 * ConversationViewer — modal with:
 *   Left:  contact + company details + pitch scores + enrichment
 *   Right: chronological message thread across all channels
 *   Foot:  "Regenerate reply" button (wired but endpoint pending)
 */

import {
  Briefcase,
  CheckCircle2,
  Eye,
  Inbox,
  UserCheck,
  UserMinus,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { label } from '../../lib/labels';
import { t } from '../../i18n';
import { useConversation, useRegenerateReply } from '../../hooks/useProspects';
import { useProspectTimeline, useRecordEvent } from '../../hooks/useTimeline';
import { formatDateTime } from '../../lib/format';
import type { Contact, Prospect } from '../../lib/types';
import Modal from '../Modal';
import PitchBadge from '../PitchBadge';
import { ProspectTimeline } from '../ProspectTimeline';

interface Props {
  open: boolean;
  onClose: () => void;
  contact: Contact | null;
  prospect?: Prospect | null;
}

const CHANNEL_ICON: Record<string, string> = {
  email: '📧',
  linkedin: '💼',
  whatsapp: '💬',
};

export default function ConversationViewer({ open, onClose, contact, prospect }: Props) {
  const { data, isLoading } = useConversation(open && contact ? contact.id : undefined);
  const regenerate = useRegenerateReply();
  const [regenError, setRegenError] = useState<string | null>(null);
  const [regenText, setRegenText] = useState<string | null>(null);

  // Timeline data + manual-event recorder.
  const { data: timeline, isLoading: timelineLoading } = useProspectTimeline(
    open && contact ? contact.id : undefined,
  );
  const recordEvent = useRecordEvent();

  const fireEvent = (
    type: Parameters<typeof recordEvent.mutate>[0]['event_type'],
    channel: 'email' | 'linkedin' | 'whatsapp' | undefined,
    label: string,
  ) => {
    if (!contact) return;
    recordEvent.mutate(
      { contactId: contact.id, event_type: type, channel },
      {
        onSuccess: () => toast.success(t('{label} recorded', { label })),
        onError: (e) =>
          toast.error(t('Failed: {message}', { message: (e as Error).message ?? t('unknown error') })),
      },
    );
  };

  async function onRegenerate() {
    if (!contact) return;
    setRegenError(null);
    setRegenText(null);
    try {
      const result = await regenerate.mutateAsync(contact.id);
      setRegenText(result.text);
    } catch (err) {
      setRegenError(t('Could not write it again: {message}', { message: (err as Error).message || t('unknown error') }));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('Conversation')} size="xl">
      <div className="grid grid-cols-12 divide-x divide-slate-200 min-h-[60vh]">
        {/* LEFT: contact + company + pitch */}
        <div className="col-span-4 p-5 bg-slate-50">
          {contact ? (
            <div className="space-y-4">
              <div>
                <div className="text-lg font-semibold text-slate-800">
                  {contact.full_name}
                </div>
                <div className="text-sm text-slate-500">{contact.title ?? '—'}</div>
              </div>

              {prospect && (
                <>
                  <div>
                    <div className="text-xs uppercase text-slate-400 mb-1">{t('Company')}</div>
                    <div className="text-sm font-medium text-slate-800">
                      {prospect.company_name}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {prospect.industry ?? '—'} · {prospect.company_size ?? '—'} · {prospect.country ?? '—'}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs uppercase text-slate-400 mb-1">{t('Pitch')}</div>
                    <PitchBadge pitch={prospect.pitch_type} />
                    {prospect.pitch_scores && (
                      <div className="mt-2 text-xs text-slate-600 space-y-0.5">
                        <div>{t('AI agents:')}{' '}<span className="font-mono">{prospect.pitch_scores.ai_agents}</span></div>
                        <div>{t('RPA:')}{' '}<span className="font-mono">{prospect.pitch_scores.rpa_workflow}</span></div>
                        <div>{t('Consulting:')}{' '}<span className="font-mono">{prospect.pitch_scores.consulting}</span></div>
                      </div>
                    )}
                  </div>

                  {prospect.enrichment_data && Object.keys(prospect.enrichment_data).length > 0 && (
                    <div>
                      <div className="text-xs uppercase text-slate-400 mb-1">{t('Enrichment')}</div>
                      <pre className="text-[11px] bg-white border border-slate-200 rounded p-2 overflow-auto max-h-40 text-slate-700">
                        {JSON.stringify(prospect.enrichment_data, null, 2)}
                      </pre>
                    </div>
                  )}
                </>
              )}

              <div className="pt-2 border-t border-slate-200 text-xs text-slate-500 space-y-1">
                <div>{t('Email: {value}', { value: contact.email ?? '—' })}</div>
                <div>{t('LinkedIn: {value}', { value: contact.linkedin_urn ?? '—' })}</div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-slate-400">{t('No contact selected.')}</div>
          )}
        </div>

        {/* RIGHT: thread */}
        <div className="col-span-8 p-5 flex flex-col">
          {isLoading && <div className="text-sm text-slate-400">{t('Loading thread…')}</div>}
          {!isLoading && data && data.messages.length === 0 && (
            <div className="text-sm text-slate-400">{t('No messages in this thread yet.')}</div>
          )}
          <div className="flex-1 space-y-3 overflow-auto">
            {data?.messages.map((msg) => (
              <div
                key={msg.id}
                className={`rounded-md border p-3 ${
                  msg.direction === 'outbound'
                    ? 'bg-blue-50 border-blue-200'
                    : 'bg-white border-slate-200'
                }`}
              >
                <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                  <span>{CHANNEL_ICON[msg.channel] ?? '•'}</span>
                  <span className="font-medium uppercase">{label(msg.channel)}</span>
                  <span>{msg.direction === 'outbound' ? '→' : '←'}</span>
                  <span>{formatDateTime(msg.sent_at)}</span>
                  <span className="ms-auto text-slate-400">{label(msg.status)}</span>
                </div>
                {msg.subject && (
                  <div className="font-medium text-slate-800 mb-1">{msg.subject}</div>
                )}
                <div className="text-sm text-slate-700 whitespace-pre-wrap">{msg.body}</div>
              </div>
            ))}
          </div>

          {/* Manual event recording. LinkedIn (no webhook for non-Sales-Nav
              apps), Email (no SES/Workspace open-pixel wired yet), and
              WhatsApp (no Twilio status callback wired) all require the
              operator to mark events by hand. These buttons fire one event
              per click and toast on success. */}
          <div className="border-t border-slate-200 pt-3 mt-3">
            <div className="text-xs uppercase text-slate-400 mb-2">
              {t('Record event for this prospect')}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                className="btn-ghost text-xs h-7 px-2"
                disabled={recordEvent.isPending || !contact}
                onClick={() =>
                  fireEvent('connection_accepted', 'linkedin', t('Connection accepted'))
                }
              >
                <UserCheck className="h-3 w-3" />
                {t('Connection accepted')}
              </button>
              <button
                className="btn-ghost text-xs h-7 px-2"
                disabled={recordEvent.isPending || !contact}
                onClick={() =>
                  fireEvent('message_opened', undefined, t('Marked as opened'))
                }
              >
                <Eye className="h-3 w-3" />
                {t('Marked opened')}
              </button>
              <button
                className="btn-ghost text-xs h-7 px-2"
                disabled={recordEvent.isPending || !contact}
                onClick={() =>
                  fireEvent('message_replied', undefined, t('Reply received'))
                }
              >
                <Inbox className="h-3 w-3" />
                {t('Reply received')}
              </button>
              <button
                className="btn-ghost text-xs h-7 px-2"
                disabled={recordEvent.isPending || !contact}
                onClick={() =>
                  fireEvent('meeting_booked', undefined, t('Meeting booked'))
                }
              >
                <CheckCircle2 className="h-3 w-3" />
                {t('Meeting booked')}
              </button>
              <button
                className="btn-ghost text-xs h-7 px-2 text-rose-600"
                disabled={recordEvent.isPending || !contact}
                onClick={() => fireEvent('opted_out', undefined, t('Opted out'))}
              >
                <UserMinus className="h-3 w-3" />
                {t('Opted out')}
              </button>
            </div>
          </div>

          {/* Timeline — what we know happened, newest first. */}
          <div className="border-t border-slate-200 pt-3 mt-3">
            <div className="text-xs uppercase text-slate-400 mb-2 flex items-center gap-1">
              <Briefcase className="h-3 w-3" />
              {t('Lifecycle timeline')}
            </div>
            <ProspectTimeline
              events={timeline}
              isLoading={timelineLoading}
              className="text-xs"
            />
          </div>

          <div className="border-t border-slate-200 pt-3 mt-3 space-y-2">
            {regenText && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-slate-700 whitespace-pre-wrap">
                <div className="text-xs uppercase text-emerald-700 font-medium mb-1">
                  {t('Regenerated reply')}
                </div>
                {regenText}
              </div>
            )}
            {regenError && (
              <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
                {regenError}
                <div className="mt-1 text-rose-500">
                  {t('(regenerate-reply endpoint is not yet implemented in the API — see project memory)')}
                </div>
              </div>
            )}
            <button
              onClick={onRegenerate}
              disabled={regenerate.isPending || !contact}
              className="btn-secondary"
            >
              {regenerate.isPending ? t('Regenerating…') : t('Regenerate reply')}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
