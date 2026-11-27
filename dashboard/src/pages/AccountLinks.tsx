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

import { rich, t } from '../i18n';
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

  if (loading) return <AuthShell title={t('Reset your password')}><Loader2 className="mx-auto h-5 w-5 animate-spin" aria-label={t('Loading')} /></AuthShell>;

  if (!emailEnabled) {
    return (
      <AuthShell title={t('Reset your password')}>
        <p className="text-sm">
          {rich('Reset links by email are not set up yet. Ask your company\'s owner or an admin to send you a reset link from <where>Settings › Team</where>, or write to {email}.', {
            where: (words) => <span className="font-medium">{words}</span>,
            email: <a className="underline" href="mailto:info@appsontechnologies.in">info@appsontechnologies.in</a>,
          })}
        </p>
      </AuthShell>
    );
  }
  if (sent) {
    return (
      <AuthShell title={t('Check your email')}>
        <p className="text-sm">
          {t('If an account exists for')}{' '}<span className="font-medium">{email.trim()}</span>{t(', we\'ve sent a link to reset the password. It works once and expires in an hour.')}
        </p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={t('Reset your password')} intro={t('Enter your work email and we\'ll send you a link to choose a new password.')}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="fp-email" className="label">{t('Work email')}</label>
          <input id="fp-email" type="email" autoComplete="email" required className="input h-10" value={email}
            onChange={(e) => setEmail(e.target.value)} disabled={busy} placeholder="you@company.com" />
        </div>
        <FormError text={error} />
        <button type="submit" className="btn-primary h-10 w-full" disabled={busy || !email.trim()}>
          {busy ? <Busy>{t('Sending…')}</Busy> : t('Send reset link')}
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

  if (!token) return <AuthShell title={t('This link isn\'t valid')}><p className="text-sm">{rich('Open the link from your email again, or <ask>ask for a new one</ask>.', { ask: (words) => <Link className="underline" to="/forgot-password">{words}</Link> })}</p></AuthShell>;
  if (done) {
    return (
      <AuthShell title={t('Password changed')}>
        <p className="mb-4 flex items-center gap-2 text-sm"><CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden="true" />{' '}{t('You can now sign in with your new password. Any other device was signed out.')}</p>
        <Link to="/login" className="btn-primary h-10 w-full">{t('Sign in')}</Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={t('Choose a new password')}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="rp-password" className="label">{t('New password')}</label>
          <input id="rp-password" type="password" autoComplete="new-password" required minLength={12} className="input h-10"
            value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          <p className="mt-1.5 text-xs text-muted-foreground">{t('At least 12 characters.')}</p>
        </div>
        <div>
          <label htmlFor="rp-again" className="label">{t('Repeat it')}</label>
          <input id="rp-again" type="password" autoComplete="new-password" required className="input h-10"
            value={again} onChange={(e) => setAgain(e.target.value)} disabled={busy} />
          {mismatch && <p className="mt-1.5 text-xs text-destructive">{t('The two passwords don\'t match.')}</p>}
        </div>
        <FormError text={error} />
        <button type="submit" className="btn-primary h-10 w-full" disabled={busy || password.length < 12 || password !== again}>
          {busy ? <Busy>{t('Saving…')}</Busy> : t('Change password')}
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
    if (!token) return setGone(t('This invitation link is not valid.'));
    api.get<InviteInfo>(`/api/auth/invite?token=${encodeURIComponent(token)}`)
      .then(({ data }) => setInfo(data))
      .catch((e) => setGone(e instanceof ApiClientError && e.status === 404
        ? t('This invitation has expired or was withdrawn. Ask the person who invited you for a new one.')
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

  if (loading || (!info && !gone)) return <AuthShell title={t('Your invitation')}><Loader2 className="mx-auto h-5 w-5 animate-spin" aria-label={t('Loading')} /></AuthShell>;
  if (gone || !info) return <AuthShell title={t('Invitation not available')}><p className="text-sm">{gone}</p></AuthShell>;

  const signedInAsSomeoneElse = user && user.email.toLowerCase() !== info.email.toLowerCase() && !user.email.endsWith('@local');
  const intro = (
    <>{rich(
      info.role === 'admin' ? 'You\'ve been invited to join {org} as an <role>admin</role>.'
        : info.role === 'viewer' ? 'You\'ve been invited to join {org} as a <role>viewer</role>.'
        : info.role === 'owner' ? 'You\'ve been invited to join {org} as an <role>owner</role>.'
        : 'You\'ve been invited to join {org} as a <role>member</role>.',
      {
        org: <span className="font-medium text-foreground">{info.org_name}</span>,
        role: (words) => <span className="font-medium text-foreground">{words}</span>,
      },
    )}</>
  );

  return (
    <AuthShell title={t('Join your team')} intro={intro}>
      {signedInAsSomeoneElse && (
        <p className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
          {t('You\'re signed in as {email}. This invitation is for {email2}; continuing signs you in as them.', { email: user?.email, email2: info.email })}
        </p>
      )}
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="ai-email" className="label">{t('Email')}</label>
          <input id="ai-email" className="input h-10" value={info.email} readOnly aria-readonly="true" />
        </div>
        {!info.has_account && (
          <div>
            <label htmlFor="ai-name" className="label">{t('Your name')}</label>
            <input id="ai-name" autoComplete="name" required maxLength={255} className="input h-10" value={name}
              onChange={(e) => setName(e.target.value)} disabled={busy} />
          </div>
        )}
        <div>
          <label htmlFor="ai-password" className="label">{info.has_account ? t('Your password') : t('Choose a password')}</label>
          <input id="ai-password" type="password" required autoComplete={info.has_account ? 'current-password' : 'new-password'}
            minLength={info.has_account ? 1 : 12} className="input h-10" value={password}
            onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {info.has_account ? t('You already have an account with this email: enter its password to join {org_name}.', { org_name: info.org_name }) : t('At least 12 characters.')}
          </p>
        </div>
        {!info.has_account && (
          <label className="flex items-start gap-2.5 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" checked={terms}
              onChange={(e) => setTerms(e.target.checked)} disabled={busy} />
            <span>{rich('I agree to the <terms>Terms of Service</terms> and <privacy>Privacy Policy</privacy>.', {
          terms: (words) => <Link to="/terms" target="_blank" className="underline">{words}</Link>,
          privacy: (words) => <Link to="/privacy" target="_blank" className="underline">{words}</Link>,
        })}</span>
          </label>
        )}
        <FormError text={error} />
        <button type="submit" className="btn-primary h-10 w-full"
          disabled={busy || !password || (!info.has_account && (!name.trim() || password.length < 12 || !terms))}>
          {busy ? <Busy>{t('Joining…')}</Busy> : t('Join {org_name}', { org_name: info.org_name })}
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
      setMessage(t('This link is not valid.'));
      return;
    }
    api.post('/api/auth/verify-email', { token })
      .then(() => { setState('ok'); return refresh(); })
      .catch((e) => { setState('bad'); setMessage(errorMessage(e)); });
  }, [token, loading, refresh]);

  if (state === 'ok' && user && !user.email.endsWith('@local')) {
    return (
      <AuthShell title={t('Email verified')}>
        <p className="mb-4 flex items-center gap-2 text-sm"><CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden="true" />{' '}{t('Thanks. You can launch campaigns now.')}</p>
        <Link to="/" className="btn-primary h-10 w-full">{t('Go to the dashboard')}</Link>
      </AuthShell>
    );
  }
  if (state === 'ok') {
    return (
      <AuthShell title={t('Email verified')}>
        <p className="mb-4 flex items-center gap-2 text-sm"><CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden="true" />{' '}{t('Thanks. Sign in to continue.')}</p>
        <Link to="/login" className="btn-primary h-10 w-full">{t('Sign in')}</Link>
      </AuthShell>
    );
  }
  if (state === 'bad') {
    return <AuthShell title={t('Link not valid')}><p className="text-sm">{t('{message} If you\'re signed in, you can resend it from the banner at the top of the dashboard.', { message })}</p></AuthShell>;
  }
  return <AuthShell title={t('Verifying your email')}><Loader2 className="mx-auto h-5 w-5 animate-spin" aria-label={t('Verifying')} /></AuthShell>;
}
