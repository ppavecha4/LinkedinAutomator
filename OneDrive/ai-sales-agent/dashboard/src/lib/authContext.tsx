/**
 * Auth context — who is signed in, to which organization, and whether
 * that organization has finished onboarding. Backs onto the local-auth
 * backend (services/api/src/routes/auth.ts).
 *
 * Flow:
 *   1. On mount: GET /api/auth/config (is sign-up open?) and
 *      GET /api/auth/me (session + org + onboarding state).
 *   2. login() / signup() set the session cookie, then refresh().
 *   3. switchOrg() re-issues the session for another org the user belongs to.
 *   4. logout() clears the cookie.
 *
 * In bypass mode (local dev, AUTH_MODE=bypass) /api/auth/me answers 404
 * and the user is treated as signed in; there is no org/onboarding state.
 */

import * as React from 'react';

import { api, ApiClientError } from './api';

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface User {
  email: string;
  org_id?: string;
  role?: OrgRole;
  uid?: string;
  /** False until they open the link we email them (only where email is set up). */
  email_verified?: boolean;
}

export interface OrgSummary {
  name: string;
  onboarding_completed_at: string | null;
}

export interface Membership {
  org_id: string;
  name: string;
  role: OrgRole;
}

export interface SignupInput {
  full_name: string;
  company: string;
  email: string;
  password: string;
  accept_terms: boolean;
  country?: string;
}

export interface AcceptInviteInput {
  token: string;
  password: string;
  full_name?: string;
  accept_terms?: boolean;
}

interface AuthState {
  user: User | null;
  org: OrgSummary | null;
  loading: boolean;
  /** True when the backend is in bypass mode — no real login required. */
  bypassMode: boolean;
  signupEnabled: boolean;
  /** Can the server email people? (password reset, invitations, verification) */
  emailEnabled: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  signup: (input: SignupInput) => Promise<void>;
  /** Join a company from an invitation link; signs the person in. */
  acceptInvite: (input: AcceptInviteInput) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
  /** True when a signed-in org still has onboarding to finish. */
  needsOnboarding: boolean;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [state, setState] = React.useState<AuthState>({
    user: null,
    org: null,
    loading: true,
    bypassMode: false,
    signupEnabled: false,
    emailEnabled: false,
  });

  const refresh = React.useCallback(async () => {
    let signupEnabled = false;
    let emailEnabled = false;
    try {
      const { data } = await api.get<{ signup_enabled: boolean; email_enabled?: boolean }>('/api/auth/config');
      signupEnabled = !!data.signup_enabled;
      emailEnabled = !!data.email_enabled;
    } catch {
      // older API without /config: sign-up stays hidden
    }
    try {
      const { data } = await api.get<{ user: User; org: OrgSummary | null }>('/api/auth/me');
      setState({ user: data.user, org: data.org, loading: false, bypassMode: false, signupEnabled, emailEnabled });
    } catch (e) {
      // 404 on /api/auth/me means the backend isn't running local auth
      // (AUTH_MODE=bypass or cognito): treat as signed in and let the
      // backend's auth middleware enforce things its own way.
      if (e instanceof ApiClientError && e.status === 404) {
        setState({ user: { email: 'bypass@local' }, org: null, loading: false, bypassMode: true, signupEnabled, emailEnabled });
        return;
      }
      setState({ user: null, org: null, loading: false, bypassMode: false, signupEnabled, emailEnabled });
    }
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const login = React.useCallback(
    async (email: string, password: string) => {
      await api.post('/api/auth/login', { email, password });
      await refresh();
    },
    [refresh],
  );

  const signup = React.useCallback(
    async (input: SignupInput) => {
      await api.post('/api/auth/signup', input);
      await refresh();
    },
    [refresh],
  );

  const acceptInvite = React.useCallback(
    async (input: AcceptInviteInput) => {
      await api.post('/api/auth/accept-invite', input);
      await refresh();
    },
    [refresh],
  );

  const switchOrg = React.useCallback(
    async (orgId: string) => {
      await api.post('/api/auth/switch-org', { org_id: orgId });
      await refresh();
    },
    [refresh],
  );

  const logout = React.useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // ignore — still drop the local state and redirect
    }
    setState((s) => ({ ...s, user: null, org: null, loading: false, bypassMode: false }));
  }, []);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      ...state,
      login,
      signup,
      acceptInvite,
      logout,
      refresh,
      switchOrg,
      needsOnboarding: !!state.user && !state.bypassMode && !!state.org && !state.org.onboarding_completed_at,
    }),
    [state, login, signup, acceptInvite, logout, refresh, switchOrg],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Turn an API error into one sentence a person can act on. */
export function errorMessage(e: unknown, fallback = 'Something went wrong. Try again.'): string {
  const msg = rawErrorMessage(e, fallback);
  return msg.charAt(0).toUpperCase() + msg.slice(1);
}

function rawErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiClientError) {
    const issues = (e.details as { issues?: Array<{ path?: unknown[]; message?: string }> } | undefined)?.issues;
    if (issues?.length) {
      const first = issues[0];
      const where = Array.isArray(first.path) && first.path.length ? `${first.path.join(' › ')}: ` : '';
      return `${where}${first.message ?? e.message}`;
    }
    if (e.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
    return e.message || fallback;
  }
  return fallback;
}
