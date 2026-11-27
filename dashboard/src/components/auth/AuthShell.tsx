/**
 * Centered card for the one-purpose public pages reached from emailed
 * links: forgot password, reset password, accept invitation, verify email.
 */

import { Sparkles } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router-dom';

import { LanguageSelect } from '../LanguageSelect';
import { t } from '../../i18n';

export function AuthShell({
  title,
  intro,
  children,
  backToSignIn = true,
}: {
  title: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
  /** Off for pages that are only reached while signed in. */
  backToSignIn?: boolean;
}): React.ReactElement {
  return (
    <div className="relative min-h-screen flex items-center justify-center bg-background px-4 py-16">
      <LanguageSelect className="absolute end-4 top-4" />
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2.5 font-semibold">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Sparkles className="h-5 w-5" aria-hidden="true" />
          </span>
          AmiReach
        </div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {intro && <p className="mt-2 mb-6 text-sm text-muted-foreground">{intro}</p>}
        {!intro && <div className="mb-6" />}
        {children}
        {backToSignIn && (
          <p className="mt-6 text-center text-xs text-muted-foreground">
            <Link to="/login" className="underline">{t('Back to sign in')}</Link>
          </p>
        )}
      </div>
    </div>
  );
}

export function FormError({ text }: { text: string | null }): React.ReactElement | null {
  if (!text) return null;
  return (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
      {text}
    </div>
  );
}
