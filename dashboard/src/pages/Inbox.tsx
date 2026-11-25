/**
 * Inbox — the unified reply feed across email, LinkedIn, and WhatsApp.
 *
 * Left: conversation list (newest first, unread = last message inbound).
 * Right: the selected thread, chronological, with prospect context.
 *
 * All powered by conversations + conversation_messages, which the reply
 * detectors populate for every inbound reply / WhatsApp / LinkedIn msg.
 */

import { Loader2, Mail, MessageSquare, Briefcase, Inbox as InboxIcon } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '../components/ui/page-header';
import {
  useInbox,
  useInboxThread,
  type InboxConversation,
} from '../hooks/useInbox';
import { formatDateTime } from '../lib/format';

const CHANNEL_META: Record<
  string,
  { icon: React.ReactNode; label: string; color: string }
> = {
  email: { icon: <Mail className="h-3.5 w-3.5" />, label: 'Email', color: 'text-sky-500' },
  linkedin: { icon: <Briefcase className="h-3.5 w-3.5" />, label: 'LinkedIn', color: 'text-[#0a66c2]' },
  whatsapp: { icon: <MessageSquare className="h-3.5 w-3.5" />, label: 'WhatsApp', color: 'text-emerald-500' },
};

function ChannelChip({ channel }: { channel: string }) {
  const m = CHANNEL_META[channel] ?? CHANNEL_META.email;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${m.color}`}>
      {m.icon} {m.label}
    </span>
  );
}

export default function Inbox(): React.ReactElement {
  const [channel, setChannel] = React.useState<
    'all' | 'email' | 'linkedin' | 'whatsapp'
  >('all');
  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const [selected, setSelected] = React.useState<string | undefined>(undefined);

  const list = useInbox({
    channel: channel === 'all' ? undefined : channel,
    unread: unreadOnly,
  });
  const thread = useInboxThread(selected);

  const conversations = list.data?.conversations ?? [];

  return (
    <div>
      <PageHeader
        eyebrow="Conversations"
        title="Inbox"
        description="Every reply across email, LinkedIn, and WhatsApp — in one feed."
        icon={InboxIcon}
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {(['all', 'email', 'linkedin', 'whatsapp'] as const).map((c) => (
          <button
            key={c}
            onClick={() => setChannel(c)}
            className={`text-xs px-3 h-8 rounded-full border transition-colors ${
              channel === c
                ? 'bg-brand text-white border-brand'
                : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >
            {c === 'all' ? 'All channels' : CHANNEL_META[c].label}
          </button>
        ))}
        <label className="ml-2 flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.target.checked)}
          />
          Needs reply only
          {list.data?.unread ? (
            <span className="ml-1 rounded-full bg-rose-500 text-white text-[10px] px-1.5 py-0.5">
              {list.data.unread}
            </span>
          ) : null}
        </label>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(320px,420px)_1fr] gap-4">
        {/* Conversation list */}
        <div className="glass rounded-xl overflow-hidden">
          {list.isLoading ? (
            <div className="p-8 flex justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : conversations.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No conversations yet. Replies land here automatically as
              prospects respond.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 max-h-[70vh] overflow-y-auto">
              {conversations.map((c) => (
                <ConversationRow
                  key={c.conversation_id}
                  c={c}
                  active={selected === c.contact_id}
                  onClick={() => setSelected(c.contact_id)}
                />
              ))}
            </ul>
          )}
        </div>

        {/* Thread */}
        <div className="glass rounded-xl min-h-[400px]">
          {!selected ? (
            <div className="h-full flex items-center justify-center p-8 text-sm text-muted-foreground">
              Select a conversation to view the thread.
            </div>
          ) : thread.isLoading ? (
            <div className="p-8 flex justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ThreadView thread={thread.data} />
          )}
        </div>
      </div>
    </div>
  );
}

function ConversationRow({
  c,
  active,
  onClick,
}: {
  c: InboxConversation;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        onClick={onClick}
        className={`w-full text-left px-4 py-3 transition-colors ${
          active ? 'bg-brand-light/60' : 'hover:bg-slate-50'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-sm text-slate-800 truncate">
            {c.full_name}
            {c.needs_reply && (
              <span className="ml-2 inline-block h-2 w-2 rounded-full bg-rose-500 align-middle" />
            )}
          </span>
          <span className="text-[10px] text-slate-400 shrink-0">
            {c.last_message_at ? formatDateTime(c.last_message_at) : ''}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <ChannelChip channel={c.channel} />
          <span className="text-[11px] text-slate-400 truncate">
            {c.company_name} · {c.campaign_name}
          </span>
        </div>
        {c.last_body && (
          <div className="text-xs text-slate-500 mt-1 truncate">
            {c.last_direction === 'inbound' ? '↩ ' : '→ '}
            {c.last_body.replace(/\s+/g, ' ').slice(0, 90)}
          </div>
        )}
      </button>
    </li>
  );
}

function ThreadView({
  thread,
}: {
  thread: ReturnType<typeof useInboxThread>['data'];
}) {
  if (!thread?.contact) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        Conversation not found.
      </div>
    );
  }
  const ct = thread.contact;
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-slate-100 p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-semibold text-slate-800">{ct.full_name}</div>
            <div className="text-xs text-slate-500">
              {ct.title} · {ct.company_name} {ct.country ? `· ${ct.country}` : ''}
            </div>
          </div>
          <div className="text-right text-[11px] text-slate-400">
            <div>{ct.campaign_name}</div>
            <div className="uppercase tracking-wide">{ct.prospect_status}</div>
            {ct.service_line && (
              <div className="text-slate-500">
                {ct.service_line.replace('_', ' ')}
                {ct.market_tier ? ` · tier ${ct.market_tier}` : ''}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 max-h-[56vh]">
        {thread.messages.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-8">
            No messages recorded on this thread yet.
          </div>
        ) : (
          thread.messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${
                m.direction === 'inbound' ? 'justify-start' : 'justify-end'
              }`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm ${
                  m.direction === 'inbound'
                    ? 'bg-slate-100 text-slate-800'
                    : 'bg-brand text-white'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-0.5 opacity-70 text-[10px]">
                  <ChannelChip channel={m.channel} />
                  <span>{formatDateTime(m.sent_at)}</span>
                </div>
                <div className="whitespace-pre-wrap leading-relaxed">
                  {m.body}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Reply hint (manual for now) */}
      <div className="border-t border-slate-100 p-3 text-[11px] text-slate-400">
        Reply from your{' '}
        {ct.email && (
          <a href={`mailto:${ct.email}`} className="text-brand underline">
            email
          </a>
        )}
        {ct.linkedin_url && (
          <>
            {' · '}
            <a
              href={ct.linkedin_url}
              target="_blank"
              rel="noreferrer"
              className="text-brand underline"
            >
              LinkedIn
            </a>
          </>
        )}
        {ct.whatsapp_number && <> · WhatsApp {ct.whatsapp_number}</>}
        . Inbound replies are captured automatically.
      </div>
    </div>
  );
}
