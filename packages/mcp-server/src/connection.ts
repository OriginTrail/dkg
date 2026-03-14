import {
  readDaemonPid,
  isProcessAlive,
  readDkgApiPort,
  loadAuthToken,
} from '@origintrail-official/dkg-core';

export class DkgClient {
  private baseUrl: string;
  private token?: string;

  constructor(port: number, token?: string) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.token = token;
  }

  static async connect(): Promise<DkgClient> {
    const port = await readDkgApiPort();

    if (!port) {
      const pid = await readDaemonPid();
      if (!pid || !isProcessAlive(pid)) {
        throw new Error('DKG daemon is not running. Start it with: dkg start');
      }
      throw new Error('Cannot read API port. Set DKG_API_PORT or restart: dkg stop && dkg start');
    }

    const token = await loadAuthToken();
    return new DkgClient(port, token);
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) return {};
    return { Authorization: `Bearer ${this.token}` };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((body as Record<string, unknown>).error as string ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((data as Record<string, unknown>).error as string ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  async status() {
    return this.get<{
      name: string;
      peerId: string;
      nodeRole?: string;
      networkId?: string;
      uptimeMs: number;
      connectedPeers: number;
      relayConnected: boolean;
      multiaddrs: string[];
    }>('/api/status');
  }

  async query(sparql: string, paranetId?: string) {
    return this.post<{ result: unknown }>('/api/query', { sparql, paranetId });
  }

  async publish(paranetId: string, quads: Array<{
    subject: string; predicate: string; object: string; graph: string;
  }>) {
    return this.post<{
      kcId: string;
      status: string;
      kas: Array<{ tokenId: string; rootEntity: string }>;
      txHash?: string;
    }>('/api/publish', { paranetId, quads });
  }

  async listParanets() {
    return this.get<{
      paranets: Array<{
        id: string; uri: string; name: string;
        description?: string; creator?: string;
        createdAt?: string; isSystem: boolean;
      }>;
    }>('/api/paranet/list');
  }

  async createParanet(id: string, name: string, description?: string) {
    return this.post<{ created: string; uri: string }>(
      '/api/paranet/create', { id, name, description },
    );
  }

  async agents() {
    return this.get<{
      agents: Array<{
        agentUri: string; name: string; peerId: string;
        framework?: string; nodeRole?: string;
      }>;
    }>('/api/agents');
  }

  async subscribe(paranetId: string) {
    return this.post<{ subscribed: string }>('/api/subscribe', { paranetId });
  }
}
