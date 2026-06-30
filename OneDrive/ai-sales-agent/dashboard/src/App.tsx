/**
 * Top-level app — router + React Query client + layout.
 *
 * Route restructure for the UX pass:
 *   - `/`          → Overview (new home, hero KPIs + tabs)
 *   - `/campaigns` → Campaigns list (was home)
 *   - `/campaigns/new` → wizard
 *   - `/prospects`, `/analytics`, `/settings` — unchanged
 *
 * Auth: a thin <ProtectedRoutes/> guard wraps Layout. When the backend
 * is in local-auth mode and there's no session, it redirects to /login.
 * In bypass mode the guard is a no-op.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import * as React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import Layout from './components/Layout';
import { AuthProvider, useAuth } from './lib/authContext';
import ActiveCampaigns from './pages/ActiveCampaigns';
import Analytics from './pages/Analytics';
import CampaignBuilder from './pages/CampaignBuilder';
import CampaignEditor from './pages/CampaignEditor';
import LinkedInDrafts from './pages/LinkedInDrafts';
import LoginPage from './pages/LoginPage';
import Overview from './pages/Overview';
import ProspectPipeline from './pages/ProspectPipeline';
import Settings from './pages/Settings';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

function ProtectedRoutes(): React.ReactElement {
  const { user, loading, bypassMode } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!user && !bypassMode) {
    return <Navigate to="/login" replace />;
  }
  return <Layout />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<ProtectedRoutes />}>
              <Route path="/" element={<Overview />} />
              <Route path="/campaigns" element={<ActiveCampaigns />} />
              <Route path="/campaigns/new" element={<CampaignBuilder />} />
              <Route path="/campaigns/:id/edit" element={<CampaignEditor />} />
              <Route path="/prospects" element={<ProspectPipeline />} />
              <Route path="/linkedin-drafts" element={<LinkedInDrafts />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
