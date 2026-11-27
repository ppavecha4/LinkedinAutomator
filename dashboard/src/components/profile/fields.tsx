/**
 * Small form controls for the business profile (onboarding + settings).
 * Themed with the dashboard's own classes (.input, .chip, .label).
 */

import { Globe, Plus, X } from 'lucide-react';
import * as React from 'react';

import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { COUNTRIES, countryName, LANGUAGES, languageName } from '../../lib/profile';

export function Field({
  label,
  hint,
  fromWebsite,
  children,
  className,
  htmlFor,
}: {
  label: string;
  hint?: string;
  fromWebsite?: boolean;
  children: React.ReactNode;
  className?: string;
  htmlFor?: string;
}): React.ReactElement {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="label flex items-center gap-2">
        {label}
        {fromWebsite && <FromWebsite />}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function FromWebsite(): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-primary">
      <Globe className="h-3 w-3" aria-hidden="true" />
      {t('from website')}
    </span>
  );
}

/** Free-text tags: type and press Enter or comma; click a tag to remove it. */
export function TagInput({
  values,
  onChange,
  placeholder,
  max,
  id,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  max?: number;
  id?: string;
}): React.ReactElement {
  const [draft, setDraft] = React.useState('');
  const commit = (raw: string) => {
    const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...values];
    for (const p of parts) if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(max ? next.slice(0, max) : next);
    setDraft('');
  };
  return (
    <div className="input flex flex-wrap items-center gap-1.5 min-h-[42px] py-1.5">
      {values.map((v) => (
        <button
          key={v}
          type="button"
          className="chip-removable"
          onClick={() => onChange(values.filter((x) => x !== v))}
          aria-label={t('Remove {v}', { v })}
        >
          {v}
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      ))}
      <input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit(draft);
          } else if (e.key === 'Backspace' && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => commit(draft)}
        placeholder={values.length ? '' : (placeholder ?? t('Type and press Enter'))}
        className="flex-1 min-w-[140px] bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

/** A row of toggle chips (multi-select). */
export function ToggleChips<T extends string>({
  options,
  values,
  onChange,
  labels,
}: {
  options: readonly T[];
  values: T[];
  onChange: (next: T[]) => void;
  labels?: Partial<Record<T, string>>;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = values.includes(o);
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? values.filter((v) => v !== o) : [...values, o])}
            className={cn(
              'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              on
                ? 'border-primary/60 bg-primary/15 text-primary'
                : 'border-border/70 bg-card/50 text-muted-foreground hover:text-foreground',
            )}
          >
            {labels?.[o] ?? o}
          </button>
        );
      })}
    </div>
  );
}

/** Single choice shown as a segmented row of buttons. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  labels,
  name,
}: {
  options: readonly T[];
  value: T | undefined;
  onChange: (v: T) => void;
  labels: Record<T, string>;
  name: string;
}): React.ReactElement {
  return (
    <div role="radiogroup" aria-label={name} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o}
          onClick={() => onChange(o)}
          className={cn(
            'rounded-lg border px-3.5 py-2 text-sm transition-colors',
            value === o
              ? 'border-primary/60 bg-primary/15 text-primary font-medium'
              : 'border-border/70 bg-card/50 text-muted-foreground hover:text-foreground',
          )}
        >
          {labels[o]}
        </button>
      ))}
    </div>
  );
}

/** Pick several codes from a long list: chips + a select to add one. */
function CodePicker({
  values,
  onChange,
  options,
  nameOf,
  addLabel,
  max,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  options: Array<{ code: string; name: string }>;
  nameOf: (code: string) => string;
  addLabel: string;
  max: number;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {values.map((c) => (
        <button
          key={c}
          type="button"
          className="chip-removable"
          onClick={() => onChange(values.filter((v) => v !== c))}
          aria-label={t('Remove {c}', { c: nameOf(c) })}
        >
          {nameOf(c)}
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      ))}
      {values.length < max && (
        <label className="relative inline-flex items-center">
          <span className="chip cursor-pointer hover:text-foreground">
            <Plus className="h-3 w-3" aria-hidden="true" />
            {addLabel}
          </span>
          <select
            aria-label={addLabel}
            className="absolute inset-0 cursor-pointer opacity-0"
            value=""
            onChange={(e) => e.target.value && onChange([...values, e.target.value])}
          >
            <option value="">{addLabel}</option>
            {options
              .filter((o) => !values.includes(o.code))
              .map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name}
                </option>
              ))}
          </select>
        </label>
      )}
    </div>
  );
}

export function CountriesPicker(props: {
  values: string[];
  onChange: (next: string[]) => void;
  max?: number;
  addLabel?: string;
}): React.ReactElement {
  return (
    <CodePicker
      {...props}
      max={props.max ?? 40}
      addLabel={props.addLabel ?? t('Add country')}
      options={COUNTRIES}
      nameOf={countryName}
    />
  );
}

const LANGUAGE_OPTIONS = LANGUAGES.map((code) => ({ code, name: languageName(code) }))
  .sort((a, b) => a.name.localeCompare(b.name));

export function LanguagesPicker(props: {
  values: string[];
  onChange: (next: string[]) => void;
}): React.ReactElement {
  return (
    <CodePicker {...props} max={10} addLabel={t('Add language')} options={LANGUAGE_OPTIONS} nameOf={languageName} />
  );
}

export function CountrySelect({
  value,
  onChange,
  id,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  id?: string;
}): React.ReactElement {
  return (
    <select id={id} className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{t('Choose a country')}</option>
      {COUNTRIES.map((c) => (
        <option key={c.code} value={c.code}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
