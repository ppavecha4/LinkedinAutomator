/**
 * Login page — single-user email + password gate. Rendered when the
 * operator hits any protected route without a valid session.
 */

import { Loader2, LogIn, ShieldCheck } from 'lucide-react';
import * as React from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { useAuth } from '../lib/authContext';

export default function LoginPage(): React.ReactElement {
  const { user, loading, bypassMode, login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // If a session is already active (or backend is in bypass mode),
  // skip the login form and send the operator to the dashboard.
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (user || bypassMode) {
    return <Navigate to="/" replace />;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate('/', { replace: true });
    } catch (e) {
      const msg =
        (e as { message?: string }).message || 'login failed — try again';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <ShieldCheck className="h-6 w-6" />
          </div>
        </div>

        <div className="glass-strong rounded-2xl p-6 gradient-border">
          <h1 className="text-xl font-semibold text-center">Sign in</h1>
          <p className="text-xs text-muted-foreground text-center mt-1 mb-5">
            Operator access to the AI Sales Agent dashboard.
          </p>

          <form onSubmit={onSubmit} className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Email
              </label>
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input h-10 text-sm w-full mt-1"
                placeholder="you@yourcompany.com"
                disabled={submitting}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Password
              </label>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input h-10 text-sm w-full mt-1"
                placeholder="••••••••"
                disabled={submitting}
              />
            </div>

            {error && (
              <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">
                {error}
              </div>
            )}

            <button
              type="submit"
              className="btn-primary w-full h-10 mt-2"
              disabled={submitting || !email || !password}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogIn className="h-4 w-4" />
              )}
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="text-[11px] text-muted-foreground text-center mt-4">
          Sessions last 7 days. Forgot your password? Contact the system admin.
        </p>
      </div>
    </div>
  );
}
