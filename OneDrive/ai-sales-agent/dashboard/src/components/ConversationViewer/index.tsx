/**
 * ConversationViewer — modal with:
 *   Left:  contact + company details + pitch scores + enrichment
 *   Right: chronological message thread across all channels
 *   Foot:  "Regenerate reply" button (wired but endpoint pending)
 */

import { useState } from 'react';

import { formatDateTime } from '../../lib/format';
import type { Contact, Prospect } from '../../lib/types';
import { useConversation, useRegenerateReply } from '../../hooks/useProspects';
import Modal from '../Modal';
import PitchBadge from '../PitchBadge';

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

  async function onRegenerate() {
    if (!contact) return;
    setRegenError(null);
    setRegenText(null);
    try {
      const result = await regenerate.mutateAsync(contact.id);
      setRegenText(result.text);
    } catch (err) {
      const msg = (err as Error).message || 'failed';
      setRegenError(`regenerate failed: ${msg}`);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Conversation" size="xl">
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
                    <div className="text-xs uppercase text-slate-400 mb-1">Company</div>
                    <div className="text-sm font-medium text-slate-800">
                      {prospect.company_name}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {prospect.industry ?? '—'} · {prospect.company_size ?? '—'} · {prospect.country ?? '—'}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs uppercase text-slate-400 mb-1">Pitch</div>
                    <PitchBadge pitch={prospect.pitch_type} />
                    {prospect.pitch_scores && (
                      <div className="mt-2 text-xs text-slate-600 space-y-0.5">
                        <div>AI agents: <span className="font-mono">{prospect.pitch_scores.ai_agents}</span></div>
                        <div>RPA: <span className="font-mono">{prospect.pitch_scores.rpa_workflow}</span></div>
                        <div>Consulting: <span className="font-mono">{prospect.pitch_scores.consulting}</span></div>
                      </div>
                    )}
                  </div>

                  {prospect.enrichment_data && Object.keys(prospect.enrichment_data).length > 0 && (
                    <div>
                      <div className="text-xs uppercase text-slate-400 mb-1">Enrichment</div>
                      <pre className="text-[11px] bg-white border border-slate-200 rounded p-2 overflow-auto max-h-40 text-slate-700">
                        {JSON.stringify(prospect.enrichment_data, null, 2)}
                      </pre>
                    </div>
                  )}
                </>
              )}

              <div className="pt-2 border-t border-slate-200 text-xs text-slate-500 space-y-1">
                <div>Email: {contact.email ?? '—'}</div>
                <div>LinkedIn: {contact.linkedin_urn ?? '—'}</div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-slate-400">No contact selected.</div>
          )}
        </div>

        {/* RIGHT: thread */}
        <div className="col-span-8 p-5 flex flex-col">
          {isLoading && <div className="text-sm text-slate-400">Loading thread…</div>}
          {!isLoading && data && data.messages.length === 0 && (
            <div className="text-sm text-slate-400">No messages in this thread yet.</div>
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
                  <span className="font-medium uppercase">{msg.channel}</span>
                  <span>{msg.direction === 'outbound' ? '→' : '←'}</span>
                  <span>{formatDateTime(msg.sent_at)}</span>
                  <span className="ml-auto text-slate-400">{msg.status}</span>
                </div>
                {msg.subject && (
                  <div className="font-medium text-slate-800 mb-1">{msg.subject}</div>
                )}
                <div className="text-sm text-slate-700 whitespace-pre-wrap">{msg.body}</div>
              </div>
            ))}
          </div>

          <div className="border-t border-slate-200 pt-3 mt-3 space-y-2">
            {regenText && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-slate-700 whitespace-pre-wrap">
                <div className="text-xs uppercase text-emerald-700 font-medium mb-1">
                  Regenerated reply
                </div>
                {regenText}
              </div>
            )}
            {regenError && (
              <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
                {regenError}
                <div className="mt-1 text-rose-500">
                  (regenerate-reply endpoint is not yet implemented in the API — see project memory)
                </div>
              </div>
            )}
            <button
              onClick={onRegenerate}
              disabled={regenerate.isPending || !contact}
              className="btn-secondary"
            >
              {regenerate.isPending ? 'Regenerating…' : 'Regenerate reply'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
