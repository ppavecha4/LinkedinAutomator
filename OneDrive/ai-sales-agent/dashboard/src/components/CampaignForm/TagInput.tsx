/**
 * Tag input — user types + Enter/comma to add, click chip to remove.
 * Also shows a pre-suggested list the user can click to append.
 */

import { useState } from 'react';

import clsx from 'clsx';

interface Props {
  values: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
}

export default function TagInput({ values, onChange, suggestions, placeholder }: Props) {
  const [draft, setDraft] = useState('');

  function commit(raw: string) {
    const v = raw.trim();
    if (!v) return;
    if (values.includes(v)) return;
    onChange([...values, v]);
    setDraft('');
  }

  function remove(v: string) {
    onChange(values.filter((x) => x !== v));
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 rounded-md border border-slate-300 bg-white p-2 min-h-[44px]">
        {values.map((v) => (
          <button
            key={v}
            onClick={() => remove(v)}
            className="chip-removable"
            type="button"
          >
            {v}
            <span className="text-slate-400">✕</span>
          </button>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit(draft);
            } else if (e.key === 'Backspace' && !draft && values.length > 0) {
              remove(values[values.length - 1]);
            }
          }}
          onBlur={() => commit(draft)}
          placeholder={placeholder ?? 'Type and press Enter'}
          className="flex-1 min-w-[120px] text-sm outline-none"
        />
      </div>
      {suggestions && suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {suggestions
            .filter((s) => !values.includes(s))
            .map((s) => (
              <button
                key={s}
                onClick={() => commit(s)}
                type="button"
                className={clsx('chip', 'cursor-pointer hover:bg-brand-light hover:text-brand')}
              >
                + {s}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
