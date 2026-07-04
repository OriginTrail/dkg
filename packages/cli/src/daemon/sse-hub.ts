import type { ServerResponse } from "node:http";

export interface SseDashboardSession {
  sessionId: string;
  expiresAt: number;
  compatToken: string;
}

export interface SseSubscription {
  close(): void;
}

interface SseClient {
  res: ServerResponse;
  dashboardSessionId?: string;
  dashboardSessionCompatToken?: string;
  heartbeat?: ReturnType<typeof setInterval>;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

export interface SseHub {
  add(res: ServerResponse, dashboardSession?: SseDashboardSession): SseSubscription;
  broadcast(event: string, payload: Record<string, unknown>): void;
  closeSession(sessionId: string): void;
  size(): number;
}

export function createSseHub(options: {
  heartbeatMs?: number;
  isDashboardSessionTokenValid?: (token: string) => boolean;
} = {}): SseHub {
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const clients = new Set<SseClient>();

  function remove(client: SseClient): void {
    if (!clients.delete(client)) return;
    if (client.heartbeat) clearInterval(client.heartbeat);
    if (client.expiryTimer) clearTimeout(client.expiryTimer);
  }

  function close(client: SseClient): void {
    remove(client);
    if (!client.res.writableEnded) {
      try { client.res.end(); } catch { /* already closed */ }
    }
  }

  function add(res: ServerResponse, dashboardSession?: SseDashboardSession): SseSubscription {
    const client: SseClient = {
      res,
      dashboardSessionId: dashboardSession?.sessionId,
      dashboardSessionCompatToken: dashboardSession?.compatToken,
    };
    if (dashboardSession) {
      const delayMs = Math.max(0, dashboardSession.expiresAt - Date.now());
      client.expiryTimer = setTimeout(() => close(client), delayMs);
    }
    clients.add(client);
    client.heartbeat = setInterval(() => {
      const tokenStillValid = !client.dashboardSessionCompatToken ||
        options.isDashboardSessionTokenValid?.(client.dashboardSessionCompatToken) !== false;
      if (!tokenStillValid) {
        close(client);
        return;
      }
      try { res.write(`: heartbeat\n\n`); } catch { close(client); }
    }, heartbeatMs);
    return { close: () => close(client) };
  }

  function broadcast(event: string, payload: Record<string, unknown>): void {
    const data = JSON.stringify(payload);
    const msg = `event: ${event}\ndata: ${data}\n\n`;
    for (const client of clients) {
      try { client.res.write(msg); } catch { close(client); }
    }
  }

  function closeSession(sessionId: string): void {
    for (const client of Array.from(clients)) {
      if (client.dashboardSessionId === sessionId) close(client);
    }
  }

  return {
    add,
    broadcast,
    closeSession,
    size: () => clients.size,
  };
}
