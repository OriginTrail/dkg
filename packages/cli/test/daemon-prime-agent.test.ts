import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DkgConfig } from '../src/config.js';
import {
  getPrimeAgentChannelTargets,
  isPrimeAgentLoopbackUrl,
  normalizePrimeAgentChatPayload,
  probePrimeAgentChannelHealth,
  readPrimeAgentSessions,
  transportPatchFromPrimeAgentTarget,
} from '../src/daemon/prime-agent.js';
import { handlePrimeAgentRoutes } from '../src/daemon/routes/prime-agent.js';
import { handleLocalAgentsRoutes } from '../src/daemon/routes/local-agents.js';
import { connectLocalAgentIntegrationFromUi } from '../src/daemon/local-agents.js';

// The setup entry pulls in the adapter's runtime; the daemon only ever calls it
// on disconnect, and none of these tests exercise that path.
vi.mock('@origintrail-official/dkg-adapter-prime-agent', () => ({
  restorePrimeAgentProfile: vi.fn(async () => ({ ok: true })),
}));

let agentDir: string;
let sessionsDir: string;
let bridges: Server[] = [];

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'dkg-prime-agent-test-'));
  sessionsDir = join(agentDir, '.dkg-adapter-prime-agent', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
  delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
  await Promise.all(bridges.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  bridges = [];
  rmSync(agentDir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<DkgConfig> = {}): DkgConfig {
  return {
    name: 'test-node',
    apiPort: 9200,
    listenPort: 0,
    nodeRole: 'edge',
    ...overrides,
  } as DkgConfig;
}

function enabledConfig(): DkgConfig {
  return makeConfig({
    localAgentIntegrations: {
      'prime-agent': {
        enabled: true,
        capabilities: { localChat: true },
        transport: { kind: 'prime-agent-channel' },
      },
    },
  } as Partial<DkgConfig>);
}

function makeJsonRequest(method: string, path: string, payload?: unknown) {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = path;
  req.headers = {};
  setTimeout(() => {
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  }, 0);
  return req;
}

function makeJsonResponse() {
  const res = new EventEmitter() as any;
  res.statusCode = 0;
  res.headers = {};
  res.body = '';
  res.writableEnded = false;
  res.headersSent = false;
  res.writeHead = (status: number, headers: Record<string, string>) => {
    res.statusCode = status;
    res.headers = headers;
    res.headersSent = true;
  };
  res.write = (chunk: string | Buffer) => {
    res.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    return true;
  };
  res.end = (chunk?: string | Buffer) => {
    if (chunk) res.write(chunk);
    res.writableEnded = true;
  };
  return res;
}

/**
 * A stand-in for the extension-hosted bridge. Real one, on a real ephemeral
 * loopback port, so the descriptor -> target -> fetch path is exercised end to
 * end rather than mocked at the fetch boundary.
 */
async function startStubBridge(opts: {
  sessionId: string;
  sendStatus?: number;
  sendBody?: unknown;
  healthSessionId?: string;
} ): Promise<{ url: string; seen: { headers: Record<string, string | undefined>; body: any } | null }> {
  const seen: { headers: Record<string, string | undefined>; body: any } | null = null as any;
  const state = { value: seen };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          sessionId: opts.healthSessionId ?? opts.sessionId,
          pid: process.pid,
        }));
        return;
      }
      state.value = { headers: req.headers as any, body: raw ? JSON.parse(raw) : null };
      const status = opts.sendStatus ?? 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(opts.sendBody ?? { text: 'pong', correlationId: 'c1' }));
    });
  });
  bridges.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, get seen() { return state.value; } } as any;
}

function writeDescriptor(sessionId: string, bridgeUrl: string, pid = process.pid): void {
  writeFileSync(
    join(sessionsDir, `${sessionId}.json`),
    JSON.stringify({ sessionId, bridgeUrl, pid, startedAt: new Date().toISOString() }),
  );
}

describe('prime-agent session discovery', () => {
  it('ignores a descriptor pointing off-box', () => {
    writeDescriptor('remote', 'http://10.0.0.5:9999');
    expect(readPrimeAgentSessions()).toEqual([]);
    expect(isPrimeAgentLoopbackUrl('http://10.0.0.5:9999')).toBe(false);
    expect(isPrimeAgentLoopbackUrl('http://127.0.0.1:1234')).toBe(true);
  });

  it('prunes a descriptor whose process is gone', () => {
    // PID 1 exists; a very high PID reliably does not.
    writeDescriptor('dead', 'http://127.0.0.1:1234', 4_194_303);
    expect(readPrimeAgentSessions()).toEqual([]);
  });

  it('returns no target for an unknown explicit session rather than falling back', () => {
    writeDescriptor('live-one', 'http://127.0.0.1:1234');
    expect(getPrimeAgentChannelTargets({ sessionId: 'live-one' })).toHaveLength(1);
    expect(getPrimeAgentChannelTargets({ sessionId: 'not-a-session' })).toEqual([]);
  });

  it('maps a target back to a transport patch without the route suffix', () => {
    const [target] = (() => {
      writeDescriptor('s1', 'http://127.0.0.1:4321');
      return getPrimeAgentChannelTargets({});
    })();
    expect(transportPatchFromPrimeAgentTarget(target)).toEqual({
      kind: 'prime-agent-channel',
      bridgeUrl: 'http://127.0.0.1:4321',
      healthUrl: 'http://127.0.0.1:4321/health',
    });
  });
});

describe('prime-agent chat payload', () => {
  it('rejects a session id that could escape the descriptor directory', () => {
    const result = normalizePrimeAgentChatPayload({ text: 'hi', correlationId: 'c', sessionId: '../../etc/passwd' });
    expect(result).toEqual({ error: 'Invalid "sessionId"' });
  });

  it('requires text and correlationId', () => {
    expect(normalizePrimeAgentChatPayload({ correlationId: 'c' })).toEqual({ error: 'Missing "text"' });
    expect(normalizePrimeAgentChatPayload({ text: 'hi' })).toEqual({ error: 'Missing "correlationId"' });
  });
});

describe('/api/prime-agent-channel/health', () => {
  it('reports zero sessions as idle, not as a server error', async () => {
    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('GET', '/api/prime-agent-channel/health'),
      res,
      config: makeConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/health',
    } as any);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, sessionCount: 0 });
  });

  it('reports ok once a live bridge answers', async () => {
    const bridge = await startStubBridge({ sessionId: 's1' });
    writeDescriptor('s1', bridge.url);

    const report = await probePrimeAgentChannelHealth('bridge-token');
    expect(report).toMatchObject({ ok: true, sessionCount: 1, target: 's1' });
  });

  it('rejects a bridge whose session id does not match the descriptor', async () => {
    // A recycled port: some other process now owns it and reports its own id.
    const bridge = await startStubBridge({ sessionId: 's1', healthSessionId: 'someone-else' });
    writeDescriptor('s1', bridge.url);

    const report = await probePrimeAgentChannelHealth('bridge-token');
    expect(report.ok).toBe(false);
    expect(report.error).toContain('someone-else');
  });
});

describe('/api/prime-agent-channel/send', () => {
  it('refuses when the integration is not enabled', async () => {
    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/send', { text: 'hi', correlationId: 'c1' }),
      res,
      config: makeConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/send',
    } as any);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('INTEGRATION_DISABLED');
  });

  it('returns a session-specific 409 when nothing is live', async () => {
    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/send', { text: 'hi', correlationId: 'c1' }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/send',
    } as any);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('PRIME_AGENT_NO_SESSION');
  });

  it('forwards to the live session with the bridge token', async () => {
    const bridge = await startStubBridge({ sessionId: 's1', sendBody: { text: 'pong', correlationId: 'c1' } });
    writeDescriptor('s1', bridge.url);

    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/send', { text: 'hi', correlationId: 'c1' }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/send',
      requestAgentAddress: '0x0000000000000000000000000000000000000001',
    } as any);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ text: 'pong', sessionId: 's1', correlationId: 'c1' });
    expect(bridge.seen?.headers['x-dkg-bridge-token']).toBe('bridge-token');
    expect(bridge.seen?.body).toMatchObject({ text: 'hi', sessionId: 's1' });
  });

  it('does not silently reroute when the addressed session is gone', async () => {
    // The safety property: a message addressed to session A must never land in
    // session B just because B happens to be alive.
    const bridge = await startStubBridge({ sessionId: 'other' });
    writeDescriptor('other', bridge.url);

    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/send', {
        text: 'hi',
        correlationId: 'c1',
        sessionId: 'gone',
      }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/send',
    } as any);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('PRIME_AGENT_NO_SESSION');
    expect(bridge.seen).toBeNull();
  });

  it('surfaces the bridge one-turn guard as busy rather than as a fault', async () => {
    const bridge = await startStubBridge({ sessionId: 's1', sendStatus: 429, sendBody: { error: 'turn in progress' } });
    writeDescriptor('s1', bridge.url);

    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/send', { text: 'hi', correlationId: 'c1' }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/send',
    } as any);

    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).code).toBe('PRIME_AGENT_SESSION_BUSY');
  });
});

describe('connect from the Node UI', () => {
  it('installs the extension first, then reports idle when no session is live', async () => {
    const runPrimeAgentSetup = vi.fn(async () => ({ ok: true, errors: [], warnings: [] }));
    const config = makeConfig();

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      { id: 'prime-agent' } as any,
      'bridge-token',
      { runPrimeAgentSetup } as any,
    );

    expect(runPrimeAgentSetup).toHaveBeenCalledOnce();
    // No session yet is expected right after install, so this must not read as
    // a failure to the operator.
    expect(result.integration.runtime?.status).toBe('degraded');
    expect(result.notice).toContain('Start a Prime Agent session');
  });

  it('reports ready and records the routed session once a bridge answers', async () => {
    const bridge = await startStubBridge({ sessionId: 's1' });
    writeDescriptor('s1', bridge.url);
    const runPrimeAgentSetup = vi.fn(async () => ({ ok: true, errors: [], warnings: [] }));

    const result = await connectLocalAgentIntegrationFromUi(
      makeConfig(),
      { id: 'prime-agent' } as any,
      'bridge-token',
      { runPrimeAgentSetup } as any,
    );

    expect(result.integration.runtime?.status).toBe('ready');
    expect(result.integration.metadata).toMatchObject({ sessionCount: 1, activeSessionId: 's1' });
    expect(result.integration.transport).toMatchObject({ kind: 'prime-agent-channel', bridgeUrl: bridge.url });
  });

  it('does not claim to be connected when setup itself failed', async () => {
    const runPrimeAgentSetup = vi.fn(async () => ({
      ok: false,
      errors: ['settings.json is not writable'],
      warnings: [],
    }));

    const result = await connectLocalAgentIntegrationFromUi(
      makeConfig(),
      { id: 'prime-agent' } as any,
      'bridge-token',
      { runPrimeAgentSetup } as any,
    );

    expect(result.integration.runtime?.status).toBe('error');
    expect(result.integration.runtime?.lastError).toContain('not writable');
  });
});

describe('local-agent integrations listing', () => {
  it('reports live Prime Agent session counts so the UI can tell idle from absent', async () => {
    const bridge = await startStubBridge({ sessionId: 's1' });
    writeDescriptor('s1', bridge.url);

    const res = makeJsonResponse();
    await handleLocalAgentsRoutes({
      req: makeJsonRequest('GET', '/api/local-agent-integrations'),
      res,
      config: makeConfig(),
      path: '/api/local-agent-integrations',
      url: new URL('http://127.0.0.1:9200/api/local-agent-integrations'),
    } as any);

    expect(res.statusCode).toBe(200);
    const integrations = JSON.parse(res.body).integrations as Array<{ id: string; metadata?: any }>;
    const primeAgent = integrations.find((entry) => entry.id === 'prime-agent');
    expect(primeAgent?.metadata).toMatchObject({ sessionCount: 1, activeSessionId: 's1' });

    // Single-session agents must not grow a phantom counter.
    expect(integrations.find((entry) => entry.id === 'hermes')?.metadata?.sessionCount).toBeUndefined();
  });
});
