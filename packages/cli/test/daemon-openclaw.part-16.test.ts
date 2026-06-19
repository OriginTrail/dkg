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



  it('scenario 1: fresh-HOME UI Connect merges adapter-openclaw into plugins.slots.memory and marks integration ready', async () => {
    // Fresh openclaw.json (no adapter wiring yet).
    seedOpenClawConfig({ plugins: {}, agents: { defaults: { workspace: workspaceDir } } });

    const config = makeConfig();
    // DI stub: simulates runSetup by running the REAL mergeOpenClawConfig against
    // the temp-HOME openclaw.json. This is the highest-fidelity stand-in we can
    // get without spinning up a real daemon in the test.
    const runSetup = async () => {
      mergeOpenClawConfig(openclawConfigPath, adapterPath, testEntryConfig, workspaceDir);
    };
    const restartGateway = async () => {};
    const waitForReady = async () => ({ ok: true as const, target: 'bridge' });
    const probeResults: Array<{ ok: boolean; target?: string; error?: string }> = [
      { ok: false, error: 'bridge offline' },
      { ok: true, target: 'bridge' },
    ];
    let probeIdx = 0;
    const probeHealth = async () => probeResults[probeIdx++] as any;
    const saveConfig = async () => {};
    // Real verifyMemorySlot reads the temp openclaw.json to confirm election.
    const verifyMemorySlot = () => {
      const raw = readFileSync(openclawConfigPath, 'utf-8');
      return JSON.parse(raw)?.plugins?.slots?.memory === 'adapter-openclaw';
    };
    let attachJob: Promise<void> | null = null;

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      { id: 'openclaw', metadata: { source: 'node-ui' } },
      'bridge-token',
      {
        runSetup,
        restartGateway,
        waitForReady,
        probeHealth,
        saveConfig,
        verifyMemorySlot,
        onAttachScheduled: (_id, job) => { attachJob = job; },
      },
    );

    expect(result.integration.status).toBe('connecting');
    if (!attachJob) throw new Error('Expected OpenClaw attach job to be scheduled');
    await attachJob;

    // Real openclaw.json on the temp filesystem now reflects the merge.
    const mergedRaw = readFileSync(openclawConfigPath, 'utf-8');
    const merged = JSON.parse(mergedRaw);
    expect(merged.plugins.slots.memory).toBe('adapter-openclaw');
    expect(merged.plugins.allow).toContain('adapter-openclaw');
    const mergedEntry = merged.plugins.entries['adapter-openclaw'];
    expect(mergedEntry.enabled).toBe(true);
    // D2: adapter runtime config lives in the plugin entry now (was
    // $WORKSPACE_DIR/config.json before PR #232). Full shape — daemonUrl,
    // memory.enabled, channel.enabled — is what openclaw-entry.mjs reads.
    expect(mergedEntry.config).toBeDefined();
    expect(typeof mergedEntry.config.daemonUrl).toBe('string');
    expect(mergedEntry.config.daemonUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(mergedEntry.config.memory.enabled).toBe(true);
    expect(mergedEntry.config.channel.enabled).toBe(true);
    // Windows-path normalization assertion: mergeOpenClawConfig normalizes backslashes to
    // forward slashes before storing the path.
    const storedPaths = merged.plugins.load.paths as string[];
    expect(storedPaths.length).toBeGreaterThan(0);
    for (const p of storedPaths) {
      expect(p).not.toContain('\\');
    }
    expect(storedPaths.some((p) => /packages\/adapter-openclaw/.test(p))).toBe(true);

    // Integration record reflects ready state with no lastError.
    const integration = getLocalAgentIntegration(config, 'openclaw');
    expect(integration?.status).toBe('ready');
    expect(integration?.runtime.ready).toBe(true);
    expect(integration?.runtime.lastError).toBeFalsy();
  });

  it('scenario 2: post-Connect Disconnect reverse-merges adapter wiring, writes .bak.<ts>, and removes SKILL.md from the authoritative installedWorkspace', async () => {
    // Seed a pre-merged openclaw.json (as if Connect already ran).
    mergeOpenClawConfig(openclawConfigPath, adapterPath, testEntryConfig, workspaceDir);

    // Codex R2-1: Disconnect MUST target `entry.config.installedWorkspace`, not the
    // openclaw.json workspace keys. To prove that, mutate `installedWorkspace`
    // to a DIFFERENT directory than `agents.defaults.workspace` — the two
    // typically agree in production, but any drift (override flag used, or
    // openclaw.json edited between Connect and Disconnect) must be resolved
    // in favor of the authoritative install path setup actually wrote to.
    const authoritativeInstallDir = join(tempRoot, 'authoritative-install');
    mkdirSync(authoritativeInstallDir, { recursive: true });
    const afterMerge = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    afterMerge.plugins.entries['adapter-openclaw'].config.installedWorkspace = authoritativeInstallDir;
    writeFileSync(openclawConfigPath, JSON.stringify(afterMerge, null, 2));

    // Seed SKILL.md + a sibling `custom-note.md` at the AUTHORITATIVE path —
    // where setup actually installed. Also seed a distinct SKILL.md at the
    // config-derived workspaceDir to show Disconnect does NOT touch it when
    // installedWorkspace is authoritative.
    const installedSkillDir = join(authoritativeInstallDir, 'skills', 'dkg-node');
    const installedSkillPath = join(installedSkillDir, 'SKILL.md');
    const installedSiblingPath = join(installedSkillDir, 'custom-note.md');
    mkdirSync(installedSkillDir, { recursive: true });
    writeFileSync(installedSkillPath, '# Canonical DKG Node Skill (authoritative)\n');
    writeFileSync(installedSiblingPath, '# User note alongside the adapter skill\n');

    const driftSkillDir = join(workspaceDir, 'skills', 'dkg-node');
    const driftSkillPath = join(driftSkillDir, 'SKILL.md');
    mkdirSync(driftSkillDir, { recursive: true });
    writeFileSync(driftSkillPath, '# Stale SKILL.md that Disconnect must NOT touch\n');

    // Sanity: adapter is fully wired before disconnect.
    const before = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(before.plugins.slots.memory).toBe('adapter-openclaw');
    expect(before.plugins.allow).toContain('adapter-openclaw');
    expect(before.plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(authoritativeInstallDir);

    const config = makeConfig();
    await reverseLocalAgentSetupForUi(config, openclawConfigPath);

    const after = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(after.plugins.slots.memory).toBeUndefined();
    expect(after.plugins.allow).not.toContain('adapter-openclaw');
    // D1: adapter entry is removed entirely on unmerge (not just disabled).
    expect(after.plugins.entries['adapter-openclaw']).toBeUndefined();
    const remainingPaths = (after.plugins.load.paths ?? []) as string[];
    expect(remainingPaths.some((p) => /packages[\\/]adapter-openclaw/.test(p))).toBe(false);
    // tools.alsoAllow is intentionally NOT reverted (shared with other plugins per D1 decision).
    expect(after.tools.alsoAllow).toContain('group:plugins');

    // A .bak.<ts> snapshot sits next to the config.
    const siblings = readdirSync(openclawDir);
    expect(siblings.some((name) => /^openclaw\.json\.bak\.\d+$/.test(name))).toBe(true);

    // Authoritative install: SKILL.md retired, sibling custom-note.md survives,
    // outer skills/ parent untouched (other skills may live there).
    expect(existsSync(installedSkillPath)).toBe(false);
    expect(existsSync(installedSiblingPath)).toBe(true);
    expect(existsSync(join(authoritativeInstallDir, 'skills'))).toBe(true);
    // Drift directory: Disconnect did NOT target the config-derived path once
    // installedWorkspace was populated — the stale SKILL.md stays where it is.
    expect(existsSync(driftSkillPath)).toBe(true);
  });

  it('scenario 2b: bare { enabled: false } PUT payload still routes through the reverse-setup path (Codex #2)', async () => {
    // Regression test for https://github.com/OriginTrail/dkg-v9/pull/228#discussion_r3117710814
    // Background: an earlier draft of the PUT handler gated the reverse-merge on
    // `parsed.enabled === false && parsed.runtime?.status === 'disconnected'`, which skipped
    // bare `{ enabled: false }` payloads. Those clients still disabled the integration but left
    // openclaw.json fully wired to adapter-openclaw. The handler now normalizes via
    // `normalizeExplicitLocalAgentDisconnectBody` BEFORE computing `explicitDisconnect`.

    // Seed a pre-merged openclaw.json (as if Connect already ran).
    mergeOpenClawConfig(openclawConfigPath, adapterPath, testEntryConfig, workspaceDir);
    const before = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(before.plugins.slots.memory).toBe('adapter-openclaw');

    // Mirror the exact sequence the PUT handler uses (packages/cli/src/daemon.ts ~6362).
    const parsed: Record<string, unknown> = { enabled: false };
    const normalizedPatch = normalizeExplicitLocalAgentDisconnectBody(parsed);
    const explicitDisconnect = normalizedPatch.enabled === false
      && !!normalizedPatch.runtime
      && (normalizedPatch.runtime as Record<string, unknown>).status === 'disconnected';
    expect(explicitDisconnect).toBe(true);

    // Same SKILL.md + sibling seeding as scenario 2 — the bare-body path must
    // also retire the canonical skill and spare unrelated neighbors.
    const skillDir = join(workspaceDir, 'skills', 'dkg-node');
    const skillPath = join(skillDir, 'SKILL.md');
    const siblingPath = join(skillDir, 'custom-note.md');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, '# Canonical DKG Node Skill\n');
    writeFileSync(siblingPath, '# User note alongside the adapter skill\n');

    const config = makeConfig();
    await reverseLocalAgentSetupForUi(config, openclawConfigPath);

    const after = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(after.plugins.slots.memory).toBeUndefined();
    expect(after.plugins.allow).not.toContain('adapter-openclaw');
    // D1: adapter entry is removed entirely on unmerge.
    expect(after.plugins.entries['adapter-openclaw']).toBeUndefined();

    expect(existsSync(skillPath)).toBe(false);
    expect(existsSync(siblingPath)).toBe(true);
  });

  it('scenario 2c: reverse-setup surfaces non-slot invariant failures via verifyUnmergeInvariants (Codex N3)', async () => {
    // Regression test for https://github.com/OriginTrail/dkg-v9/pull/228#discussion_r3118294850
    // Earlier versions of reverseLocalAgentSetupForUi only post-checked
    // `plugins.slots.memory !== 'adapter-openclaw'`. If a future regression in
    // unmergeOpenClawConfig left the adapter in `plugins.allow`, `plugins.load.paths`, or
    // `plugins.entries[...].enabled === true`, the daemon would still report a successful
    // disconnect while the gateway kept loading the adapter on restart. The helper now
    // defers to the adapter's `verifyUnmergeInvariants`, which covers all four invariants.

    // Seed a pre-merged openclaw.json (as if Connect already ran).
    mergeOpenClawConfig(openclawConfigPath, adapterPath, testEntryConfig, workspaceDir);
    const before = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(before.plugins.slots.memory).toBe('adapter-openclaw');
    expect(before.plugins.allow).toContain('adapter-openclaw');

    // Stub unmergeOpenClawConfig to do a PARTIAL cleanup — clears the slot and the load
    // path (so the old single-check invariant would pass) but leaves the adapter listed
    // in plugins.allow. verifyUnmergeInvariants should flag the latter.
    const partialUnmerge = (configPath: string) => {
      const raw = readFileSync(configPath, 'utf-8');
      const cfg = JSON.parse(raw);
      if (cfg?.plugins?.slots?.memory === 'adapter-openclaw') {
        delete cfg.plugins.slots.memory;
      }
      if (Array.isArray(cfg?.plugins?.load?.paths)) {
        cfg.plugins.load.paths = cfg.plugins.load.paths.filter(
          (p: string) => !/adapter-openclaw/.test(p),
        );
      }
      if (cfg?.plugins?.entries?.['adapter-openclaw']) {
        cfg.plugins.entries['adapter-openclaw'].enabled = false;
      }
      // Intentionally does NOT remove 'adapter-openclaw' from plugins.allow.
      writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    };

    // Load the real verifier from the adapter barrel so we exercise the actual invariant.
    const { verifyUnmergeInvariants } = await import('@origintrail-official/dkg-adapter-openclaw');

    // Seed a SKILL.md at the workspace `mergeOpenClawConfig` recorded above.
    // Post-R3-2 the skill cleanup runs BEFORE the config-level unmerge; we
    // stub the skill steps with passing no-ops so the flow reaches the
    // partial-unmerge + invariant-failure path the test is actually about.
    const skillDir = join(workspaceDir, 'skills', 'dkg-node');
    const skillPath = join(skillDir, 'SKILL.md');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, '# Canonical DKG Node Skill\n');

    const removeSkillStub = vi.fn();
    const verifySkillRemovedStub = vi.fn(() => null);

    const config = makeConfig();
    await expect(
      reverseLocalAgentSetupForUi(config, openclawConfigPath, {
        unmergeOpenClawConfig: partialUnmerge,
        verifyUnmergeInvariants,
        removeCanonicalNodeSkill: removeSkillStub,
        verifySkillRemoved: verifySkillRemovedStub,
      }),
    ).rejects.toThrow(/plugins\.allow still contains/);

    // The partial cleanup did happen on disk — this asserts the invariant check fired
    // specifically on the allow-list regression.
    const after = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(after.plugins.slots.memory).toBeUndefined();
    expect(after.plugins.allow).toContain('adapter-openclaw');

    // Post-R3-2 ordering: skill cleanup ran BEFORE the unmerge, against the
    // same workspaceDir `mergeOpenClawConfig` persisted on the entry.
    expect(removeSkillStub).toHaveBeenCalledTimes(1);
    expect(removeSkillStub.mock.calls[0][0]).toBe(workspaceDir);
    expect(verifySkillRemovedStub).toHaveBeenCalledTimes(1);
  });

  it('scenario 2d: legacy (pre-R2) openclaw.json without installedWorkspace SKIPS skill cleanup but still unmerges the config (R11-2)', async () => {
    // Per R11-2: Disconnect no longer falls back to a config-derived
    // workspace when `entry.config.installedWorkspace` is missing. That
    // fallback would have let Disconnect delete a SKILL.md at a
    // `--workspace`-incongruent path. Instead, legacy entries simply skip
    // the skill-cleanup step; the config-level unmerge still completes,
    // and any pre-R2 SKILL.md the adapter owned stays on disk for the
    // user to clean manually.

    // Seed a legacy adapter entry (no `entry.config.installedWorkspace`).
    writeFileSync(openclawConfigPath, JSON.stringify({
      plugins: {},
      agents: { defaults: { workspace: workspaceDir } },
    }, null, 2));
    mergeOpenClawConfig(openclawConfigPath, adapterPath, testEntryConfig, workspaceDir);
    const mergedPre = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    delete mergedPre.plugins.entries['adapter-openclaw'].config.installedWorkspace;
    writeFileSync(openclawConfigPath, JSON.stringify(mergedPre, null, 2));

    const removeSkillSpy = vi.fn();
    const verifySkillRemovedStub = vi.fn(() => null);

    const config = makeConfig();
    await reverseLocalAgentSetupForUi(config, openclawConfigPath, {
      removeCanonicalNodeSkill: removeSkillSpy,
      verifySkillRemoved: verifySkillRemovedStub,
    });

    // No legacy-fallback guessing → skill cleanup is skipped entirely.
    expect(removeSkillSpy).not.toHaveBeenCalled();
    expect(verifySkillRemovedStub).not.toHaveBeenCalled();

    // Config-level unmerge still completed — the adapter wiring is gone.
    const after = JSON.parse(readFileSync(openclawConfigPath, 'utf-8'));
    expect(after.plugins?.entries?.['adapter-openclaw']).toBeUndefined();
    expect(after.plugins?.allow ?? []).not.toContain('adapter-openclaw');
  });

});
