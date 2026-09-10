import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearLocalLlmSession,
  connectLocalAgentIntegration,
  fetchLocalAgentHistory,
  fetchLocalAgentIntegrations,
  streamLocalAgentChat,
} from '../src/ui/api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function localLlmRecord() {
  return {
    id: 'local-llm',
    name: 'DKG Local LLM',
    description: 'Chat with a local llama.cpp or Ollama model through the DKG MCP tool surface.',
    enabled: true,
    transport: { kind: 'dkg-local-llm' },
    capabilities: { localChat: true, connectFromUi: false },
    runtime: { status: 'configured', ready: false, lastError: null },
    status: 'configured',
  };
}

describe('DKG Local LLM Node UI surface', () => {
  it('keeps the daemon-owned chat visible while the local LLM is offline and has no Connect flow', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/local-agent-integrations')) {
        return json({ integrations: [localLlmRecord()] });
      }
      if (url.endsWith('/api/local-llm/health')) {
        return json({
          ok: false,
          configured: true,
          ready: false,
          reachable: false,
          offline: true,
          readOnly: true,
          error: 'Local LLM server is offline: fetch failed',
        });
      }
      return json({ error: `Unexpected request: ${url}` }, 500);
    }) as typeof globalThis.fetch;

    const { integrations } = await fetchLocalAgentIntegrations();
    expect(integrations).toHaveLength(1);
    expect(integrations[0]).toMatchObject({
      id: 'local-llm',
      defaultSessionId: 'local-llm:dkg-ui',
      chatSupported: true,
      connectSupported: false,
      persistentChat: true,
      chatReady: false,
      status: 'bridge_offline',
      statusLabel: 'Bridge offline',
      error: 'Local LLM server is offline: fetch failed',
    });
    await expect(connectLocalAgentIntegration('local-llm')).rejects.toThrow(
      'local connect is not available',
    );
  });

  it('hides the daemon-owned chat when no local LLM is configured or reachable', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/local-agent-integrations')) {
        return json({ integrations: [localLlmRecord()] });
      }
      if (url.endsWith('/api/local-llm/health')) {
        return json({
          ok: false,
          configured: false,
          detected: false,
          ready: false,
          reachable: false,
          offline: true,
          readOnly: true,
          error: 'Local LLM server is offline: fetch failed',
        });
      }
      return json({ error: `Unexpected request: ${url}` }, 500);
    }) as typeof globalThis.fetch;

    await expect(fetchLocalAgentIntegrations()).resolves.toEqual({ integrations: [] });
  });

  it('hides an unrelated HTTP service on the default Local LLM port', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/local-agent-integrations')) {
        return json({ integrations: [localLlmRecord()] });
      }
      if (url.endsWith('/api/local-llm/health')) {
        return json({
          ok: false,
          configured: false,
          detected: false,
          ready: false,
          reachable: true,
          offline: false,
          readOnly: true,
          error: 'No compatible local LLM server was detected',
        });
      }
      return json({ error: `Unexpected request: ${url}` }, 500);
    }) as typeof globalThis.fetch;

    await expect(fetchLocalAgentIntegrations()).resolves.toEqual({ integrations: [] });
  });

  it('hides the same false positive from a v10.0.16 daemon without detected health', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/local-agent-integrations')) {
        return json({ integrations: [localLlmRecord()] });
      }
      if (url.endsWith('/api/local-llm/health')) {
        return json({
          ok: false,
          configured: false,
          ready: false,
          reachable: true,
          offline: false,
          readOnly: true,
          error: 'Local LLM server is reachable but not ready',
        });
      }
      return json({ error: `Unexpected request: ${url}` }, 500);
    }) as typeof globalThis.fetch;

    await expect(fetchLocalAgentIntegrations()).resolves.toEqual({ integrations: [] });
  });

  it('keeps a healthy v10.0.16 auto-detected LLM visible without detected health', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/local-agent-integrations')) {
        return json({ integrations: [localLlmRecord()] });
      }
      if (url.endsWith('/api/local-llm/health')) {
        return json({
          ok: true,
          configured: false,
          ready: true,
          reachable: true,
          offline: false,
          readOnly: true,
        });
      }
      return json({ error: `Unexpected request: ${url}` }, 500);
    }) as typeof globalThis.fetch;

    const { integrations } = await fetchLocalAgentIntegrations();
    expect(integrations).toHaveLength(1);
    expect(integrations[0]).toMatchObject({
      id: 'local-llm',
      detected: true,
      chatReady: true,
      status: 'chat_ready',
    });
  });

  it('shows an auto-detected default local LLM without environment overrides', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/local-agent-integrations')) {
        return json({ integrations: [localLlmRecord()] });
      }
      if (url.endsWith('/api/local-llm/health')) {
        return json({
          ok: true,
          configured: false,
          detected: true,
          ready: true,
          reachable: true,
          offline: false,
          readOnly: true,
        });
      }
      return json({ error: `Unexpected request: ${url}` }, 500);
    }) as typeof globalThis.fetch;

    const { integrations } = await fetchLocalAgentIntegrations();
    expect(integrations).toHaveLength(1);
    expect(integrations[0]).toMatchObject({
      id: 'local-llm',
      chatReady: true,
      status: 'chat_ready',
    });
  });

  it('shows an auto-detected Local LLM while its model is still loading', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/local-agent-integrations')) {
        return json({ integrations: [localLlmRecord()] });
      }
      if (url.endsWith('/api/local-llm/health')) {
        return json({
          ok: false,
          configured: false,
          detected: true,
          ready: false,
          reachable: true,
          offline: false,
          readOnly: true,
          error: 'llama.cpp model is still loading',
        });
      }
      return json({ error: `Unexpected request: ${url}` }, 500);
    }) as typeof globalThis.fetch;

    const { integrations } = await fetchLocalAgentIntegrations();
    expect(integrations).toHaveLength(1);
    expect(integrations[0]).toMatchObject({
      id: 'local-llm',
      detected: true,
      chatReady: false,
      error: 'llama.cpp model is still loading',
    });
  });

  it('posts the fixed session and active graph, then emits one final event with DKG metadata', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return json({
        text: 'Catalog evidence',
        sessionId: 'local-llm:dkg-ui',
        contextGraphId: 'testing',
        profile: 'catalog',
        toolCalls: [{ name: 'dkg_query_catalog_list', arguments: {} }],
        traceFile: '/tmp/local-llm.log',
        readOnly: true,
      });
    }) as typeof globalThis.fetch;
    const events: unknown[] = [];

    const result = await streamLocalAgentChat('local-llm', 'List saved queries', {
      sessionId: 'ignored-browser-session',
      contextGraphId: 'testing',
      onEvent: (event) => events.push(event),
    });

    expect(requests).toEqual([{
      url: '/api/local-llm/chat',
      body: {
        message: 'List saved queries',
        sessionId: 'local-llm:dkg-ui',
        contextGraphId: 'testing',
      },
    }]);
    expect(result).toMatchObject({
      text: 'Catalog evidence',
      profile: 'catalog',
      toolCalls: [{ name: 'dkg_query_catalog_list', arguments: {} }],
      traceFile: '/tmp/local-llm.log',
      readOnly: true,
    });
    expect(events).toEqual([{ type: 'final', ...result }]);
  });

  it('clears the daemon session with no client-controlled options', async () => {
    const fetchMock = vi.fn(async () => json({
      ok: true,
      sessionId: 'local-llm:dkg-ui',
      readOnly: true,
    }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await clearLocalLlmSession();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/local-llm/session/clear', expect.objectContaining({
      method: 'POST',
      body: '{}',
    }));
  });

  it('does not load persistent graph history for the in-memory v1 session', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await expect(fetchLocalAgentHistory('local-llm', 100, {
      sessionId: 'local-llm:dkg-ui',
    })).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
