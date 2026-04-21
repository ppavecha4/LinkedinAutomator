/**
 * Settings page — company profile, connected channels, compliance.
 *
 * The API has no /api/settings yet, so this page persists nothing — it
 * mirrors spec layout and surfaces the static integration state. Tracked
 * in project memory to wire real endpoints in a later session.
 */

import {
  Calendar,
  Briefcase,
  Mail,
  MessageCircle,
  Settings as SettingsIcon,
  Shield,
  User,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';

import { PageHeader } from '../components/ui/page-header';

interface ChannelCard {
  label: string;
  icon: LucideIcon;
  status: 'connected' | 'pending' | 'not_connected';
  statusLabel: string;
  tone: 'amber' | 'emerald' | 'muted';
  lines: string[];
}

const CHANNEL_CARDS: ChannelCard[] = [
  {
    label: 'Email (SES)',
    icon: Mail,
    status: 'pending',
    statusLabel: 'Verification pending',
    tone: 'amber',
    lines: [
      'Sender domain: not yet verified',
      'Bounce rate: —',
      'Complaint rate: —',
    ],
  },
  {
    label: 'LinkedIn',
    icon: Briefcase,
    status: 'not_connected',
    statusLabel: 'Not connected',
    tone: 'muted',
    lines: [
      'OAuth token: missing',
      'Connection quota this week: —',
      'Messages sent this week: —',
    ],
  },
  {
    label: 'WhatsApp',
    icon: MessageCircle,
    status: 'not_connected',
    statusLabel: 'Not connected',
    tone: 'muted',
    lines: [
      'Business account: —',
      'Message quality rating: —',
      'Templates approved: —',
    ],
  },
  {
    label: 'Calendly',
    icon: Calendar,
    status: 'not_connected',
    statusLabel: 'Not connected',
    tone: 'muted',
    lines: [
      'Event type: —',
      'Meetings booked this month: —',
      'Webhook signing key: check env',
    ],
  },
];

const TONE_CLASS: Record<
  ChannelCard['tone'],
  { icon: string; dot: string; label: string }
> = {
  amber: {
    icon: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500',
    label: 'text-amber-600 dark:text-amber-400',
  },
  emerald: {
    icon: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
    label: 'text-emerald-600 dark:text-emerald-400',
  },
  muted: {
    icon: 'bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground/60',
    label: 'text-muted-foreground',
  },
};

export default function Settings() {
  const [senderName, setSenderName] = useState('');
  const [senderCompany, setSenderCompany] = useState('');
  const [valueProp, setValueProp] = useState('');
  const [optOutMessage, setOptOutMessage] = useState(
    "Got it — you won't hear from me again. Thanks for letting me know.",
  );
  const [limits, setLimits] = useState({ email: 100, linkedin: 20, whatsapp: 50 });

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Workspace"
        title="Settings"
        description="Company profile, channel connections, compliance defaults, and API key locations."
        icon={SettingsIcon}
      />

      {/* Company profile */}
      <section className="glass rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <User className="h-4 w-4" />
          </div>
          <h2 className="text-base font-semibold">Company profile</h2>
        </div>
        <p className="text-xs text-muted-foreground mb-5 ml-10">
          Defaults prefill the campaign wizard. Persistence pending the
          backend settings endpoint.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Sender name</label>
            <input
              className="input"
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              placeholder="Priya"
            />
          </div>
          <div>
            <label className="label">Sender company</label>
            <input
              className="input"
              value={senderCompany}
              onChange={(e) => setSenderCompany(e.target.value)}
              placeholder="WeBuildAgents Inc"
            />
          </div>
          <div className="md:col-span-2">
            <label className="label">Default value proposition</label>
            <textarea
              className="input min-h-[110px]"
              value={valueProp}
              onChange={(e) => setValueProp(e.target.value)}
              placeholder="We ship AI agents that own a specific decision end-to-end…"
            />
          </div>
        </div>
      </section>

      {/* Connected channels */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
          Connected channels
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {CHANNEL_CARDS.map((card) => {
            const t = TONE_CLASS[card.tone];
            const Icon = card.icon;
            return (
              <div
                key={card.label}
                className="glass rounded-2xl p-5 hover:shadow-lg transition-all"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex h-10 w-10 items-center justify-center rounded-xl ${t.icon}`}
                    >
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="font-semibold text-foreground">
                        {card.label}
                      </div>
                      <div
                        className={`flex items-center gap-1.5 text-[11px] uppercase tracking-wider ${t.label}`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
                        {card.statusLabel}
                      </div>
                    </div>
                  </div>
                </div>
                <ul className="text-xs space-y-1 text-muted-foreground">
                  {card.lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      {/* Compliance */}
      <section className="glass rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-500">
            <Shield className="h-4 w-4" />
          </div>
          <h2 className="text-base font-semibold">Compliance</h2>
        </div>
        <p className="text-xs text-muted-foreground mb-5 ml-10">
          Default daily limits and opt-out messaging.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
          {(['email', 'linkedin', 'whatsapp'] as const).map((k) => (
            <div key={k}>
              <label className="label capitalize">{k} / day</label>
              <input
                type="number"
                className="input"
                value={limits[k]}
                onChange={(e) =>
                  setLimits({ ...limits, [k]: Number(e.target.value) || 0 })
                }
              />
            </div>
          ))}
        </div>
        <div className="mb-4">
          <label className="label">Opt-out confirmation message</label>
          <textarea
            className="input min-h-[90px]"
            value={optOutMessage}
            onChange={(e) => setOptOutMessage(e.target.value)}
          />
        </div>
        <div className="text-xs text-muted-foreground">
          Global suppression list: <strong className="text-foreground">—</strong>{' '}
          entries · <span className="opacity-70">(CSV export pending)</span>
        </div>
      </section>

      {/* API keys */}
      <section className="glass rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
            <Shield className="h-4 w-4" />
          </div>
          <h2 className="text-base font-semibold">API keys</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-3 ml-10">
          API keys are <strong className="text-foreground">never</strong> shown
          in the UI. Manage them in the AWS Secrets Manager console:
        </p>
        <div className="ml-10 text-xs font-mono rounded-lg border border-border/60 bg-muted/40 p-3 text-muted-foreground">
          ap-south-1 → Secrets Manager → /sales-agent/*
        </div>
      </section>
    </div>
  );
}
