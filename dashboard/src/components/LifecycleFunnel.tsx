/**
 * LifecycleFunnel — the outreach funnel across all ACTIVE campaigns.
 *
 * Renders the prospect lifecycle as a set of stage bars with counts and
 * stage-to-stage conversion %, so the operator can see at a glance where
 * prospects drop off:
 *
 *   Discovered → Enriched → Contacted → Opened → Replied → Meeting booked
 *
 * Backed by GET /api/analytics/funnel (useOverallFunnel).
 */

import * as React from 'react';

import { t } from '../i18n';
import { useOverallFunnel } from '../hooks/useAnalytics';

const STAGES: { key: string; label: string; color: string }[] = [
  { key: 'discovered', label: t('Discovered'), color: 'bg-slate-400' },
  { key: 'enriched', label: t('Enriched'), color: 'bg-sky-400' },
  { key: 'contacted', label: t('Contacted'), color: 'bg-indigo-500' },
  { key: 'opened', label: t('Opened'), color: 'bg-violet-500' },
  { key: 'replied', label: t('Replied'), color: 'bg-emerald-500' },
  { key: 'meeting_booked', label: t('Meeting booked'), color: 'bg-amber-500' },
];

export function LifecycleFunnel(): React.ReactElement {
  const { data, isLoading } = useOverallFunnel();
  const f = (data?.funnel ?? {}) as Record<string, number>;

  // The top-of-funnel is the sum of everyone who was ever discovered.
  // prospects.status is a single current-state, so a prospect who
  // REPLIED no longer counts under 'contacted'. To render a true funnel
  // we accumulate downstream stages into the upstream ones.
  const counts = STAGES.map((s) => Number(f[s.key] ?? 0));
  // Cumulative-from-the-right so each stage ≥ the next.
  const cumulative: number[] = [];
  for (let i = 0; i < counts.length; i++) {
    cumulative[i] = counts.slice(i).reduce((a, b) => a + b, 0);
  }
  const top = cumulative[0] || 1;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold text-slate-800">
          {t('Lifecycle funnel')}
        </h3>
        <span className="text-xs text-slate-400">{t('active campaigns')}</span>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-6 text-center">
          {t('Loading…')}
        </div>
      ) : cumulative[0] === 0 ? (
        <div className="text-sm text-muted-foreground py-6 text-center">
          {t('No prospects yet — launch a campaign to see the funnel fill.')}
        </div>
      ) : (
        <div className="space-y-2.5">
          {STAGES.map((s, i) => {
            const value = cumulative[i];
            const pct = Math.round((value / top) * 100);
            const convFromPrev =
              i === 0 || cumulative[i - 1] === 0
                ? null
                : Math.round((value / cumulative[i - 1]) * 100);
            return (
              <div key={s.key}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-slate-600">{s.label}</span>
                  <span className="text-slate-500">
                    <strong className="text-slate-800">{value}</strong>
                    {convFromPrev !== null && (
                      <span className="ms-2 text-slate-400">
                        {convFromPrev}% ↓
                      </span>
                    )}
                  </span>
                </div>
                <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className={`h-full ${s.color} rounded-full transition-all`}
                    style={{ width: `${Math.max(pct, value > 0 ? 3 : 0)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
