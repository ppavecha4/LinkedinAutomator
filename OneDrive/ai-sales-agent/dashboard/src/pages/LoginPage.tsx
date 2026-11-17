/**
 * Sign in / create account (SaaS phase 3). Two panels: what the product
 * does on the left (hidden on small screens), the form on the right.
 * "Create account" shows only when the API has sign-up open
 * (SIGNUP_ENABLED). After sign-in, a company that hasn't finished setup
 * goes to /onboarding.
 */

import { Check, Loader2, Lock, Sparkles } from 'lucide-react';
import * as React from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';

import { errorMessage, useAuth } from '../lib/authContext';
import { cn } from '../lib/cn';

type Mode = 'signin' | 'signup';

const POINTS = [
  'Outreach goes from your own email and WhatsApp accounts',
  "Every message written natively in the prospect's language",
  'Opt-outs honoured in any language, automatically',
];

export default function LoginPage(): React.ReactElement {
  const { user, loading, bypassMode, needsOnboarding, signupEnabled, emailEnabled, login, signup } = useAuth();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const [mode, setMode] = React.useState<Mode>(
    new URLSearchParams(location.search).get('mode') === 'signup' ? 'signup' : 'signin',
  );

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  }
  if (user || bypassMode) {
    return <Navigate to={needsOnboarding ? '/onboarding' : (from ?? '/')} replace />;
  }
  const showSignup = signupEnabled && mode === 'signup';

  return (
    <div className="min-h-screen grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] bg-background">
      <section
        aria-label="About the product"
        className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-brand-gradient p-12 text-white"
      >
        <div className="flex items-center gap-2.5 font-semibold">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/15">
            <Sparkles className="h-5 w-5" aria-hidden="true" />
          </span>
          AI Sales Agent
        </div>
        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-tight">
            Tell us who you sell to. We find them and start the conversation.
          </h1>
          <p className="mt-4 text-white/80">
            Describe your business once. The agent finds the right companies, writes to each person in their own
            language, and follows up by email and WhatsApp.
          </p>
          <ul className="mt-8 space-y-3">
            {POINTS.map((p) => (
              <li key={p} className="flex items-start gap-3 text-sm">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/20">
                  <Check className="h-3 w-3" aria-hidden="true" />
                </span>
                {p}
              </li>
            ))}
          </ul>
        </div>
        <p className="flex items-center gap-2 text-xs text-white/70">
          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
          Your keys are encrypted. Your data is never shared with other customers.
        </p>
      </section>

      <main className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 font-semibold lg:hidden">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            </span>
            AI Sales Agent
          </div>

          {signupEnabled ? (
            <div role="tablist" aria-label="Sign in or create account" className="mb-6 flex rounded-xl bg-muted/60 p-1">
              {(['signin', 'signup'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className={cn(
                    'flex-1 rounded-lg py-2 text-sm font-semibold transition-colors',
                    mode === m ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {m === 'signin' ? 'Sign in' : 'Create account'}
                </button>
              ))}
            </div>
          ) : (
            <h1 className="mb-6 text-2xl font-semibold">Sign in</h1>
          )}

          {showSignup ? <SignupForm onSignup={signup} /> : <SigninForm onLogin={login} emailEnabled={emailEnabled} />}
        </div>
      </main>
    </div>
  );
}

function ErrorNote({ text }: { text: string | null }): React.ReactElement | null {
  if (!text) return null;
  return (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
      {text}
    </div>
  );
}

function SigninForm({ onLogin, emailEnabled }: { onLogin: (email: string, password: string) => Promise<void>; emailEnabled: boolean }): React.ReactElement {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onLogin(email.trim(), password);
    } catch (err) {
      setError(errorMessage(err, 'Sign-in failed. Try again.'));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor="si-email" className="label">Work email</label>
        <input id="si-email" type="email" autoComplete="email" required className="input h-10" placeholder="you@company.com"
          value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
      </div>
      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="si-password" className="label">Password</label>
          {emailEnabled && <Link to="/forgot-password" className="mb-1.5 text-xs text-primary underline">Forgot password?</Link>}
        </div>
        <input id="si-password" type="password" autoComplete="current-password" required className="input h-10"
          value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
      </div>
      <ErrorNote text={error} />
      <button type="submit" className="btn-primary h-10 w-full" disabled={busy || !email || !password}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="text-xs text-muted-foreground">
        Belong to several companies? Switch between them from the account menu after signing in.
        {!emailEnabled && " Forgot your password? Ask your company's owner or an admin to send you a reset link."}
      </p>
    </form>
  );
}

function SignupForm({
  onSignup,
}: {
  onSignup: (input: { full_name: string; company: string; email: string; password: string; accept_terms: boolean }) => Promise<void>;
}): React.ReactElement {
  const [f, setF] = React.useState({ full_name: '', company: '', email: '', password: '', accept_terms: false });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: k === 'accept_terms' ? e.target.checked : e.target.value });
  const short = f.password.length > 0 && f.password.length < 12;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSignup({ ...f, full_name: f.full_name.trim(), company: f.company.trim(), email: f.email.trim() });
    } catch (err) {
      setError(errorMessage(err, 'Could not create your account. Try again.'));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="su-name" className="label">Your name</label>
          <input id="su-name" autoComplete="name" required maxLength={255} className="input h-10" value={f.full_name} onChange={set('full_name')} disabled={busy} />
        </div>
        <div>
          <label htmlFor="su-company" className="label">Company</label>
          <input id="su-company" autoComplete="organization" required maxLength={255} className="input h-10" value={f.company} onChange={set('company')} disabled={busy} />
        </div>
      </div>
      <div>
        <label htmlFor="su-email" className="label">Work email</label>
        <input id="su-email" type="email" autoComplete="email" required className="input h-10" placeholder="you@company.com" value={f.email} onChange={set('email')} disabled={busy} />
      </div>
      <div>
        <label htmlFor="su-password" className="label">Password</label>
        <input id="su-password" type="password" autoComplete="new-password" required minLength={12} className="input h-10"
          aria-describedby="su-password-hint" value={f.password} onChange={set('password')} disabled={busy} />
        <p id="su-password-hint" className={cn('mt-1.5 text-xs', short ? 'text-destructive' : 'text-muted-foreground')}>
          At least 12 characters.
        </p>
      </div>
      <label className="flex items-start gap-2.5 text-sm">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" checked={f.accept_terms} onChange={set('accept_terms')} disabled={busy} />
        <span>I agree to the Terms of Service and Privacy Policy.</span>
      </label>
      <ErrorNote text={error} />
      <button type="submit" className="btn-primary h-10 w-full"
        disabled={busy || !f.full_name.trim() || !f.company.trim() || !f.email.trim() || f.password.length < 12 || !f.accept_terms}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {busy ? 'Creating your account…' : 'Create account'}
      </button>
      <p className="text-xs text-muted-foreground">Next: a 5-minute setup that teaches the AI your business.</p>
    </form>
  );
}
