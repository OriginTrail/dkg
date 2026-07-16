import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpenClawChannelHeaders,
  cancelPendingLocalAgentAttachJob,
  connectLocalAgentIntegrationFromUi,
  connectLocalAgentIntegration,
  daemonState,
  getLocalAgentIntegration,
  getOpenClawChannelTargets,
  hasConfiguredLocalAgentChat,
  hasOpenClawChatTurnContent,
  isLoopbackClientIp,
  isOpenClawMemorySlotElected,
  normalizeOpenClawAttachmentRefs,
  normalizeOpenClawChatContextEntry,
  normalizeOpenClawChatContextEntries,
  isValidOpenClawPersistTurnPayload,
  listLocalAgentIntegrations,
  OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS,
  parseRequiredSignatures,
  pipeOpenClawStream,
  probeOpenClawChannelHealth,
  refreshLocalAgentIntegrationFromUi,
  reverseLocalAgentSetupForUi,
  runOpenClawUiSetup,
  verifyOpenClawAttachmentRefsProvenance,
  normalizeExplicitLocalAgentDisconnectBody,
  shouldBypassRateLimitForLoopbackTraffic,
  updateLocalAgentIntegration,
} from '../src/daemon.js';
import { handleOpenclawRoutes } from '../src/daemon/routes/openclaw.js';
import { mergeOpenClawConfig, type AdapterEntryConfig } from '@origintrail-official/dkg-adapter-openclaw';
import type { DkgConfig } from '../src/config.js';

// Default entryConfig fixture matching the shape `runSetup` builds at
// Step 5 — same values setup writes into plugins.entries.adapter-openclaw.config.
const testEntryConfig: AdapterEntryConfig = {
  daemonUrl: 'http://127.0.0.1:9200',
  memory: { enabled: true },
  channel: { enabled: true },
};

function makeConfig(overrides: Partial<DkgConfig> = {}): DkgConfig {
  return {
    name: 'test-node',
    apiPort: 9200,
    listenPort: 0,
    nodeRole: 'edge',
    ...overrides,
  };
}

function makeJsonRequest(method: string, path: string, payload: unknown) {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = path;
  req.headers = {};
  setTimeout(() => {
    req.emit('data', Buffer.from(JSON.stringify(payload)));
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
  res.writeHead = (status: number, headers: Record<string, string>) => {
    res.statusCode = status;
    res.headers = headers;
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

function freshExtractionStatusTimes() {
  const completedAt = new Date().toISOString();
  const startedAt = new Date(Date.now() - 1000).toISOString();
  return { startedAt, completedAt };
}

function makeOpenClawRouteContext(
  payload: unknown,
  path = '/api/openclaw-channel/send',
  configOverrides: Partial<DkgConfig> = {},
) {
  const req = makeJsonRequest('POST', path, payload);
  const res = makeJsonResponse();
  return {
    ctx: {
      req,
      res,
      agent: {
        store: { query: vi.fn(async () => ({ bindings: [] })) },
      },
      config: makeConfig({
        localAgentIntegrations: {
          openclaw: {
            enabled: true,
            capabilities: { localChat: true },
            transport: { kind: 'openclaw-channel', bridgeUrl: 'http://127.0.0.1:9301' },
          },
        },
        ...configOverrides,
      }),
      memoryManager: {
        storeChatExchange: vi.fn(async () => {}),
      },
      bridgeAuthToken: 'bridge-token',
      extractionStatus: new Map(),
      path,
      requestAgentAddress: '0x0000000000000000000000000000000000000001',
    } as any,
    res,
  };
}



describe('runOpenClawUiSetup AbortSignal forwarding (Codex #1)', () => {


  // Regression test for https://github.com/OriginTrail/dkg-v9/pull/228#discussion_r3117710809
  // The child-process path used to SIGKILL setup on abort; the in-process path must
  // refuse to start on a pre-aborted signal and (via the adapter's step-boundary
  // throwIfAborted helper) also stop cleanly if the signal fires mid-flow.
  it('pre-aborted signal throws before importing the adapter (no config writes)', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runOpenClawUiSetup(controller.signal)).rejects.toThrow(/OpenClaw attach cancelled/);
  });

});
