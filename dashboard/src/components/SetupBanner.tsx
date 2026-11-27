/**
 * A short reminder at the top of Overview while a company still has setup steps left, pointing at
 * "Get ready to send". Disappears by itself once everything is in place. Hidden in the operator workspace.
 */

import { ArrowRight, ListChecks } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router-dom';

import { t } from '../i18n';
import { nextStep, useSetup } from '../hooks/useSetup';

export function SetupBanner(): React.ReactElement | null {
  const setup = useSetup();
  if (setup.loading || !setup.applicable || setup.complete) return null;
  const next = nextStep(setup.steps);
  return (
    <Link
      to="/get-ready"
      className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border border-primary/30 bg-primary/10 p-4 transition-colors hover:bg-primary/15"
    >
      <ListChecks className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold">{t('Finish setting up: {done} of {total} ready', { done: setup.done, total: setup.total })}</p>
        {next && <p className="truncate text-xs text-muted-foreground">{t('Next: {title}', { title: next.title })}</p>}
      </div>
      <span className="inline-flex items-center gap-1 text-sm font-semibold text-primary">{t('Continue')}{' '}<ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" /></span>
    </Link>
  );
}
