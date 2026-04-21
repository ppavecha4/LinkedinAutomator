/**
 * Step 1 — campaign basics (name, goal, sender, value prop, tone).
 */

import clsx from 'clsx';

import { GOAL_OPTIONS, TONE_OPTIONS, type WizardDraft } from './types';

interface Props {
  draft: WizardDraft;
  onChange: (patch: Partial<WizardDraft>) => void;
  errors: Partial<Record<keyof WizardDraft, string>>;
}

export default function StepBasics({ draft, onChange, errors }: Props) {
  return (
    <div className="space-y-5">
      <div>
        <label className="label">Campaign name</label>
        <input
          className="input"
          value={draft.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Q2 CTO Outreach — SaaS 51-200"
        />
        {errors.name && <div className="text-xs text-rose-600 mt-1">{errors.name}</div>}
      </div>

      <div>
        <label className="label">Goal</label>
        <select
          className="input"
          value={draft.goal}
          onChange={(e) => onChange({ goal: e.target.value })}
        >
          {GOAL_OPTIONS.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        {draft.goal === 'Custom' && (
          <input
            className="input mt-2"
            placeholder="Describe your goal"
            value={draft.customGoal ?? ''}
            onChange={(e) => onChange({ customGoal: e.target.value })}
          />
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Sender name</label>
          <input
            className="input"
            value={draft.sender_name}
            onChange={(e) => onChange({ sender_name: e.target.value })}
            placeholder="Priya Sharma"
          />
          {errors.sender_name && (
            <div className="text-xs text-rose-600 mt-1">{errors.sender_name}</div>
          )}
        </div>
        <div>
          <label className="label">Sender company</label>
          <input
            className="input"
            value={draft.sender_company}
            onChange={(e) => onChange({ sender_company: e.target.value })}
            placeholder="WeBuildAgents Inc"
          />
          {errors.sender_company && (
            <div className="text-xs text-rose-600 mt-1">{errors.sender_company}</div>
          )}
        </div>
      </div>

      <div>
        <label className="label">Value proposition</label>
        <textarea
          className="input min-h-[110px]"
          value={draft.value_proposition}
          onChange={(e) => onChange({ value_proposition: e.target.value })}
          placeholder="3–4 sentences on what you do, who it's for, and what outcome you deliver."
        />
        {errors.value_proposition && (
          <div className="text-xs text-rose-600 mt-1">{errors.value_proposition}</div>
        )}
      </div>

      <div>
        <label className="label">Tone</label>
        <div className="grid grid-cols-2 gap-3">
          {TONE_OPTIONS.map((t) => (
            <label
              key={t.value}
              className={clsx(
                'flex items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors',
                draft.tone === t.value
                  ? 'border-brand bg-brand-light'
                  : 'border-slate-200 hover:border-slate-300',
              )}
            >
              <input
                type="radio"
                name="tone"
                value={t.value}
                checked={draft.tone === t.value}
                onChange={() => onChange({ tone: t.value })}
                className="mt-0.5"
              />
              <div>
                <div className="font-medium text-slate-800 flex items-center gap-2">
                  {t.label}
                  {t.recommended && (
                    <span className="text-[10px] uppercase bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">
                      recommended
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500">{t.description}</div>
              </div>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
