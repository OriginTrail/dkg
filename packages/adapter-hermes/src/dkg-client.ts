import {
  type HermesChannelHealthResponse,
  type HermesChannelPersistTurnPayload,
  type HermesChannelSendPayload,
  type HermesChannelSendResponse,
  type HermesLocalAgentIntegrationPayload,
} from './types.js';

export interface HermesDkgClientOptions {
  baseUrl?: string;
  apiToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HermesDkgClient {
  readonly baseUrl: string;
  private readonly apiToken: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HermesDkgClientOptions = {}) {
    this.baseUrl = stripTrailingSlashes(options.baseUrl ?? 'http://127.0.0.1:9200');
    this.apiToken = options.apiToken;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async connectHermesIntegration(
    payload: Partial<HermesLocalAgentIntegrationPayload> = {},
  ): Promise<{ ok?: boolean; integration?: unknown; notice?: string }> {
    return this.post('/api/local-agent-integrations/connect', {
      id: 'hermes',
      name: 'Hermes',
      description: 'Connect a local Hermes agent through the DKG node.',
      enabled: true,
      capabilities: {
        localChat: true,
        chatAttachments: true,
        connectFromUi: true,
        installNode: true,
        dkgPrimaryMemory: true,
        wmImportPipeline: true,
        nodeServedSkill: true,
        ...payload.capabilities,
      },
      transport: {
        kind: 'hermes-channel',
        ...payload.transport,
      },
      manifest: {
        packageName: '@origintrail-official/dkg-adapter-hermes',
        setupEntry: './setup.js',
        ...payload.manifest,
      },
      metadata: payload.metadata,
      runtime: payload.runtime ?? {
        status: 'configured',
        ready: false,
        lastError: null,
      },
    } satisfies HermesLocalAgentIntegrationPayload);
  }

  async getHermesChannelHealth(): Promise<HermesChannelHealthResponse> {
    return this.get('/api/hermes-channel/health');
  }

  async sendHermesMessage(payload: HermesChannelSendPayload): Promise<HermesChannelSendResponse> {
    return this.post('/api/hermes-channel/send', payload);
  }

  async persistHermesTurn(payload: HermesChannelPersistTurnPayload): Promise<{ ok?: boolean; turnId?: string }> {
    return this.post('/api/hermes-channel/persist-turn', payload);
  }

  async streamHermesMessage(
    payload: HermesChannelSendPayload,
    onEvent: (event: unknown) => void,
  ): Promise<void> {
    const response = await this.request('/api/hermes-channel/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...this.authHeaders(),
      },
      body: JSON.stringify(payload),
    });
    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeSseBuffer(buffer, onEvent, false);
    }
    buffer += decoder.decode();
    consumeSseBuffer(buffer, onEvent, true);
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.request(path, {
      method: 'GET',
      headers: { Accept: 'application/json', ...this.authHeaders() },
    });
    return response.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...this.authHeaders(),
      },
      body: JSON.stringify(body),
    });
    return response.json() as Promise<T>;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(redact(`DKG daemon ${path} responded ${response.status}: ${body}`, this.apiToken));
    }
    return response;
  }

  private authHeaders(): Record<string, string> {
    return this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {};
  }
}

export function redact(value: string, token?: string): string {
  let out = value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  if (token) {
    out = out.split(token).join('[REDACTED]');
  }
  return out;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function consumeSseBuffer(
  input: string,
  onEvent: (event: unknown) => void,
  finalFlush: boolean,
): string {
  let buffer = input;
  let lineEnd = buffer.indexOf('\n');
  while (lineEnd !== -1) {
    const line = buffer.slice(0, lineEnd).trim();
    buffer = buffer.slice(lineEnd + 1);
    lineEnd = buffer.indexOf('\n');
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try {
      onEvent(JSON.parse(data));
    } catch {
      // Ignore malformed frames; callers still receive later valid frames.
    }
  }

  if (finalFlush && buffer.trim().startsWith('data:')) {
    const data = buffer.trim().slice(5).trim();
    if (data) {
      try {
        onEvent(JSON.parse(data));
      } catch {
        // Ignore malformed final frame.
      }
    }
    return '';
  }
  return buffer;
}
