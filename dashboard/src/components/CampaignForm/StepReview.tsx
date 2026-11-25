/**
 * Step 4 — review + launch. Shows a summary card, pitch-trigger hints,
 * an estimated timeline, the Heyreach link picker, and the two action
 * buttons.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Briefcase, ChevronDown, ExternalLink, Loader2, RefreshCw } from 'lucide-react';

import { api } from '../../lib/api';

import type { WizardDraft } from './types';

interface Props {
  draft: WizardDraft;
  onChange: (patch: Partial<WizardDraft>) => void;
  onSaveDraft: () => void;
  onLaunch: () => void;
  busy?: boolean;
  error?: string | null;
  /** When 'edit', the buttons read "Save changes" / hide "Launch". */
  mode?: 'create' | 'edit';
}

interface HeyreachCampaignOption {
  id: string;
  name: string;
  status: string;
  account_count?: number;
}

interface HeyreachListResponse {
  ok: boolean;
  campaigns: HeyreachCampaignOption[];
  total: number;
  error: string | null;
  skipped: boolean;
}

function estimateDays(draft: WizardDraft): number {
  const perDay = Math.max(
    1,
    (draft.channels_enabled.includes('email') ? draft.daily_limits.email : 0) +
      (draft.channels_enabled.includes('linkedin') ? draft.daily_limits.linkedin : 0) +
      (draft.channels_enabled.includes('whatsapp') ? draft.daily_limits.whatsapp : 0),
  );
  return Math.max(1, Math.ceil(draft.batch_size / perDay));
}

const PITCH_HINTS: Array<{ color: string; title: string; signals: string[] }> = [
  {
    color: 'border-blue-200 bg-blue-50 text-blue-800',
    title: 'AI Agents (blue)',
    signals: [
      'CTO / VP Engineering / Head of Eng',
      'Hiring ML engineer, AI engineer, data scientist',
      'Cloud-native stack, posts about AI',
      'Fintech / SaaS industry',
    ],
  },
  {
    color: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    title: 'RPA / Workflow (green)',
    signals: [
      'COO / VP Operations / Head of IT',
      'Legacy ERP (SAP, Oracle EBS, mainframe)',
      'Manufacturing / Logistics industry',
      'Hiring RPA developer or ops analyst',
    ],
  },
  {
    color: 'border-amber-200 bg-amber-50 text-amber-800',
    title: 'Consulting (amber)',
    signals: [
      'CEO / MD / new C-suite hire',
      'Traditional industry (legal, accounting, real estate)',
      'No strong technical signals',
      'Board-level strategic framing',
    ],
  },
];

export default function StepReview({
  draft,
  onChange,
  onSaveDraft,
  onLaunch,
  busy,
  error,
  mode = 'create',
}: Props) {
  const days = estimateDays(draft);
  const isEdit = mode === 'edit';
  const qc = useQueryClient();

  // Fetch Heyreach campaigns — silently returns skipped=true when the
  // API service has no HEYREACH_API_KEY, so the picker simply hides.
  const heyreachQuery = useQuery({
    queryKey: ['heyreach', 'campaigns'],
    queryFn: async () => {
      const { data } = await api.get<HeyreachListResponse>(
        '/api/heyreach/campaigns',
      );
      return data;
    },
    staleTime: 30_000,
  });

  const heyreachId = draft.heyreach_campaign_id ?? '';
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ['heyreach', 'campaigns'] });

  return (
    <div className="space-y-5">
      <div className="card">
        <h3 className="text-base font-semibold text-slate-800 mb-3">Summary</h3>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-slate-500">Name</dt>
          <dd className="text-slate-800">{draft.name || <em className="text-slate-400">—</em>}</dd>
          <dt className="text-slate-500">Goal</dt>
          <dd className="text-slate-800">
            {draft.goal === 'Custom' ? draft.customGoal : draft.goal}
          </dd>
          <dt className="text-slate-500">Sender</dt>
          <dd className="text-slate-800">
            {draft.sender_name} · {draft.sender_company}
          </dd>
          <dt className="text-slate-500">Tone</dt>
          <dd className="text-slate-800 capitalize">{draft.tone}</dd>
          <dt className="text-slate-500">Industries</dt>
          <dd className="text-slate-800">{draft.industries.join(', ') || '—'}</dd>
          <dt className="text-slate-500">Sizes</dt>
          <dd className="text-slate-800">{draft.company_sizes.join(', ') || '—'}</dd>
          <dt className="text-slate-500">Countries</dt>
          <dd className="text-slate-800">{draft.countries.join(', ') || '—'}</dd>
          <dt className="text-slate-500">Titles</dt>
          <dd className="text-slate-800">{draft.titles.join(', ') || '—'}</dd>
          <dt className="text-slate-500">Channels</dt>
          <dd className="text-slate-800">{draft.channels_enabled.join(', ')}</dd>
          <dt className="text-slate-500">Batch size</dt>
          <dd className="text-slate-800">{draft.batch_size}</dd>
          <dt className="text-slate-500">Daily limits</dt>
          <dd className="text-slate-800 font-mono text-xs">
            email={draft.daily_limits.email} / linkedin={draft.daily_limits.linkedin} / whatsapp={draft.daily_limits.whatsapp}
          </dd>
        </dl>
      </div>

      <div className="card">
        <h3 className="text-base font-semibold text-slate-800 mb-2">Pitch triggers</h3>
        <p className="text-xs text-slate-500 mb-3">
          Each prospect will be auto-routed to one of three angles based on enrichment signals.
        </p>
        <div className="grid grid-cols-3 gap-3">
          {PITCH_HINTS.map((hint) => (
            <div key={hint.title} className={`rounded-md border p-3 ${hint.color}`}>
              <div className="font-semibold text-sm mb-1">{hint.title}</div>
              <ul className="text-[11px] space-y-0.5 list-disc pl-4">
                {hint.signals.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <div className="card flex items-center gap-6">
        <div>
          <div className="text-xs text-slate-500 uppercase">Estimated timeline</div>
          <div className="text-2xl font-semibold text-slate-800">{days} days</div>
          <div className="text-xs text-slate-500">
            at configured daily limits to work through the {draft.batch_size}-prospect batch
          </div>
        </div>
      </div>

      {/* Heyreach link picker — only shown when LinkedIn is enabled and
          Heyreach is configured server-side. */}
      {draft.channels_enabled.includes('linkedin') && !heyreachQuery.data?.skipped && (
        <div className="card border-l-4 border-[#0a66c2]">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#0a66c2]/15 text-[#0a66c2]">
              <Briefcase className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-slate-800">
                Heyreach campaign link{' '}
                <span className="text-xs font-normal text-slate-400">(optional)</span>
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Link a Heyreach campaign so LinkedIn drafts on this campaign
                push to Heyreach automatically. You can also leave this for
                later and pick it from the campaign edit page.
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {heyreachQuery.isLoading ? (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading your Heyreach campaigns…
                  </div>
                ) : heyreachQuery.data?.ok === false ? (
                  <div className="text-xs text-rose-500">
                    Heyreach API error: {heyreachQuery.data?.error ?? 'unknown'}{' '}
                    <button className="ml-2 underline" onClick={refresh}>
                      retry
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="relative flex-1 min-w-[260px]">
                      <select
                        className="input h-9 text-sm pr-7 appearance-none w-full"
                        value={heyreachId}
                        onChange={(e) =>
                          onChange({
                            heyreach_campaign_id: e.target.value || null,
                          })
                        }
                        disabled={busy}
                      >
                        <option value="">
                          — Pick a Heyreach campaign (or skip) —
                        </option>
                        {heyreachQuery.data?.campaigns.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                            {c.status !== 'UNKNOWN' ? ` · ${c.status}` : ''}
                            {c.account_count !== undefined
                              ? ` · ${c.account_count} account${c.account_count === 1 ? '' : 's'}`
                              : ''}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-400 pointer-events-none" />
                    </div>

                    <button
                      type="button"
                      className="btn-ghost text-xs h-9 px-3"
                      onClick={refresh}
                      disabled={heyreachQuery.isFetching}
                      title="Re-fetch from Heyreach"
                    >
                      {heyreachQuery.isFetching ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      Refresh
                    </button>

                    <a
                      className="btn-ghost text-xs h-9 px-3"
                      href="https://app.heyreach.io/campaigns"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Create in Heyreach
                    </a>
                  </>
                )}
              </div>

              {heyreachQuery.data?.ok && heyreachQuery.data.campaigns.length === 0 && (
                <div className="mt-2 text-xs text-slate-500">
                  You have no Heyreach campaigns yet.{' '}
                  <a
                    href="https://app.heyreach.io/campaigns"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#0a66c2] underline"
                  >
                    Create your first one →
                  </a>
                  {' '}then click Refresh.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {isEdit ? (
        <div className="flex gap-3 justify-end">
          <button className="btn-primary" onClick={onSaveDraft} disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      ) : (
        <div className="flex gap-3 justify-end">
          <button className="btn-secondary" onClick={onSaveDraft} disabled={busy}>
            Save as Draft
          </button>
          <button className="btn-primary" onClick={onLaunch} disabled={busy}>
            {busy ? 'Launching…' : 'Launch Campaign'}
          </button>
        </div>
      )}
    </div>
  );
}
