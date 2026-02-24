import { readApiPort, readPid, isProcessRunning } from './config.js';

export class ApiClient {
  private baseUrl: string;

  constructor(port: number) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  static async connect(): Promise<ApiClient> {
    const pid = await readPid();
    if (!pid || !isProcessRunning(pid)) {
      throw new Error('Daemon is not running. Start it with: dkg start');
    }
    const port = await readApiPort();
    if (!port) {
      throw new Error('Cannot read API port. Try restarting: dkg stop && dkg start');
    }
    return new ApiClient(port);
  }

  async status(): Promise<{
    name: string;
    peerId: string;
    uptimeMs: number;
    connectedPeers: number;
    relayConnected: boolean;
    multiaddrs: string[];
  }> {
    return this.get('/api/status');
  }

  async agents(): Promise<{
    agents: Array<{ agentUri: string; name: string; peerId: string; framework?: string }>;
  }> {
    return this.get('/api/agents');
  }

  async skills(): Promise<{
    skills: Array<{
      agentName: string; skillType: string;
      pricePerCall?: number; currency?: string;
    }>;
  }> {
    return this.get('/api/skills');
  }

  async sendChat(to: string, text: string): Promise<{ delivered: boolean; error?: string }> {
    return this.post('/api/chat', { to, text });
  }

  async messages(opts?: { peer?: string; since?: number; limit?: number }): Promise<{
    messages: Array<{
      ts: number; direction: 'in' | 'out';
      peer: string; peerName?: string; text: string;
    }>;
  }> {
    const params = new URLSearchParams();
    if (opts?.peer) params.set('peer', opts.peer);
    if (opts?.since) params.set('since', String(opts.since));
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.get(`/api/messages${qs ? '?' + qs : ''}`);
  }

  async connect(multiaddr: string): Promise<{ connected: boolean }> {
    return this.post('/api/connect', { multiaddr });
  }

  async shutdown(): Promise<void> {
    try {
      await this.post('/api/shutdown', {});
    } catch {
      // Connection may close before response
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((body as any).error ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((data as any).error ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }
}
