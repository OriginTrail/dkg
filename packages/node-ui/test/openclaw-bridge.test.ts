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

  it('exports fetchOpenClawAgents', () => {
    expect(apiSrc).toContain('fetchOpenClawAgents');
    expect(apiSrc).toMatch(/\/api\/openclaw-agents/);
  });

  it('exports sendOpenClawChat', () => {
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

describe('Agent Hub UI — OpenClaw tab', () => {
  const agentHub = readUiFile('pages/AgentHub.tsx');

  it('imports OpenClaw API functions', () => {
    expect(agentHub).toContain('fetchOpenClawAgents');
    expect(agentHub).toContain('sendOpenClawChat');
    expect(agentHub).toContain('OpenClawAgent');
  });

  it('defines OpenClawChatView component', () => {
    expect(agentHub).toContain('function OpenClawChatView');
  });

  it('mode state includes openclaw option', () => {
    expect(agentHub).toMatch(/'agent'\s*\|\s*'peers'\s*\|\s*'openclaw'/);
  });

  it('renders OpenClaw tab label', () => {
    expect(agentHub).toMatch(/OpenClaw/);
  });

  it('renders OpenClawChatView when mode is openclaw', () => {
    expect(agentHub).toContain('<OpenClawChatView');
    expect(agentHub).toMatch(/mode\s*===\s*'openclaw'/);
  });

  it('OpenClawChatView shows agent list sidebar', () => {
    expect(agentHub).toContain('OpenClaw Agents');
  });

  it('OpenClawChatView handles empty agent list', () => {
    expect(agentHub).toContain('No OpenClaw agents found');
  });

  it('OpenClawChatView shows connection status indicator', () => {
    expect(agentHub).toMatch(/ag\.connected\s*\?/);
  });

  it('OpenClawChatView handles send with loading state', () => {
    expect(agentHub).toContain('Waiting for response');
  });

  it('OpenClawChatView handles timeout response', () => {
    expect(agentHub).toContain('did not respond within 30 seconds');
  });

  it('OpenClawChatView handles delivery failure', () => {
    expect(agentHub).toContain('Failed to deliver');
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
    const chatOclawBlock = daemonSrc.slice(
      daemonSrc.indexOf("path === '/api/chat-openclaw'"),
      daemonSrc.indexOf("// POST /api/connect"),
    );
    expect(chatOclawBlock).not.toContain('502');
    expect(chatOclawBlock).toContain('delivered: false');
    expect(chatOclawBlock).toContain("reply: null");
    expect(chatOclawBlock).toContain("timedOut: false");
  });

  it('UI checks reply with != null (not truthy)', () => {
    const agentHub = readUiFile('pages/AgentHub.tsx');
    expect(agentHub).toContain('res.reply != null');
    expect(agentHub).not.toMatch(/if\s*\(\s*res\.reply\s*\)\s*\{/);
  });
});
