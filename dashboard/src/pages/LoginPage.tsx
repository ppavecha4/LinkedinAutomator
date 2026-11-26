/**
 * Sign in (/login) and create account (/signup). Two panels: what the product
 * does on the left (hidden on small screens), the form on the right.
 * "Create account" shows only when the API has sign-up open (SIGNUP_ENABLED,
 * and a way to pay if there is a sign-up fee). After sign-in, a company that
 * owes the fee goes to /signup/payment, one still being set up to /onboarding.
 */

import { Check, Loader2, Lock, Sparkles } from 'lucide-react';
import * as React from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import { API_BASE } from '../lib/api';
import { errorMessage, useAuth, type SignupFeeOffer } from '../lib/authContext';
import { cn } from '../lib/cn';
import { formatFee } from '../lib/money';

type Mode = 'signin' | 'signup';

const GOOGLE_ERRORS: Record<string, string> = {
  denied: 'Google sign-in was cancelled.',
  expired: 'That sign-in took too long. Try again.',
  failed: 'Google sign-in did not work. Try again.',
  unverified: 'Google has not verified that email address, so we cannot use it.',
  closed: 'No account exists for that Google address, and sign-up is closed.',
  operator: 'This address signs in with its password.',
  no_org: 'This account has no active organization.',
};

const POINTS = [
  'Outreach goes from your own email and WhatsApp accounts',
  "Every message written natively in the prospect's language",
  'Opt-outs honoured in any language, automatically',
];

export default function LoginPage(): React.ReactElement {
  const { user, loading, bypassMode, needsOnboarding, needsPayment, signupEnabled, signupFee, googleEnabled, login, signup } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const from = (location.state as { from?: string } | null)?.from;
  const mode: Mode = location.pathname === '/signup' || new URLSearchParams(location.search).get('mode') === 'signup' ? 'signup' : 'signin';
  const setMode = (m: Mode) => navigate(m === 'signup' ? '/signup' : '/login', { replace: true, state: location.state });

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  }
  if (user || bypassMode) {
    return <Navigate to={needsPayment ? '/signup/payment' : needsOnboarding ? '/onboarding' : (from ?? '/')} replace />;
  }
  const showSignup = signupEnabled && mode === 'signup';
  const googleError = GOOGLE_ERRORS[new URLSearchParams(location.search).get('google_error') ?? ''] ?? null;

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
          AmiReach
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
            AmiReach
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

          <ErrorNote text={googleError} />
          {mode === 'signup' && !signupEnabled && (
            <p role="status" className="mb-4 rounded-lg border border-border p-3 text-sm">
              New sign-ups are not open yet. If you already have an account, sign in below.
            </p>
          )}
          {showSignup ? <SignupForm onSignup={signup} fee={signupFee} /> : <SigninForm onLogin={login} />}
          {googleEnabled && <GoogleButton creating={showSignup} />}
          {signupEnabled && (
            <p className="mt-5 text-center text-sm text-muted-foreground">
              {showSignup ? 'Already have an account? ' : 'New to AmiReach? '}
              <Link to={showSignup ? '/login' : '/signup'} replace className="font-semibold text-primary underline">
                {showSignup ? 'Sign in' : 'Create an account'}
              </Link>
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

function GoogleButton({ creating }: { creating: boolean }): React.ReactElement {
  return (
    <div className="mt-5">
      <div className="mb-4 flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" />
      </div>
      <a href={`${API_BASE}/api/auth/google/start`} className="btn-secondary w-full justify-center">
        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
          <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.8-5.5 3.8-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.3 14.6 2.3 12 2.3 6.9 2.3 2.8 6.4 2.8 11.8S6.9 21.3 12 21.3c5.3 0 8.8-3.7 8.8-9 0-.6-.1-1.1-.2-1.6H12z" />
        </svg>
        Continue with Google
      </a>
      {creating && (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          By continuing you accept the <Link to="/terms" target="_blank" className="underline">Terms</Link> and{' '}
          <Link to="/privacy" target="_blank" className="underline">Privacy Policy</Link>.
        </p>
      )}
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

function SigninForm({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }): React.ReactElement {
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
          <Link to="/forgot-password" className="mb-1.5 text-xs text-primary underline">Forgot password?</Link>
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
      </p>
    </form>
  );
}

function SignupForm({
  onSignup,
  fee,
}: {
  onSignup: (input: { full_name: string; company: string; email: string; password: string; accept_terms: boolean }) => Promise<void>;
  fee: SignupFeeOffer[] | null;
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
        <span>I agree to the <Link to="/terms" target="_blank" className="underline">Terms of Service</Link> and <Link to="/privacy" target="_blank" className="underline">Privacy Policy</Link>.</span>
      </label>
      <ErrorNote text={error} />
      <button type="submit" className="btn-primary h-10 w-full"
        disabled={busy || !f.full_name.trim() || !f.company.trim() || !f.email.trim() || f.password.length < 12 || !f.accept_terms}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {busy ? 'Creating your account…' : fee ? 'Create account and continue to payment' : 'Create account'}
      </button>
      {fee ? (
        <p className="text-xs text-muted-foreground">
          One-time sign-up fee, paid on the next step:{' '}
          {fee.map((o) => `${formatFee(o.amount_minor, o.currency)} ${o.id === 'india' ? 'in India (GST included)' : 'outside India'}`).join(' · ')}.
          Then a 5-minute setup teaches the AI your business.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Next: a 5-minute setup that teaches the AI your business.</p>
      )}
    </form>
  );
}
