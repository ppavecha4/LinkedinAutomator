import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from 'sonner';

import App from './App';
import { TooltipProvider } from './components/ui/tooltip';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/*
     * TooltipProvider MUST wrap the whole app so every Tooltip instance
     * shares a controller (Radix requirement).
     *
     * Sonner `<Toaster />` is mounted here so any page can call
     * `toast.success(...)` without importing a React context.
     */}
    <TooltipProvider delayDuration={200}>
      <App />
      <Toaster
        theme="system"
        position="bottom-right"
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
  </React.StrictMode>,
);
