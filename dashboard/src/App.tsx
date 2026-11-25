/**
 * Top-level app — router + React Query client + layout.
 *
 * Route restructure for the UX pass:
 *   - `/`          → Overview (new home, hero KPIs + tabs)
 *   - `/campaigns` → Campaigns list (was home)
 *   - `/campaigns/new` → wizard
 *   - `/prospects`, `/analytics`, `/settings` — unchanged
 *
 * Auth: <RequireAuth/> wraps every signed-in route. When the backend is
 * in local-auth mode and there's no session, it redirects to /login. In
 * bypass mode the guard is a no-op. /onboarding is full-screen (no
 * Layout); a company that hasn't finished setup is sent there after
 * sign-in and sees a "finish setup" banner inside the app.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import * as React from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';

import Layout from './components/Layout';
import { AuthProvider, useAuth } from './lib/authContext';
import { AcceptInvitePage, ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from './pages/AccountLinks';
import ActiveCampaigns from './pages/ActiveCampaigns';
import Analytics from './pages/Analytics';
import BusinessProfile from './pages/BusinessProfile';
import CampaignBuilder from './pages/CampaignBuilder';
import CampaignEditor from './pages/CampaignEditor';
import CampaignPlanner from './pages/CampaignPlanner';
import Connections from './pages/Connections';
import ImportLeads from './pages/ImportLeads';
import Inbox from './pages/Inbox';
import LinkedInDrafts from './pages/LinkedInDrafts';
import Legal from './pages/Legal';
import LoginPage from './pages/LoginPage';
import NewCampaign from './pages/NewCampaign';
import Onboarding from './pages/Onboarding';
import Overview from './pages/Overview';
import Platform from './pages/Platform';
import ProspectPipeline from './pages/ProspectPipeline';
import Settings from './pages/Settings';
import Calls from './pages/Calls';
import GetReady from './pages/GetReady';
import Plan from './pages/Plan';
import Privacy from './pages/Privacy';
import Team from './pages/Team';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

/** Signed in (or bypass mode) — else to /login, remembering where they were going. */
function RequireAuth(): React.ReactElement {
  const { user, loading, bypassMode } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!user && !bypassMode) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/terms" element={<Legal doc="terms" />} />
            <Route path="/privacy" element={<Legal doc="privacy" />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/accept-invite" element={<AcceptInvitePage />} />
            <Route path="/verify-email" element={<VerifyEmailPage />} />
            <Route element={<RequireAuth />}>
             <Route path="/onboarding" element={<Onboarding />} />
             <Route element={<Layout />}>
              <Route path="/" element={<Overview />} />
              <Route path="/get-ready" element={<GetReady />} />
              <Route path="/campaigns" element={<ActiveCampaigns />} />
              <Route path="/campaigns/plan" element={<CampaignPlanner />} />
              <Route path="/campaigns/new" element={<NewCampaign />} />
              <Route path="/campaigns/new/manual" element={<CampaignBuilder />} />
              <Route path="/campaigns/:id/import" element={<ImportLeads />} />
              <Route path="/campaigns/:id/edit" element={<CampaignEditor />} />
              <Route path="/prospects" element={<ProspectPipeline />} />
              <Route path="/inbox" element={<Inbox />} />
              <Route path="/calls" element={<Calls />} />
              <Route path="/linkedin-drafts" element={<LinkedInDrafts />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/profile" element={<BusinessProfile />} />
              <Route path="/settings/connections" element={<Connections />} />
              <Route path="/settings/team" element={<Team />} />
              <Route path="/settings/plan" element={<Plan />} />
              <Route path="/settings/privacy" element={<Privacy />} />
              <Route path="/platform" element={<Platform />} />
             </Route>
            </Route>
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
