import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    watch: { usePolling: true },
    // Vite 5+ blocks requests whose Host header isn't on this list.
    // 'all' is fine because Caddy is the only thing reaching the
    // dashboard container — host validation belongs at the edge.
    allowedHosts: true,
    // Caddy fronts HMR over WSS at :443.
    // Disable the error overlay — the public dev server gets hit by bot
    // scans (e.g. /app/sweeper/signer.json) whose failed transforms
    // would otherwise throw a full-screen overlay over the real page.
    hmr: { clientPort: 443, protocol: 'wss', overlay: false },
  },
});
