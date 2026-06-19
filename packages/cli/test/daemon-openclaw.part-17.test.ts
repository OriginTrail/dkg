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

describe('OpenClaw UI Connect/Disconnect/Refresh fresh-HOME integration (issue #198)', () => {
  let tempRoot: string;
  let openclawDir: string;
  let openclawConfigPath: string;
  let workspaceDir: string;
  let adapterPath: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dkg-fresh-home-'));
    openclawDir = join(tempRoot, '.openclaw');
    workspaceDir = join(tempRoot, 'workspace');
    openclawConfigPath = join(openclawDir, 'openclaw.json');
    mkdirSync(openclawDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    // Simulate an installed adapter path under workspace node_modules.
    // The merge routine uses isAdapterLoadPath() (matches .../@origintrail-official/dkg-adapter-openclaw
    // or .../packages/adapter-openclaw/). Use a packages/ path so both forms work on Windows & POSIX.
    adapterPath = join(tempRoot, 'packages', 'adapter-openclaw');
    writeFileSync(openclawConfigPath, JSON.stringify({
      plugins: {},
      agents: { defaults: { workspace: workspaceDir } },
    }, null, 2));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function seedOpenClawConfig(data: Record<string, unknown>): void {
    writeFileSync(openclawConfigPath, JSON.stringify(data, null, 2) + '\n');
  }



  it('scenario 2e: skill-removal failure propagates to runtime.lastError AND leaves openclaw.json untouched for retry (Codex R2-2 + R3-2)', async () => {
    // Regression for https://github.com/OriginTrail/dkg-v9/pull/234#discussion_r3120159512
    // (R2-2) and #discussion_r3120241631 (R3-2). R2-2 stopped swallowing skill-
    // removal errors; R3-2 reordered the flow so skill cleanup runs BEFORE
    // the config-level unmerge — a failure at the skill step must leave
    // `entry.config.installedWorkspace` and the adapter wiring intact so the user
    // can retry Disconnect and we still know which file to target.

    mergeOpenClawConfig(openclawConfigPath, adapterPath, testEntryConfig, workspaceDir);
    const beforeDisconnect = readFileSync(openclawConfigPath, 'utf-8');

    // Stub removal to succeed (no-op) but have verifySkillRemoved claim the
    // file is still present — as if the unlink raced with another writer, or
    // a permission issue prevented the delete. The injected verifier mirrors
    // the real contract: non-null string → failure.
    const removeSkillNoop = vi.fn();
    const verifySkillRemovedFail = vi.fn(
      (ws: string) => `canonical node skill still present at ${join(ws, 'skills', 'dkg-node', 'SKILL.md')}`,
    );
    // Spies on the config-level ops — must NOT be invoked when the skill
    // step fails. Provide passing stubs so the default dynamic-import path
    // would still work if the code accidentally reached them, but the spy
    // counts prove the reorder held.
    const unmergeSpy = vi.fn();
    const verifyInvariantsSpy = vi.fn(() => null);

    const config = makeConfig();
    await expect(
      reverseLocalAgentSetupForUi(config, openclawConfigPath, {
        removeCanonicalNodeSkill: removeSkillNoop,
        verifySkillRemoved: verifySkillRemovedFail,
        unmergeOpenClawConfig: unmergeSpy,
        verifyUnmergeInvariants: verifyInvariantsSpy,
      }),
    ).rejects.toThrow(/SKILL\.md|still present/);

    // Skill-step deps were exercised against the installedWorkspace
    // recorded at merge time (workspaceDir is what the merge above passed).
    expect(removeSkillNoop).toHaveBeenCalledTimes(1);
    expect(removeSkillNoop.mock.calls[0][0]).toBe(workspaceDir);
    expect(verifySkillRemovedFail).toHaveBeenCalledTimes(1);
    expect(verifySkillRemovedFail.mock.calls[0][0]).toBe(workspaceDir);

    // R3-2: the config-level unmerge + invariant check were never reached,
    // so openclaw.json is byte-identical to its pre-Disconnect state. The
    // adapter entry — including `installedWorkspace` — is still present,
    // which is exactly what a retry needs.
    expect(unmergeSpy).not.toHaveBeenCalled();
    expect(verifyInvariantsSpy).not.toHaveBeenCalled();
    expect(readFileSync(openclawConfigPath, 'utf-8')).toBe(beforeDisconnect);
    const after = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(after.plugins.entries['adapter-openclaw']).toBeDefined();
    expect(after.plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(workspaceDir);
  });

  it('scenario 2f: retry after a failed skill cleanup succeeds (Codex R3-2 recovery)', async () => {
    // First Disconnect: skill cleanup fails, openclaw.json is untouched.
    // Second Disconnect: real skill cleanup + real verify succeed, entry is removed.
    // Proves `entry.config.installedWorkspace` is still readable on retry — the whole
    // point of the R3-2 reorder.

    mergeOpenClawConfig(openclawConfigPath, adapterPath, testEntryConfig, workspaceDir);
    const skillDir = join(workspaceDir, 'skills', 'dkg-node');
    const skillPath = join(skillDir, 'SKILL.md');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, '# Canonical DKG Node Skill\n');

    // Attempt 1: removal fails (stubbed no-op that never actually unlinks).
    // Real verifySkillRemoved then sees SKILL.md still on disk and throws.
    const removeSkillNoop = vi.fn();
    const config = makeConfig();
    await expect(
      reverseLocalAgentSetupForUi(config, openclawConfigPath, {
        removeCanonicalNodeSkill: removeSkillNoop,
        // verifySkillRemoved left as the real adapter helper — it observes
        // the still-present SKILL.md and returns a failure string.
      }),
    ).rejects.toThrow(/still present/);

    // Post-failure state: the adapter entry AND installedWorkspace survived.
    const afterAttempt1 = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(afterAttempt1.plugins.entries['adapter-openclaw']).toBeDefined();
    expect(afterAttempt1.plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(workspaceDir);
    expect(afterAttempt1.plugins.slots.memory).toBe('adapter-openclaw');
    expect(existsSync(skillPath)).toBe(true);

    // Attempt 2: no stubs — run the real flow end-to-end. The
    // `entry.config.installedWorkspace` left in place is what the real
    // `reverseLocalAgentSetupForUi` reads to target SKILL.md.
    await expect(reverseLocalAgentSetupForUi(config, openclawConfigPath)).resolves.toBeUndefined();

    const afterAttempt2 = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(afterAttempt2.plugins.entries['adapter-openclaw']).toBeUndefined();
    expect(afterAttempt2.plugins.slots.memory).toBeUndefined();
    expect(existsSync(skillPath)).toBe(false);
  });

  it('scenario 2g: second Disconnect after a clean first Disconnect does NOT touch user-placed files at the config-derived workspace (Codex R5-4)', async () => {
    // Regression for https://github.com/OriginTrail/dkg-v9/pull/234#discussion_r3120437829
    // After a clean first Disconnect, the adapter entry is fully removed from
    // openclaw.json. The old code still fell through to
    // `resolveWorkspaceDirFromConfig` and would target SKILL.md at the
    // config-derived workspace — clobbering any user-placed file there.
    // Post-R5-4, an absent adapter entry gates skill cleanup entirely.

    // Seed openclaw.json WITHOUT a `plugins.entries['adapter-openclaw']`
    // entry (simulates the post-clean-Disconnect state) but with an
    // `agents.defaults.workspace` the old fallback would have targeted.
    writeFileSync(openclawConfigPath, JSON.stringify({
      plugins: { allow: [], load: { paths: [] }, entries: {}, slots: {} },
      agents: { defaults: { workspace: workspaceDir } },
    }, null, 2));

    // Seed a user-placed SKILL.md at the config-derived workspace. After a
    // clean first Disconnect this could be something the user restored
    // manually, or an unrelated file they placed under the same name.
    const userSkillDir = join(workspaceDir, 'skills', 'dkg-node');
    const userSkillPath = join(userSkillDir, 'SKILL.md');
    mkdirSync(userSkillDir, { recursive: true });
    writeFileSync(userSkillPath, '# User-placed SKILL.md — NOT adapter-owned\n');
    const userBytes = readFileSync(userSkillPath, 'utf-8');

    const removeSkillSpy = vi.fn();
    const verifySkillRemovedSpy = vi.fn(() => null);

    const config = makeConfig();
    await expect(
      reverseLocalAgentSetupForUi(config, openclawConfigPath, {
        removeCanonicalNodeSkill: removeSkillSpy,
        verifySkillRemoved: verifySkillRemovedSpy,
      }),
    ).resolves.toBeUndefined();

    // R5-4: entry absent → skill cleanup path is never entered. Spies
    // prove neither helper was invoked.
    expect(removeSkillSpy).not.toHaveBeenCalled();
    expect(verifySkillRemovedSpy).not.toHaveBeenCalled();

    // User's SKILL.md is intact — byte-identical.
    expect(existsSync(userSkillPath)).toBe(true);
    expect(readFileSync(userSkillPath, 'utf-8')).toBe(userBytes);
  });

  it('scenario 2h: whitespace-padded entry.config.installedWorkspace is trimmed before skill cleanup (Codex R12-1)', async () => {
    // Regression for https://github.com/OriginTrail/dkg-v9/pull/234#discussion_r3123147766
    // Prior to the fix, the daemon's installedWorkspace read returned the
    // raw JSON value after a truthy `.trim()` check — whitespace-padded
    // strings passed validation but were then handed to
    // `removeCanonicalNodeSkill` / `verifySkillRemoved` verbatim, producing
    // a wrong (non-existent) path. Disconnect silently succeeded, the real
    // SKILL.md stayed orphaned. Now we trim at the read site.

    const paddedInstalledWorkspace = `  ${workspaceDir}  `;
    mergeOpenClawConfig(openclawConfigPath, adapterPath, testEntryConfig, workspaceDir);
    const merged = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    // Inject whitespace around the authoritative pointer to simulate a
    // hand-edited or externally-written config value.
    merged.plugins.entries['adapter-openclaw'].config.installedWorkspace = paddedInstalledWorkspace;
    writeFileSync(openclawConfigPath, JSON.stringify(merged, null, 2));

    const removeSkillSpy = vi.fn();
    const verifySkillRemovedSpy = vi.fn(() => null);

    const config = makeConfig();
    await reverseLocalAgentSetupForUi(config, openclawConfigPath, {
      removeCanonicalNodeSkill: removeSkillSpy,
      verifySkillRemoved: verifySkillRemovedSpy,
    });

    // Both skill helpers must receive the TRIMMED path, not the raw
    // whitespace-padded value — otherwise the resolved SKILL.md path
    // (`<padded>/skills/dkg-node/SKILL.md`) wouldn't exist on disk and the
    // cleanup would silently no-op against the wrong location.
    expect(removeSkillSpy).toHaveBeenCalledTimes(1);
    expect(removeSkillSpy.mock.calls[0][0]).toBe(workspaceDir);
    expect(removeSkillSpy.mock.calls[0][0]).not.toBe(paddedInstalledWorkspace);
    expect(verifySkillRemovedSpy).toHaveBeenCalledTimes(1);
    expect(verifySkillRemovedSpy.mock.calls[0][0]).toBe(workspaceDir);
  });

  it('scenario 3a: refresh endpoint moves a bridge-ok integration to ready', async () => {
    const config = makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
            bridgeUrl: 'http://127.0.0.1:9201',
          },
          runtime: {
            status: 'error',
            ready: false,
            lastError: 'bridge offline (stale)',
          },
        },
      },
    });

    const origFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ ok: true, channel: 'dkg-ui' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const integration = await refreshLocalAgentIntegrationFromUi(config, 'openclaw', 'bridge-token');
      expect(fetchCalls).toBeGreaterThan(0);
      expect(integration.status).toBe('ready');
      expect(integration.runtime.ready).toBe(true);
      expect(integration.runtime.lastError).toBeFalsy();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('scenario 3b: refresh endpoint surfaces a 503 as runtime.status=error with lastError populated', async () => {
    const config = makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
            bridgeUrl: 'http://127.0.0.1:9201',
          },
          runtime: {
            status: 'ready',
            ready: true,
          },
        },
      },
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('bridge offline', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    })) as typeof fetch;

    try {
      const integration = await refreshLocalAgentIntegrationFromUi(config, 'openclaw', 'bridge-token');
      expect(integration.status).toBe('error');
      expect(integration.runtime.ready).toBe(false);
      expect(integration.runtime.lastError).toBeTruthy();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('scenario 3c: refresh on Hermes probes bridge health and preserves the known integration record', async () => {
    const config = makeConfig();

    const origFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response('should not be reached', { status: 500 });
    }) as typeof fetch;

    try {
      const integration = await refreshLocalAgentIntegrationFromUi(config, 'hermes', 'bridge-token');
      expect(integration).toBeTruthy();
      expect(integration.id).toBe('hermes');
      expect(fetchCalls).toBe(1);
      expect(integration.runtime.status).toBe('degraded');
      expect(integration.runtime.ready).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('scenario 3d: refresh on an unknown integration id throws (route maps to 404)', async () => {
    const config = makeConfig();
    await expect(
      refreshLocalAgentIntegrationFromUi(config, 'does-not-exist', 'bridge-token'),
    ).rejects.toThrow(/Unknown integration/);
  });

});
