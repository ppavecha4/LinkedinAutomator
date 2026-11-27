import { DirectionProvider } from '@radix-ui/react-direction';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from 'sonner';

import { TooltipProvider } from './components/ui/tooltip';
import { direction, initI18n, t } from './i18n';
import './index.css';

async function start(): Promise<void> {
  // The language file first: the app's modules read their sentences as they load.
  await initI18n();
  const { default: App } = await import('./App');
  ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/*
     * TooltipProvider MUST wrap the whole app so every Tooltip instance
     * shares a controller (Radix requirement).
     *
     * Sonner `<Toaster />` is mounted here so any page can call
     * `toast.success(...)` without importing a React context.
     */}
    <DirectionProvider dir={direction()}>
    <TooltipProvider delayDuration={200}>
      <App />
      <Toaster
        theme="system"
        dir={direction()}
        containerAriaLabel={t('Notifications')}
        position={direction() === 'rtl' ? 'bottom-left' : 'bottom-right'}
        toastOptions={{
          style: {
            background: 'hsl(var(--card) / 0.9)',
            backdropFilter: 'blur(16px)',
            border: '1px solid hsl(var(--border))',
            color: 'hsl(var(--foreground))',
          },
          className: 'glass-strong',
        }}
      />
    </TooltipProvider>
    </DirectionProvider>
  </React.StrictMode>,
  );
}

void start();
