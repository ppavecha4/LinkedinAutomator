/**
 * The pages behind the links in our emails (SaaS phase 3, slice 3.6):
 *   /forgot-password         ask for a reset link
 *   /reset-password?token=   choose a new password
 *   /accept-invite?token=    join a company you were invited to
 *   /verify-email?token=     confirm your email address
 * All public (no session needed).
 */

import { CheckCircle2, Loader2 } from 'lucide-react';
import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { AuthShell, FormError } from '../components/auth/AuthShell';
import { api, ApiClientError } from '../lib/api';
import { errorMessage, useAuth } from '../lib/authContext';

function useToken(): string {
  const [params] = useSearchParams();
  return params.get('token') ?? '';
}

function Busy({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <>
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {children}
    </>
  );
}

// ── Forgot password ──────────────────────────────────────────────────────

export function ForgotPasswordPage(): React.ReactElement {
  const { emailEnabled, loading } = useAuth();
  const [email, setEmail] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/forgot-password', { email: email.trim() });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <AuthShell title="Reset your password"><Loader2 className="mx-auto h-5 w-5 animate-spin" aria-label="Loading" /></AuthShell>;

  if (!emailEnabled) {
    return (
      <AuthShell title="Reset your password">
        <p className="text-sm">
          Reset links by email are not set up yet. Ask your company's owner or an admin to send you a reset link
          from <span className="font-medium">Settings › Team</span>, or write to{' '}
          <a className="underline" href="mailto:info@appsontechnologies.in">info@appsontechnologies.in</a>.
        </p>
      </AuthShell>
    );
  }
  if (sent) {
    return (
      <AuthShell title="Check your email">
        <p className="text-sm">
          If an account exists for <span className="font-medium">{email.trim()}</span>, we've sent a link to reset
          the password. It works once and expires in an hour.
        </p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Reset your password" intro="Enter your work email and we'll send you a link to choose a new password.">
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="fp-email" className="label">Work email</label>
          <input id="fp-email" type="email" autoComplete="email" required className="input h-10" value={email}
            onChange={(e) => setEmail(e.target.value)} disabled={busy} placeholder="you@company.com" />
        </div>
        <FormError text={error} />
        <button type="submit" className="btn-primary h-10 w-full" disabled={busy || !email.trim()}>
          {busy ? <Busy>Sending…</Busy> : 'Send reset link'}
        </button>
      </form>
    </AuthShell>
  );
}

// ── Reset password ───────────────────────────────────────────────────────

export function ResetPasswordPage(): React.ReactElement {
  const token = useToken();
  const [password, setPassword] = React.useState('');
  const [again, setAgain] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const mismatch = again.length > 0 && again !== password;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!token) return <AuthShell title="This link isn't valid"><p className="text-sm">Open the link from your email again, or <Link className="underline" to="/forgot-password">ask for a new one</Link>.</p></AuthShell>;
  if (done) {
    return (
      <AuthShell title="Password changed">
        <p className="mb-4 flex items-center gap-2 text-sm"><CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden="true" /> You can now sign in with your new password. Any other device was signed out.</p>
        <Link to="/login" className="btn-primary h-10 w-full">Sign in</Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Choose a new password">
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="rp-password" className="label">New password</label>
          <input id="rp-password" type="password" autoComplete="new-password" required minLength={12} className="input h-10"
            value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          <p className="mt-1.5 text-xs text-muted-foreground">At least 12 characters.</p>
        </div>
        <div>
          <label htmlFor="rp-again" className="label">Repeat it</label>
          <input id="rp-again" type="password" autoComplete="new-password" required className="input h-10"
            value={again} onChange={(e) => setAgain(e.target.value)} disabled={busy} />
          {mismatch && <p className="mt-1.5 text-xs text-destructive">The two passwords don't match.</p>}
        </div>
        <FormError text={error} />
        <button type="submit" className="btn-primary h-10 w-full" disabled={busy || password.length < 12 || password !== again}>
          {busy ? <Busy>Saving…</Busy> : 'Change password'}
        </button>
      </form>
    </AuthShell>
  );
}

// ── Accept an invitation ─────────────────────────────────────────────────

interface InviteInfo {
  org_name: string;
  email: string;
  role: string;
  has_account: boolean;
}

export function AcceptInvitePage(): React.ReactElement {
  const token = useToken();
  const navigate = useNavigate();
  const { user, loading, acceptInvite } = useAuth();
  const [info, setInfo] = React.useState<InviteInfo | null>(null);
  const [gone, setGone] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [terms, setTerms] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!token) return setGone('This invitation link is not valid.');
    api.get<InviteInfo>(`/api/auth/invite?token=${encodeURIComponent(token)}`)
      .then(({ data }) => setInfo(data))
      .catch((e) => setGone(e instanceof ApiClientError && e.status === 404
        ? 'This invitation has expired or was withdrawn. Ask the person who invited you for a new one.'
        : errorMessage(e)));
  }, [token]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await acceptInvite({
        token, password,
        ...(info && !info.has_account ? { full_name: name.trim(), accept_terms: true as const } : {}),
      });
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (loading || (!info && !gone)) return <AuthShell title="Your invitation"><Loader2 className="mx-auto h-5 w-5 animate-spin" aria-label="Loading" /></AuthShell>;
  if (gone || !info) return <AuthShell title="Invitation not available"><p className="text-sm">{gone}</p></AuthShell>;

  const signedInAsSomeoneElse = user && user.email.toLowerCase() !== info.email.toLowerCase() && !user.email.endsWith('@local');
  const intro = (
    <>You've been invited to join <span className="font-medium text-foreground">{info.org_name}</span> as {info.role === 'admin' ? 'an' : 'a'} <span className="font-medium text-foreground">{info.role}</span>.</>
  );

  return (
    <AuthShell title="Join your team" intro={intro}>
      {signedInAsSomeoneElse && (
        <p className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
          You're signed in as {user?.email}. This invitation is for {info.email}; continuing signs you in as them.
        </p>
      )}
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="ai-email" className="label">Email</label>
          <input id="ai-email" className="input h-10" value={info.email} readOnly aria-readonly="true" />
        </div>
        {!info.has_account && (
          <div>
            <label htmlFor="ai-name" className="label">Your name</label>
            <input id="ai-name" autoComplete="name" required maxLength={255} className="input h-10" value={name}
              onChange={(e) => setName(e.target.value)} disabled={busy} />
          </div>
        )}
        <div>
          <label htmlFor="ai-password" className="label">{info.has_account ? 'Your password' : 'Choose a password'}</label>
          <input id="ai-password" type="password" required autoComplete={info.has_account ? 'current-password' : 'new-password'}
            minLength={info.has_account ? 1 : 12} className="input h-10" value={password}
            onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {info.has_account ? `You already have an account with this email: enter its password to join ${info.org_name}.` : 'At least 12 characters.'}
          </p>
        </div>
        {!info.has_account && (
          <label className="flex items-start gap-2.5 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" checked={terms}
              onChange={(e) => setTerms(e.target.checked)} disabled={busy} />
            <span>I agree to the <Link to="/terms" target="_blank" className="underline">Terms of Service</Link> and <Link to="/privacy" target="_blank" className="underline">Privacy Policy</Link>.</span>
          </label>
        )}
        <FormError text={error} />
        <button type="submit" className="btn-primary h-10 w-full"
          disabled={busy || !password || (!info.has_account && (!name.trim() || password.length < 12 || !terms))}>
          {busy ? <Busy>Joining…</Busy> : `Join ${info.org_name}`}
        </button>
      </form>
    </AuthShell>
  );
}

// ── Verify email ─────────────────────────────────────────────────────────

export function VerifyEmailPage(): React.ReactElement {
  const token = useToken();
  const { loading, refresh, user } = useAuth();
  const [state, setState] = React.useState<'working' | 'ok' | 'bad'>('working');
  const [message, setMessage] = React.useState('');
  const started = React.useRef(false);

  React.useEffect(() => {
    if (started.current || loading) return;
    started.current = true;
    if (!token) {
      setState('bad');
      setMessage('This link is not valid.');
      return;
    }
    api.post('/api/auth/verify-email', { token })
      .then(() => { setState('ok'); return refresh(); })
      .catch((e) => { setState('bad'); setMessage(errorMessage(e)); });
  }, [token, loading, refresh]);

  if (state === 'ok' && user && !user.email.endsWith('@local')) {
    return (
      <AuthShell title="Email verified">
        <p className="mb-4 flex items-center gap-2 text-sm"><CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden="true" /> Thanks. You can launch campaigns now.</p>
        <Link to="/" className="btn-primary h-10 w-full">Go to the dashboard</Link>
      </AuthShell>
    );
  }
  if (state === 'ok') {
    return (
      <AuthShell title="Email verified">
        <p className="mb-4 flex items-center gap-2 text-sm"><CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden="true" /> Thanks. Sign in to continue.</p>
        <Link to="/login" className="btn-primary h-10 w-full">Sign in</Link>
      </AuthShell>
    );
  }
  if (state === 'bad') {
    return <AuthShell title="Link not valid"><p className="text-sm">{message} If you're signed in, you can resend it from the banner at the top of the dashboard.</p></AuthShell>;
  }
  return <AuthShell title="Verifying your email"><Loader2 className="mx-auto h-5 w-5 animate-spin" aria-label="Verifying" /></AuthShell>;
}
