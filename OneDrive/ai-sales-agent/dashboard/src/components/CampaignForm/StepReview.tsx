/**
 * Step 4 — review + launch. Shows a summary card, pitch-trigger hints,
 * an estimated timeline, and the two action buttons.
 */

import type { WizardDraft } from './types';

interface Props {
  draft: WizardDraft;
  onSaveDraft: () => void;
  onLaunch: () => void;
  busy?: boolean;
  error?: string | null;
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

export default function StepReview({ draft, onSaveDraft, onLaunch, busy, error }: Props) {
  const days = estimateDays(draft);

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

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      <div className="flex gap-3 justify-end">
        <button className="btn-secondary" onClick={onSaveDraft} disabled={busy}>
          Save as Draft
        </button>
        <button className="btn-primary" onClick={onLaunch} disabled={busy}>
          {busy ? 'Launching…' : 'Launch Campaign'}
        </button>
      </div>
    </div>
  );
}
