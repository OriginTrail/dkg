import { describe, it, expect } from 'vitest';
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
