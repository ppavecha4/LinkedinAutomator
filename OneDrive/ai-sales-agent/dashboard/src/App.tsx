/**
 * Top-level app — router + React Query client + layout.
 *
 * Route restructure for the UX pass:
 *   - `/`          → Overview (new home, hero KPIs + tabs)
 *   - `/campaigns` → Campaigns list (was home)
 *   - `/campaigns/new` → wizard
 *   - `/prospects`, `/analytics`, `/settings` — unchanged
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

import Layout from './components/Layout';
import ActiveCampaigns from './pages/ActiveCampaigns';
import Analytics from './pages/Analytics';
import CampaignBuilder from './pages/CampaignBuilder';
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

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Overview />} />
            <Route path="/campaigns" element={<ActiveCampaigns />} />
            <Route path="/campaigns/new" element={<CampaignBuilder />} />
            <Route path="/prospects" element={<ProspectPipeline />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
