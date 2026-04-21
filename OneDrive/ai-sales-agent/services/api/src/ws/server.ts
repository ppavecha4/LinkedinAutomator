/**
 * WebSocket server — dashboard real-time channel.
 *
 * Topology:
 *   - Clients connect to `ws://host/ws?campaign_id=<uuid>` (optionally).
 *   - Each socket is assigned to room(s) based on query param + explicit
 *     { type: 'subscribe', campaign_id } messages.
 *   - `broadcast(event)` fans out to all sockets in the relevant room.
 *
 * Supported event types (from Session 5 spec):
 *   CAMPAIGN_STARTED    {campaign_id, timestamp}
 *   PROSPECT_CONTACTED  {contact_id, channel, pitch_type}
 *   REPLY_RECEIVED      {contact_id, channel, intent, preview}
 *   MEETING_BOOKED      {contact_id, company_name, scheduled_at}
 *   MESSAGE_OPENED      {message_id, contact_id}
 *   RATE_LIMIT_HIT      {channel, campaign_id}
 *   COMPLIANCE_BLOCK    {contact_id, reason}
 *
 * Events carry a room key — events tied to a specific campaign go to
 * `campaign_{id}`; unscoped events (e.g. a rate-limit alert without a
 * campaign_id) broadcast to the tenant-global `all` room.
 */

import type { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';

import { logger } from '../logger';

type EventType =
  | 'CAMPAIGN_STARTED'
  | 'PROSPECT_CONTACTED'
  | 'REPLY_RECEIVED'
  | 'MEETING_BOOKED'
  | 'MESSAGE_OPENED'
  | 'RATE_LIMIT_HIT'
  | 'COMPLIANCE_BLOCK';

export interface DashboardEvent {
  type: EventType;
  campaign_id?: string;
  payload: Record<string, unknown>;
  timestamp?: string;
}

interface RoomMember {
  socket: WebSocket;
  rooms: Set<string>;
}

export class DashboardHub {
  private wss: WebSocketServer | null = null;
  private members = new Set<RoomMember>();

  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (socket, request) => this.onConnection(socket, request));
    logger.info('websocket hub attached at /ws');
  }

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? '', 'http://localhost');
    const campaignId = url.searchParams.get('campaign_id');
    const member: RoomMember = {
      socket,
      rooms: new Set(['all']),
    };
    if (campaignId) {
      member.rooms.add(`campaign_${campaignId}`);
    }
    this.members.add(member);

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          campaign_id?: string;
        };
        if (msg.type === 'subscribe' && msg.campaign_id) {
          member.rooms.add(`campaign_${msg.campaign_id}`);
          socket.send(
            JSON.stringify({
              type: 'SUBSCRIBED',
              room: `campaign_${msg.campaign_id}`,
            }),
          );
        } else if (msg.type === 'unsubscribe' && msg.campaign_id) {
          member.rooms.delete(`campaign_${msg.campaign_id}`);
        } else if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // ignore malformed client messages
      }
    });

    socket.on('close', () => {
      this.members.delete(member);
    });
    socket.on('error', (err) => {
      logger.warn('ws socket error', { error: (err as Error).message });
      this.members.delete(member);
    });

    socket.send(JSON.stringify({ type: 'HELLO', rooms: Array.from(member.rooms) }));
  }

  broadcast(event: DashboardEvent): void {
    const room = event.campaign_id ? `campaign_${event.campaign_id}` : 'all';
    const payload = JSON.stringify({
      type: event.type,
      campaign_id: event.campaign_id,
      timestamp: event.timestamp ?? new Date().toISOString(),
      ...event.payload,
    });
    let delivered = 0;
    for (const member of this.members) {
      if (member.rooms.has(room) || member.rooms.has('all')) {
        try {
          member.socket.send(payload);
          delivered += 1;
        } catch {
          // dropped socket — will be cleaned up on close event
        }
      }
    }
    logger.debug('ws broadcast', {
      type: event.type,
      room,
      delivered,
    });
  }

  close(): void {
    this.wss?.close();
    for (const m of this.members) {
      try {
        m.socket.close();
      } catch {
        /* ignore */
      }
    }
    this.members.clear();
  }
}

// Process-wide singleton — routes import this directly.
export const dashboardHub = new DashboardHub();
