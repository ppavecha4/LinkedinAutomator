import { Globe } from 'lucide-react';
import * as React from 'react';

import { lang, LANGUAGES_UI, setLanguage, t, type Lang } from '../i18n';
import { cn } from '../lib/cn';

/** The screen language. Each name is written in its own language so anyone can find theirs. */
export function LanguageSelect({ className }: { className?: string }): React.ReactElement {
  return (
    <label className={cn('inline-flex items-center gap-1.5 text-sm text-muted-foreground', className)}>
      <Globe className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t('Language')}</span>
      <select
        className="cursor-pointer rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
        value={lang()}
        onChange={(e) => setLanguage(e.target.value as Lang)}
      >
        {LANGUAGES_UI.map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.name}</option>)}
      </select>
    </label>
  );
}
