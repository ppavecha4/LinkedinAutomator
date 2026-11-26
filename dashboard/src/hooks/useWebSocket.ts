/**
 * Dashboard WebSocket hook.
 *
 * Connects to the API's /ws endpoint, optionally scoped to a campaign, and
 * invokes `onEvent` for every inbound event. Auto-reconnects on close with
 * exponential backoff (capped at 30s).
 */

import { useEffect, useRef } from 'react';

import { API_BASE } from '../lib/api';
import type { WsEvent } from '../lib/types';

interface UseWebSocketOptions {
  campaignId?: string;
  onEvent?: (event: WsEvent) => void;
  enabled?: boolean;
}

function wsUrl(campaignId?: string): string {
  // No API address in the build means "same address as this page": keep its https, so the socket is wss.
  // A browser refuses (throws on) an insecure ws:// socket from an https page.
  const httpUrl = API_BASE.startsWith('http') ? API_BASE : window.location.origin;
  const wsBase = httpUrl.replace(/^http/, 'ws');
  const suffix = campaignId ? `?campaign_id=${encodeURIComponent(campaignId)}` : '';
  return `${wsBase}/ws${suffix}`;
}

export function useWebSocket({
  campaignId,
  onEvent,
  enabled = true,
}: UseWebSocketOptions) {
  const socketRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;

    function connect() {
      if (cancelled) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl(campaignId));
      } catch (err) {
        // Live updates are an extra: failing to open them must never take the page down.
        console.warn('live updates unavailable', err);
        return;
      }
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        reconnectAttempt = 0;
      });
      socket.addEventListener('message', (ev) => {
        try {
          const parsed = JSON.parse(ev.data) as WsEvent;
          onEventRef.current?.(parsed);
        } catch {
          // ignore malformed server messages
        }
      });
      socket.addEventListener('close', () => {
        if (cancelled) return;
        reconnectAttempt += 1;
        const delay = Math.min(30_000, 500 * 2 ** reconnectAttempt);
        reconnectTimer = window.setTimeout(connect, delay);
      });
      socket.addEventListener('error', () => {
        socket.close();
      });
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [campaignId, enabled]);
}
