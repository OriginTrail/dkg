import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const UI_DIR = resolve(__dirname, '..', 'src', 'ui');
const CLI_DIR = resolve(__dirname, '..', '..', 'cli', 'src');

function readUiFile(rel: string): string {
  return readFileSync(resolve(UI_DIR, rel), 'utf-8');
}

function readCliFile(rel: string): string {
  return readFileSync(resolve(CLI_DIR, rel), 'utf-8');
}

describe('OpenClaw bridge API contract', () => {
  const apiSrc = readUiFile('api.ts');

  it('exports fetchOpenClawAgents (P2P, legacy)', () => {
    expect(apiSrc).toContain('fetchOpenClawAgents');
    expect(apiSrc).toMatch(/\/api\/openclaw-agents/);
  });

  it('exports sendOpenClawChat (P2P, legacy)', () => {
    expect(apiSrc).toContain('sendOpenClawChat');
    expect(apiSrc).toMatch(/\/api\/chat-openclaw/);
  });

  it('OpenClawAgent interface includes required fields', () => {
    expect(apiSrc).toContain('interface OpenClawAgent');
    expect(apiSrc).toMatch(/peerId:\s*string/);
    expect(apiSrc).toMatch(/name:\s*string/);
    expect(apiSrc).toMatch(/framework:\s*string/);
    expect(apiSrc).toMatch(/connected:\s*boolean/);
  });

  it('sendOpenClawChat response includes reply and timedOut', () => {
    expect(apiSrc).toMatch(/reply:\s*string\s*\|\s*null/);
    expect(apiSrc).toMatch(/timedOut:\s*boolean/);
    expect(apiSrc).toMatch(/delivered:\s*boolean/);
  });

  it('exports sendOpenClawLocalChat (local channel bridge)', () => {
    expect(apiSrc).toContain('sendOpenClawLocalChat');
    expect(apiSrc).toMatch(/\/api\/openclaw-channel\/send/);
  });

  it('exports fetchOpenClawLocalHealth', () => {
    expect(apiSrc).toContain('fetchOpenClawLocalHealth');
    expect(apiSrc).toMatch(/\/api\/openclaw-channel\/health/);
  });

  it('exports fetchOpenClawLocalHistory', () => {
    expect(apiSrc).toContain('fetchOpenClawLocalHistory');
    expect(apiSrc).toContain('getDefaultLocalAgentSessionId');
    expect(apiSrc).toContain('fetchMemorySession(sessionId, {');
    expect(apiSrc).toContain("order: 'desc'");
  });

  it('exports the future-friendly local agent integration contract', () => {
    expect(apiSrc).toContain('interface LocalAgentIntegration');
    expect(apiSrc).toContain('fetchLocalAgentIntegrations');
    expect(apiSrc).toContain('connectLocalAgentIntegration');
    expect(apiSrc).toContain('fetchLocalAgentHistory');
    expect(apiSrc).toContain('streamLocalAgentChat');
  });
});

describe('OpenClaw daemon endpoints', () => {
  const daemonSrc = readCliFile('daemon.ts');

  it('registers GET /api/openclaw-agents endpoint', () => {
    expect(daemonSrc).toContain("path === '/api/openclaw-agents'");
    expect(daemonSrc).toContain("req.method === 'GET'");
  });

  it('filters agents by OpenClaw framework', () => {
    expect(daemonSrc).toMatch(/findAgents\(\s*\{\s*framework:\s*'OpenClaw'\s*\}/);
  });

  it('registers POST /api/chat-openclaw endpoint', () => {
    expect(daemonSrc).toContain("path === '/api/chat-openclaw'");
    expect(daemonSrc).toContain("req.method === 'POST'");
  });

  it('chat-openclaw endpoint requires peerId and text', () => {
    expect(daemonSrc).toMatch(/Missing "peerId" or "text"/);
  });

  it('chat-openclaw endpoint polls for a reply with timeout', () => {
    expect(daemonSrc).toMatch(/TIMEOUT_MS/);
    expect(daemonSrc).toMatch(/POLL_MS/);
    expect(daemonSrc).toMatch(/timedOut/);
  });

  it('chat-openclaw persists outbound messages', () => {
    const chatOclawBlock = daemonSrc.slice(
      daemonSrc.indexOf("path === '/api/chat-openclaw'"),
      daemonSrc.indexOf("// POST /api/connect"),
    );
    expect(chatOclawBlock).toContain('insertChatMessage');
    expect(chatOclawBlock).toContain("direction: 'out'");
  });

  it('chat-openclaw resolves peer names', () => {
    const chatOclawBlock = daemonSrc.slice(
      daemonSrc.indexOf("path === '/api/chat-openclaw'"),
      daemonSrc.indexOf("// POST /api/connect"),
    );
    expect(chatOclawBlock).toContain('resolveNameToPeerId');
  });
});

describe('PanelRight UI - connected agent flow', () => {
  const panelRight = readUiFile('components/Shell/PanelRight.tsx');

  it('imports local-agent wrapper functions', () => {
    expect(panelRight).toContain('fetchLocalAgentIntegrations');
    expect(panelRight).toContain('connectLocalAgentIntegration');
    expect(panelRight).toContain('fetchLocalAgentHistory');
    expect(panelRight).toContain('streamLocalAgentChat');
  });

  it('defines the connected agents tab in PanelRight', () => {
    expect(panelRight).toContain('function ConnectedAgentsTab');
    expect(panelRight).toContain("useState<'agents' | 'network' | 'sessions'>('agents')");
    expect(panelRight).toContain('const ADD_AGENT_TAB_ID =');
  });

  it('removes the built-in assistant path and splits the right rail into three agent-first tabs', () => {
    expect(panelRight).not.toContain('Ask the built-in DKG assistant');
    expect(panelRight).not.toContain('streamChatMessage');
    expect(panelRight).toContain('Network');
    expect(panelRight).toContain('Sessions');
    expect(panelRight).toContain('function NetworkTab');
    expect(panelRight).toContain('function SessionsTab');
  });

  it('keeps the Agents tab as the persistent OpenClaw chat surface with sub-tabs and add-agent flow', () => {
    expect(panelRight).toContain('Connect OpenClaw');
    expect(panelRight).toContain('Connect Another Agent');
    expect(panelRight).toContain('Disconnect');
    expect(panelRight).toContain('Session history');
    expect(panelRight).toContain('OpenClaw');
    expect(panelRight).toContain('v10-agent-subtabs');
    expect(panelRight).toContain('v10-local-agent-chat-toolbar');
    expect(panelRight).not.toContain('Messages stay anchored in your private DKG memory graph');
  });

  it('keeps the + add-agent tab selected during background refreshes', () => {
    expect(panelRight).toContain('const preserveSelected = selectedIntegrationId === ADD_AGENT_TAB_ID');
    expect(panelRight).toContain("preferred && !autoFocusedLocalAgentRef.current && selectedIntegrationId !== ADD_AGENT_TAB_ID");
  });

  it('keeps local agent state keyed by session so non-default threads do not collapse to the default conversation', () => {
    expect(panelRight).toContain('selectedSessionId');
    expect(panelRight).toContain('localMessagesByConversation');
    expect(panelRight).toContain('getLocalAgentConversationStateKey');
    expect(panelRight).toContain('sessionId: conversation.sessionId ?? undefined');
    expect(panelRight).not.toContain('localHistoryLoadedByIntegration[integrationId] === true');
  });

  it('preserves the selected session when disconnecting or reopening a specific local-agent thread', () => {
    expect(panelRight).toContain('setSelectedIntegration(integrationId, { preserveSession: selectedIntegrationId === integrationId })');
    expect(panelRight).toContain('setSelectedIntegration(session.integrationId, { sessionId: session.sessionId })');
  });

  it('keeps the interface future-friendly for Hermes', () => {
    expect(panelRight).toContain('Hermes');
    expect(panelRight).toContain('same local-agent contract');
  });

  it('merges reloaded local history with live messages', () => {
    expect(panelRight).toContain('function mergeLocalAgentMessages');
    expect(panelRight).toContain('mergeLocalAgentMessages(prev, loaded)');
  });

  it('sends connected-agent chat through the local bridge from PanelRight', () => {
    expect(panelRight).toContain('streamLocalAgentChat(integrationId, text');
  });

  it('does not clear attached agents on a transient integrations refresh failure', () => {
    expect(panelRight).toContain('do not collapse an attached agent chat surface');
    expect(panelRight).not.toContain('setIntegrations([])');
  });
});

describe('Agent hub shell surfaces', () => {
  const panelLeft = readUiFile('components/Shell/PanelLeft.tsx');
  const panelCenter = readUiFile('components/Shell/PanelCenter.tsx');
  const agentHub = readUiFile('pages/AgentHub.tsx');

  it('keeps Integrations visible while hiding the duplicate Agent Hub shell entry', () => {
    expect(panelLeft).not.toContain('Agent Hub');
    expect(panelLeft).toContain('Integrations');
  });

  it('keeps the center-panel agent-hub route alive under the hood', () => {
    expect(panelCenter).toContain("activeTabId === 'agent-hub'");
    expect(panelCenter).toContain("Loading agent hub...");
    expect(panelCenter).toContain('AgentHubPage');
  });

  it('restores Agent Hub without reviving the old My Agent product path', () => {
    expect(agentHub).toContain('Agent Hub');
    expect(agentHub).toContain('Bring your own agent into the node');
    expect(agentHub).not.toContain('My Agent');
  });
});

describe('OpenClaw bridge behavioral tests', () => {
  beforeEach(() => {
    (globalThis as any).window = { __DKG_TOKEN__: undefined };
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  it('fetchOpenClawAgents calls GET /api/openclaw-agents', async () => {
    const mockAgents = [
      { peerId: '12D3abc', name: 'TestClaw', framework: 'OpenClaw', connected: true, lastSeen: Date.now(), latencyMs: 42 },
    ];
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ agents: mockAgents }),
    });
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const { fetchOpenClawAgents } = await import('../src/ui/api.js');
      const result = await fetchOpenClawAgents();
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      const calledUrl = fakeFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/openclaw-agents');
      expect(result.agents).toEqual(mockAgents);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sendOpenClawChat handles delivered + reply', async () => {
    const fakeResponse = { delivered: true, reply: 'Hello from OpenClaw!', timedOut: false, waitMs: 120 };
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => fakeResponse,
    });
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const { sendOpenClawChat } = await import('../src/ui/api.js');
      const result = await sendOpenClawChat('12D3abc', 'hello');
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = fakeFetch.mock.calls[0];
      expect(url).toContain('/api/chat-openclaw');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ peerId: '12D3abc', text: 'hello' });
      expect(result.delivered).toBe(true);
      expect(result.reply).toBe('Hello from OpenClaw!');
      expect(result.timedOut).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sendOpenClawChat handles delivered + timeout (no reply)', async () => {
    const fakeResponse = { delivered: true, reply: null, timedOut: true, waitMs: 30000 };
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => fakeResponse,
    });
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const { sendOpenClawChat } = await import('../src/ui/api.js');
      const result = await sendOpenClawChat('12D3abc', 'hello');
      expect(result.delivered).toBe(true);
      expect(result.reply).toBeNull();
      expect(result.timedOut).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sendOpenClawChat handles not-delivered response', async () => {
    const fakeResponse = { delivered: false, reply: null, timedOut: false, error: 'Agent offline' };
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => fakeResponse,
    });
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const { sendOpenClawChat } = await import('../src/ui/api.js');
      const result = await sendOpenClawChat('12D3abc', 'hello');
      expect(result.delivered).toBe(false);
      expect(result.reply).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.error).toBe('Agent offline');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sendOpenClawChat handles empty-string reply (not treated as no reply)', async () => {
    const fakeResponse = { delivered: true, reply: '', timedOut: false, waitMs: 50 };
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => fakeResponse,
    });
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const { sendOpenClawChat } = await import('../src/ui/api.js');
      const result = await sendOpenClawChat('12D3abc', 'hello');
      expect(result.delivered).toBe(true);
      expect(result.reply).toBe('');
      expect(result.timedOut).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('daemon handler captures waitStart before sendChat (timing race fix)', () => {
    const daemonSrc = readCliFile('daemon.ts');
    const chatOclawBlock = daemonSrc.slice(
      daemonSrc.indexOf("path === '/api/chat-openclaw'"),
      daemonSrc.indexOf("// POST /api/connect"),
    );
    const waitStartIdx = chatOclawBlock.indexOf('const waitStart = Date.now()');
    const sendChatIdx = chatOclawBlock.indexOf('agent.sendChat(');
    expect(waitStartIdx).toBeGreaterThan(-1);
    expect(sendChatIdx).toBeGreaterThan(-1);
    expect(waitStartIdx).toBeLessThan(sendChatIdx);
  });

  it('daemon handler persists message with delivered flag after sendChat', () => {
    const daemonSrc = readCliFile('daemon.ts');
    const chatOclawBlock = daemonSrc.slice(
      daemonSrc.indexOf("path === '/api/chat-openclaw'"),
      daemonSrc.indexOf("// POST /api/connect"),
    );
    const sendChatIdx = chatOclawBlock.indexOf('agent.sendChat(');
    const insertIdx = chatOclawBlock.indexOf('insertChatMessage');
    expect(sendChatIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(sendChatIdx);
    expect(chatOclawBlock.slice(insertIdx, insertIdx + 200)).toContain('delivered: sendResult.delivered');
  });

  it('daemon handler returns 200 for undelivered messages (not 502)', () => {
    const daemonSrc = readCliFile('daemon.ts');
    const blockStart = daemonSrc.indexOf("path === '/api/chat-openclaw'");
    const blockEnd = daemonSrc.indexOf("// OpenClaw channel bridge", blockStart);
    const chatOclawBlock = daemonSrc.slice(blockStart, blockEnd !== -1 ? blockEnd : daemonSrc.indexOf("// POST /api/connect"));
    expect(chatOclawBlock).not.toContain('502');
    expect(chatOclawBlock).toContain('delivered: false');
    expect(chatOclawBlock).toContain("reply: null");
    expect(chatOclawBlock).toContain("timedOut: false");
  });

  it('daemon local channel send handler includes gateway-route fallback', () => {
    const daemonSrc = readCliFile('daemon.ts');
    expect(daemonSrc).toContain('function getOpenClawChannelTargets');
    expect(daemonSrc).toContain('const standaloneBridgeBase = explicitBridgeBase');
    expect(daemonSrc).toContain("? (bridgeLooksLikeGateway ? undefined : explicitBridgeBase)");
    expect(daemonSrc).toContain(": (!explicitGatewayBase ? 'http://127.0.0.1:9201' : undefined);");
    expect(daemonSrc).toContain('const gatewayBase = explicitGatewayBase ?? (bridgeLooksLikeGateway ? explicitBridgeBase : undefined);');
    expect(daemonSrc).toContain("healthUrl: `${normalizedGatewayBase}/health`");
    expect(daemonSrc).toContain("return value.endsWith('/api/dkg-channel') ? value : `${value}/api/dkg-channel`;");
    expect(daemonSrc).toContain('shouldTryNextOpenClawTarget');
  });

  it('UI sends via local channel bridge (not P2P)', () => {
    const panelRight = readUiFile('components/Shell/PanelRight.tsx');
    expect(panelRight).toContain('streamLocalAgentChat');
    expect(panelRight).toContain('Connect OpenClaw');
  });

  it('fetchOpenClawLocalHistory requests the newest turns from /api/memory/sessions/:sessionId and returns chronological order', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        session: 'openclaw:dkg-ui',
        messages: [
          { text: 'first', author: 'user', ts: '2026-03-11T10:00:00Z', turnId: 'turn-1' },
          { text: 'second', author: 'user', ts: '2026-03-11T10:01:00Z', turnId: 'turn-2' },
          { text: 'third', author: 'agent', ts: '2026-03-11T10:02:00Z', turnId: 'turn-3' },
        ],
      }),
    });
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const { fetchOpenClawLocalHistory } = await import('../src/ui/api.js');
      const history = await fetchOpenClawLocalHistory(3);
      const [url] = fakeFetch.mock.calls[0];
      expect(String(url)).toContain('/api/memory/sessions/openclaw%3Adkg-ui');
      expect(String(url)).toContain('limit=3');
      expect(String(url)).toContain('order=desc');
      expect(history.map((row: any) => row.text)).toEqual(['first', 'second', 'third']);
      expect(history[0].turnId).toBe('turn-1');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('fetchLocalAgentHistory uses the selected sessionId and latest-first session query when reopening a non-default OpenClaw thread', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        session: 'openclaw:dkg-ui:worker-1',
        messages: [
          { text: 'worker hello', author: 'user', ts: '2026-03-11T10:00:00Z', turnId: 'turn-1' },
          { text: 'worker reply', author: 'agent', ts: '2026-03-11T10:01:00Z', turnId: 'turn-2' },
        ],
      }),
    });
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const { fetchLocalAgentHistory } = await import('../src/ui/api.js');
      const history = await fetchLocalAgentHistory('openclaw', 10, {
        sessionId: 'openclaw:dkg-ui:worker-1',
      });
      const [url] = fakeFetch.mock.calls[0];
      expect(String(url)).toContain('/api/memory/sessions/openclaw%3Adkg-ui%3Aworker-1');
      expect(String(url)).toContain('limit=10');
      expect(String(url)).toContain('order=desc');
      expect(history).toHaveLength(2);
      expect(history[0].text).toBe('worker hello');
      expect(history[1].text).toBe('worker reply');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('streamLocalAgentChat forwards the non-default OpenClaw identity so follow-up sends stay on the selected session', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      body: null,
      json: async () => ({ text: 'reply', correlationId: 'corr-1' }),
    });
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const { streamLocalAgentChat } = await import('../src/ui/api.js');
      await streamLocalAgentChat('openclaw', 'hello', {
        sessionId: 'openclaw:dkg-ui:background-worker',
      });
      const [, opts] = fakeFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.identity).toBe('background-worker');
      expect(body.correlationId).toBeTruthy();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('fetchLocalAgentIntegrations maps OpenClaw readiness and Hermes placeholder state', async () => {
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          integrations: [
            {
              id: 'openclaw',
              name: 'OpenClaw',
              description: 'OpenClaw framework adapter',
              enabled: true,
              capabilities: { localChat: true, connectFromUi: true },
            },
            {
              id: 'hermes',
              name: 'Hermes',
              description: 'Hermes framework adapter',
              enabled: false,
              capabilities: { connectFromUi: true },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, target: 'gateway' }),
      });
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const { fetchLocalAgentIntegrations } = await import('../src/ui/api.js');
      const result = await fetchLocalAgentIntegrations();
      const openclaw = result.integrations.find((item) => item.id === 'openclaw');
      const hermes = result.integrations.find((item) => item.id === 'hermes');
      expect(openclaw?.chatReady).toBe(true);
      expect(openclaw?.persistentChat).toBe(true);
      expect(openclaw?.bridgeOnline).toBe(true);
      expect(openclaw?.bridgeStatusLabel).toBe('Connected');
      expect(openclaw?.status).toBe('chat_ready');
      expect(openclaw?.target).toBe('gateway');
      expect(hermes?.status).toBe('coming_soon');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('fetchLocalAgentIntegrations keeps OpenClaw in connecting state until the bridge is ready', async () => {
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          integrations: [
            {
              id: 'openclaw',
              name: 'OpenClaw',
              description: 'OpenClaw framework adapter',
              enabled: true,
              capabilities: { localChat: true, connectFromUi: true },
              runtime: { status: 'connecting' },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, error: 'still booting' }),
      });
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const { fetchLocalAgentIntegrations } = await import('../src/ui/api.js');
      const result = await fetchLocalAgentIntegrations();
      expect(result.integrations[0]).toMatchObject({
        id: 'openclaw',
        persistentChat: true,
        chatReady: false,
        bridgeOnline: false,
        bridgeStatusLabel: 'Connecting',
        status: 'connecting',
        statusLabel: 'Connecting',
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('fetchLocalAgentIntegrations does not treat a failed unattached OpenClaw record as a persistent chat tab', async () => {
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          integrations: [
            {
              id: 'openclaw',
              name: 'OpenClaw',
              description: 'OpenClaw framework adapter',
              enabled: false,
              capabilities: { localChat: true, connectFromUi: true },
              runtime: { status: 'error', lastError: 'setup failed' },
            },
          ],
        }),
      });
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const { fetchLocalAgentIntegrations } = await import('../src/ui/api.js');
      const result = await fetchLocalAgentIntegrations();
      expect(result.integrations[0]).toMatchObject({
        id: 'openclaw',
        persistentChat: false,
        chatReady: false,
        status: 'available',
        statusLabel: 'Ready to connect',
        detail: 'setup failed',
      });
      expect(fakeFetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('resolveLocalAgentSelectionState reopens disconnected session history in the Agents view', async () => {
    const originalLocalStorage = (globalThis as any).localStorage;
    (globalThis as any).localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    try {
      const { resolveLocalAgentSelectionState } = await import('../src/ui/components/Shell/PanelRight.tsx');
      const state = resolveLocalAgentSelectionState({
        integrations: [
          {
            id: 'openclaw',
            name: 'OpenClaw',
            framework: 'OpenClaw',
            description: 'OpenClaw framework adapter',
            chatSupported: true,
            connectSupported: true,
            configured: false,
            detected: false,
            persistentChat: false,
            chatReady: false,
            bridgeOnline: false,
            bridgeStatusLabel: 'Ready to connect',
            status: 'available',
            statusLabel: 'Ready to connect',
            detail: 'Use the node-served skill plus OpenClaw onboarding to attach an existing local agent.',
            source: 'live',
          },
        ],
        selectedIntegrationId: 'openclaw',
        selectedSessionId: 'openclaw:dkg-ui:session-1',
        localMessagesByConversation: {},
        sessions: [
          {
            sessionId: 'openclaw:dkg-ui:session-1',
            integrationId: 'openclaw',
            integrationName: 'OpenClaw',
            preview: 'Hey there',
            messageCount: 1,
            lastTs: '2026-04-13T20:00:00Z',
          },
        ],
      });

      expect(state.selectedIntegration?.id).toBe('openclaw');
      expect(state.selectedHasConversation).toBe(true);
      expect(state.selectedConversation?.sessionId).toBe('openclaw:dkg-ui:session-1');
      expect(state.connectedIntegrations).toHaveLength(0);
    } finally {
      (globalThis as any).localStorage = originalLocalStorage;
    }
  });

  it('resolveLocalAgentSelectionState does not treat an empty history load as an existing conversation', async () => {
    const originalLocalStorage = (globalThis as any).localStorage;
    (globalThis as any).localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    try {
      const { getLocalAgentConversationStateKey, resolveLocalAgentSelectionState } = await import('../src/ui/components/Shell/PanelRight.tsx');
      const state = resolveLocalAgentSelectionState({
        integrations: [
          {
            id: 'openclaw',
            name: 'OpenClaw',
            framework: 'OpenClaw',
            description: 'OpenClaw framework adapter',
            chatSupported: true,
            connectSupported: true,
            configured: true,
            detected: true,
            persistentChat: true,
            chatReady: true,
            bridgeOnline: true,
            bridgeStatusLabel: 'Connected',
            status: 'chat_ready',
            statusLabel: 'Chat ready',
            detail: 'Connected through the bridge.',
            source: 'live',
          },
        ],
        selectedIntegrationId: 'openclaw',
        selectedSessionId: 'openclaw:dkg-ui',
        localMessagesByConversation: {
          [getLocalAgentConversationStateKey('openclaw', 'openclaw:dkg-ui')]: [],
        },
        sessions: [],
      });

      expect(state.selectedHasConversation).toBe(false);
      expect(state.selectedConversation?.sessionId).toBe('openclaw:dkg-ui');
    } finally {
      (globalThis as any).localStorage = originalLocalStorage;
    }
  });

  it('networkPeerCardStatusClass keeps disconnected known peers out of the connected styling', async () => {
    const originalLocalStorage = (globalThis as any).localStorage;
    (globalThis as any).localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    try {
      const { networkPeerCardStatusClass } = await import('../src/ui/components/Shell/PanelRight.tsx');
      expect(networkPeerCardStatusClass({ connectionStatus: 'connected' } as any)).toBe('connected');
      expect(networkPeerCardStatusClass({ connectionStatus: 'disconnected' } as any)).toBe('offline');
      expect(networkPeerCardStatusClass({ connectionStatus: 'known' } as any)).toBe('offline');
    } finally {
      (globalThis as any).localStorage = originalLocalStorage;
    }
  });

  it('upsertLocalAgentIntegrationState replaces a stale unattached OpenClaw record with the attached chat state', async () => {
    const originalLocalStorage = (globalThis as any).localStorage;
    (globalThis as any).localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    try {
      const { upsertLocalAgentIntegrationState } = await import('../src/ui/components/Shell/PanelRight.tsx');
      const result = upsertLocalAgentIntegrationState([
        {
          id: 'openclaw',
          name: 'OpenClaw',
          framework: 'OpenClaw',
          description: 'OpenClaw framework adapter',
          chatSupported: true,
          connectSupported: true,
          configured: false,
          detected: false,
          persistentChat: false,
          chatReady: false,
          bridgeOnline: false,
          bridgeStatusLabel: 'Ready to connect',
          status: 'available',
          statusLabel: 'Ready to connect',
          detail: 'Use the node-served skill plus OpenClaw onboarding to attach an existing local agent.',
          source: 'live',
        },
      ], {
        id: 'openclaw',
        name: 'OpenClaw',
        framework: 'OpenClaw',
        description: 'OpenClaw framework adapter',
        chatSupported: true,
        connectSupported: true,
        configured: true,
        detected: true,
        persistentChat: true,
        chatReady: true,
        bridgeOnline: true,
        bridgeStatusLabel: 'Bridge live',
        status: 'chat_ready',
        statusLabel: 'Chat ready',
        detail: 'Connected through the bridge.',
        source: 'live',
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'openclaw',
        persistentChat: true,
        chatReady: true,
        bridgeOnline: true,
        status: 'chat_ready',
      });
    } finally {
      (globalThis as any).localStorage = originalLocalStorage;
    }
  });

  it('markLocalAgentIntegrationDisconnected keeps the integration record but clears persistent chat', async () => {
    const originalLocalStorage = (globalThis as any).localStorage;
    (globalThis as any).localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    try {
      const { markLocalAgentIntegrationDisconnected } = await import('../src/ui/components/Shell/PanelRight.tsx');
      const result = markLocalAgentIntegrationDisconnected([
        {
          id: 'openclaw',
          name: 'OpenClaw',
          framework: 'OpenClaw',
          description: 'OpenClaw framework adapter',
          chatSupported: true,
          connectSupported: true,
          configured: true,
          detected: true,
          persistentChat: true,
          chatReady: true,
          bridgeOnline: true,
          bridgeStatusLabel: 'Bridge live',
          status: 'chat_ready',
          statusLabel: 'Chat ready',
          detail: 'Connected through the bridge.',
          source: 'live',
        },
      ], 'openclaw');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'openclaw',
        persistentChat: false,
        chatReady: false,
        bridgeOnline: false,
        status: 'available',
        statusLabel: 'Ready to connect',
      });
      expect(result[0].detail).toContain('Reconnect from the + tab');
    } finally {
      (globalThis as any).localStorage = originalLocalStorage;
    }
  });

  it('connectLocalAgentIntegration returns the refreshed OpenClaw integration plus daemon notice', async () => {
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          notice: 'OpenClaw is connected and chat-ready.',
          integration: {
            id: 'openclaw',
            name: 'OpenClaw',
            description: 'OpenClaw framework adapter',
            enabled: true,
            capabilities: { localChat: true, connectFromUi: true },
            runtime: { status: 'ready', ready: true },
            transport: { bridgeUrl: 'http://127.0.0.1:9201' },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, target: 'bridge' }),
      });
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const { connectLocalAgentIntegration } = await import('../src/ui/api.js');
      const result = await connectLocalAgentIntegration('openclaw');
      const [registerUrl, registerOpts] = fakeFetch.mock.calls[0];
      expect(String(registerUrl)).toContain('/api/local-agent-integrations/connect');
      expect(registerOpts.method).toBe('POST');
      expect(JSON.parse(registerOpts.body)).toEqual({
        id: 'openclaw',
        metadata: {
          source: 'node-ui',
        },
      });
      expect(result.integration.chatReady).toBe(true);
      expect(result.notice).toBe('OpenClaw is connected and chat-ready.');
      expect(fakeFetch).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('connectLocalAgentIntegration does not require a second integrations fetch when the daemon already returns the connected record', async () => {
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          notice: 'OpenClaw attach is in progress.',
          integration: {
            id: 'openclaw',
            name: 'OpenClaw',
            description: 'OpenClaw framework adapter',
            enabled: true,
            capabilities: { localChat: true, connectFromUi: true },
            runtime: { status: 'connecting' },
            transport: { bridgeUrl: 'http://127.0.0.1:9201' },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, error: 'still booting' }),
      });
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const { connectLocalAgentIntegration } = await import('../src/ui/api.js');
      const result = await connectLocalAgentIntegration('openclaw');
      expect(result.integration).toMatchObject({
        id: 'openclaw',
        persistentChat: true,
        chatReady: false,
        status: 'connecting',
      });
      expect(fakeFetch).toHaveBeenCalledTimes(2);
      expect(String(fakeFetch.mock.calls[0][0])).toContain('/api/local-agent-integrations/connect');
      expect(String(fakeFetch.mock.calls[1][0])).toContain('/api/openclaw-channel/health');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('disconnectLocalAgentIntegration disables the stored integration without deleting the registry record', async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const { disconnectLocalAgentIntegration } = await import('../src/ui/api.js');
      await disconnectLocalAgentIntegration('openclaw');
      const [url, opts] = fakeFetch.mock.calls[0];
      expect(String(url)).toContain('/api/local-agent-integrations/openclaw');
      expect(opts.method).toBe('PUT');
      expect(JSON.parse(opts.body)).toEqual({
        enabled: false,
        runtime: {
          status: 'disconnected',
          ready: false,
          lastError: null,
        },
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
