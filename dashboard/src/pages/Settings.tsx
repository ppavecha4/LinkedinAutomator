/**
 * Settings page — links to the business profile and connected accounts
 * (their own pages), compliance defaults and where API keys live.
 *
 * The compliance fields below are not persisted yet (no /api/settings).
 */

import { Plug, Settings as SettingsIcon, Shield, User } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { label } from '../lib/labels';
import { rich, t } from '../i18n';
import { PageHeader } from '../components/ui/page-header';

export default function Settings() {
  const [optOutMessage, setOptOutMessage] = useState(
    t('Got it — you won\'t hear from me again. Thanks for letting me know.'),
  );
  const [limits, setLimits] = useState({ email: 100, linkedin: 20, whatsapp: 50 });

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={t('Workspace')}
        title={t('Settings')}
        description={t('Business profile, channel connections, compliance defaults, and API key locations.')}
        icon={SettingsIcon}
      />

      {/* Business profile (the real one lives on its own page) */}
      <section className="glass rounded-2xl p-6 flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 flex-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <User className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-base font-semibold">{t('Business profile')}</h2>
            <p className="text-xs text-muted-foreground">
              {t('What you sell, who to contact, how messages sound, and who never to contact.')}
            </p>
          </div>
        </div>
        <Link to="/settings/profile" className="btn-secondary shrink-0">
          {t('Open business profile')}
        </Link>
      </section>

      {/* Connected accounts (the real ones live on their own page) */}
      <section className="glass rounded-2xl p-6 flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 flex-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Plug className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-base font-semibold">{t('Connected accounts')}</h2>
            <p className="text-xs text-muted-foreground">
              {t('The email, WhatsApp, lead-search and AI accounts your campaigns use, plus language and country defaults.')}
            </p>
          </div>
        </div>
        <Link to="/settings/connections" className="btn-secondary shrink-0">
          {t('Open connected accounts')}
        </Link>
      </section>

      {/* Compliance */}
      <section className="glass rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-500">
            <Shield className="h-4 w-4" />
          </div>
          <h2 className="text-base font-semibold">{t('Compliance')}</h2>
        </div>
        <p className="text-xs text-muted-foreground mb-5 ms-10">
          {t('Default daily limits and opt-out messaging.')}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
          {(['email', 'linkedin', 'whatsapp'] as const).map((k) => (
            <div key={k}>
              <label className="label capitalize">{t('{k} / day', { k: label(k) })}</label>
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
          <label className="label">{t('Opt-out confirmation message')}</label>
          <textarea
            className="input min-h-[90px]"
            value={optOutMessage}
            onChange={(e) => setOptOutMessage(e.target.value)}
          />
        </div>
        <div className="text-xs text-muted-foreground">
          {t('Entries on the do-not-contact list:')} <strong className="text-foreground">—</strong>{' '}
          · <span className="opacity-70">{t('(CSV export pending)')}</span>
        </div>
      </section>

      {/* API keys */}
      <section className="glass rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
            <Shield className="h-4 w-4" />
          </div>
          <h2 className="text-base font-semibold">{t('API keys')}</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-3 ms-10">
          {rich('API keys are <strong>never</strong> shown on screen. Manage them in the AWS Secrets Manager console:', { strong: (words) => <strong className="text-foreground">{words}</strong> })}
        </p>
        <div className="ms-10 text-xs font-mono rounded-lg border border-border/60 bg-muted/40 p-3 text-muted-foreground">
          {t('ap-south-1 → Secrets Manager → /sales-agent/*')}
        </div>
      </section>
    </div>
  );
}
