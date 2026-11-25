/**
 * Step 2 — ICP criteria (industries, sizes, countries, titles, intent).
 * Shows a placeholder "live estimate" panel until the estimate endpoint ships.
 */

import clsx from 'clsx';

import { useEstimateProspects } from '../../hooks/useCampaigns';

import TagInput from './TagInput';
import {
  COMPANY_SIZE_OPTIONS,
  COUNTRY_GROUPS,
  INDUSTRY_OPTIONS,
  INTENT_SUGGESTIONS,
  TITLE_SUGGESTIONS,
  type WizardDraft,
} from './types';

interface Props {
  draft: WizardDraft;
  onChange: (patch: Partial<WizardDraft>) => void;
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

export default function StepICP({ draft, onChange }: Props) {
  const estimate = useEstimateProspects({
    industries: draft.industries,
    company_sizes: draft.company_sizes,
    countries: draft.countries,
    titles: draft.titles,
  });

  return (
    <div className="space-y-5">
      <div>
        <label className="label">Industries</label>
        <div className="flex flex-wrap gap-2">
          {INDUSTRY_OPTIONS.map((industry) => {
            const on = draft.industries.includes(industry);
            return (
              <button
                key={industry}
                type="button"
                onClick={() =>
                  onChange({ industries: toggle(draft.industries, industry) })
                }
                className={clsx(
                  'px-3 py-1 rounded-full text-sm border transition-colors',
                  on
                    ? 'bg-brand text-white border-brand'
                    : 'bg-white text-slate-700 border-slate-300 hover:border-slate-400',
                )}
              >
                {industry}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="label">Company size</label>
        <div className="flex flex-wrap gap-4">
          {COMPANY_SIZE_OPTIONS.map((size) => (
            <label key={size} className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={draft.company_sizes.includes(size)}
                onChange={() =>
                  onChange({ company_sizes: toggle(draft.company_sizes, size) })
                }
              />
              {size}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Countries</label>
        <div className="grid grid-cols-2 gap-3">
          {Object.entries(COUNTRY_GROUPS).map(([region, countries]) => (
            <div key={region}>
              <div className="text-xs uppercase text-slate-400 mb-1">{region}</div>
              <div className="flex flex-wrap gap-1.5">
                {countries.map((c) => {
                  const on = draft.countries.includes(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() =>
                        onChange({ countries: toggle(draft.countries, c) })
                      }
                      className={clsx(
                        'px-2.5 py-0.5 rounded-full text-xs border transition-colors',
                        on
                          ? 'bg-brand text-white border-brand'
                          : 'bg-white text-slate-600 border-slate-300 hover:border-slate-400',
                      )}
                    >
                      {c}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Target titles</label>
        <TagInput
          values={draft.titles}
          onChange={(next) => onChange({ titles: next })}
          suggestions={TITLE_SUGGESTIONS}
          placeholder="CTO, VP Operations, …"
        />
      </div>

      <div>
        <label className="label">Intent keywords (optional)</label>
        <TagInput
          values={draft.intent_keywords}
          onChange={(next) => onChange({ intent_keywords: next })}
          suggestions={INTENT_SUGGESTIONS}
          placeholder="AI engineer, digital transformation…"
        />
      </div>

      <div className="rounded-md bg-slate-50 border border-slate-200 p-4 text-sm">
        <div className="text-xs uppercase text-slate-400 mb-1">Live estimate</div>
        {estimate.data?.estimate == null ? (
          <div className="text-slate-500">
            ~ estimate unavailable{' '}
            <span className="text-slate-400">
              ({estimate.data?.message ?? 'loading…'})
            </span>
          </div>
        ) : (
          <div className="text-lg font-semibold text-slate-800">
            ~{estimate.data.estimate} prospects
          </div>
        )}
      </div>
    </div>
  );
}
