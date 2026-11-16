/**
 * Settings page — links to the business profile and connected accounts
 * (their own pages), compliance defaults and where API keys live.
 *
 * The compliance fields below are not persisted yet (no /api/settings).
 */

import { Plug, Settings as SettingsIcon, Shield, User } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { PageHeader } from '../components/ui/page-header';

export default function Settings() {
  const [optOutMessage, setOptOutMessage] = useState(
    "Got it — you won't hear from me again. Thanks for letting me know.",
  );
  const [limits, setLimits] = useState({ email: 100, linkedin: 20, whatsapp: 50 });

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Workspace"
        title="Settings"
        description="Business profile, channel connections, compliance defaults, and API key locations."
        icon={SettingsIcon}
      />

      {/* Business profile (the real one lives on its own page) */}
      <section className="glass rounded-2xl p-6 flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 flex-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <User className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-base font-semibold">Business profile</h2>
            <p className="text-xs text-muted-foreground">
              What you sell, who to contact, how messages sound, and who never to contact.
            </p>
          </div>
        </div>
        <Link to="/settings/profile" className="btn-secondary shrink-0">
          Open business profile
        </Link>
      </section>

      {/* Connected accounts (the real ones live on their own page) */}
      <section className="glass rounded-2xl p-6 flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 flex-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Plug className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-base font-semibold">Connected accounts</h2>
            <p className="text-xs text-muted-foreground">
              The email, WhatsApp, lead-search and AI accounts your campaigns use, plus language and country defaults.
            </p>
          </div>
        </div>
        <Link to="/settings/connections" className="btn-secondary shrink-0">
          Open connected accounts
        </Link>
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
