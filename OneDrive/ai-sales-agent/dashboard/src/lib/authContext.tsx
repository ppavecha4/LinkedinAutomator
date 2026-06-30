/**
 * Auth context — tracks whether the operator is logged in and exposes
 * login/logout helpers. Backs onto the local-auth backend (see
 * services/api/src/routes/auth.ts).
 *
 * Flow:
 *   1. On mount, GET /api/auth/me decides whether to show the app or
 *      redirect to /login (handled by ProtectedRoute).
 *   2. LoginPage calls login() → POST /api/auth/login → cookie set.
 *   3. logout() → POST /api/auth/logout → cookie cleared → redirect /login.
 *
 * In bypass mode (local dev, AUTH_MODE=bypass), /api/auth/me returns 404
 * and we treat the user as always logged in.
 */

import * as React from 'react';

import { api, ApiClientError } from './api';

interface User {
  email: string;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  /** True when the backend is in bypass mode — no real login required. */
  bypassMode: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [state, setState] = React.useState<AuthState>({
    user: null,
    loading: true,
    bypassMode: false,
  });

  const refresh = React.useCallback(async () => {
    try {
      const { data } = await api.get<{ user: User }>('/api/auth/me');
      setState({ user: data.user, loading: false, bypassMode: false });
    } catch (e) {
      // 404 on /api/auth/me means the backend isn't running local auth
      // (i.e. AUTH_MODE=bypass or cognito). Treat as logged in — the
      // backend's auth middleware will enforce things its own way.
      if (e instanceof ApiClientError && e.status === 404) {
        setState({
          user: { email: 'bypass@local' },
          loading: false,
          bypassMode: true,
        });
        return;
      }
      setState({ user: null, loading: false, bypassMode: false });
    }
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const login = React.useCallback(
    async (email: string, password: string) => {
      await api.post<{ user: User }>('/api/auth/login', { email, password });
      await refresh();
    },
    [refresh],
  );

  const logout = React.useCallback(async () => {
    try {
      await api.post<{ ok: boolean }>('/api/auth/logout');
    } catch {
      // ignore — still want to drop the local state and redirect
    }
    setState({ user: null, loading: false, bypassMode: false });
  }, []);

  const value = React.useMemo(
    () => ({ ...state, login, logout, refresh }),
    [state, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
