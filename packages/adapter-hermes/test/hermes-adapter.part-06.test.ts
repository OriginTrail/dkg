import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
vi.mock('@origintrail-official/dkg-core', async () => {
  const actual = await vi.importActual<typeof import('@origintrail-official/dkg-core')>(
    '@origintrail-official/dkg-core',
  );
  return {
    ...actual,
    resolveDkgConfigHome: vi.fn((opts) => actual.resolveDkgConfigHome(opts)),
    resolveDkgHome: vi.fn((opts) => actual.resolveDkgHome(opts)),
  };
});
import { resolveDkgHome } from '@origintrail-official/dkg-core';
import { HermesAdapterPlugin } from '../src/HermesAdapterPlugin.js';
import { registerHermesRoutes } from '../src/hermes-routes.js';
import { HermesDkgClient, redact } from '../src/dkg-client.js';
import {
  disconnectHermesProfile,
  planHermesSetup,
  runDoctor,
  runDisconnect,
  runReconnect,
  resolveHermesProfile,
  runSetup,
  runUninstall,
  runVerify,
  setupHermesProfile,
  uninstallHermesProfile,
  verifyHermesProfile,
} from '../src/setup.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
import { createTrackingApi, trackingRes, type TrackingApi } from './hermes-adapter.shared';

describe('Hermes profile setup helpers', () => {



  it('preserves manual adapter state files during uninstall', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({ hermesHome, profileName: 'dev' });
    const manualPath = join(hermesHome, '.dkg-adapter-hermes', 'operator-note.txt');
    writeFileSync(manualPath, 'keep me\n');

    uninstallHermesProfile({ hermesHome, profileName: 'dev' });

    expect(existsSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'))).toBe(false);
    expect(readFileSync(manualPath, 'utf-8')).toBe('keep me\n');
  });

  it('reports a partially removed provider plugin during verify', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({ hermesHome, profileName: 'dev' });
    rmSync(join(hermesHome, 'plugins', 'dkg'), { recursive: true, force: true });

    const verify = verifyHermesProfile({ hermesHome, profileName: 'dev' });

    expect(verify.ok).toBe(false);
    expect(verify.errors[0]).toContain('provider plugin is missing');
  });

  it('reports missing or unowned dkg.json during verify', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({ hermesHome, profileName: 'dev' });
    rmSync(join(hermesHome, 'dkg.json'), { force: true });

    const missingVerify = verifyHermesProfile({ hermesHome, profileName: 'dev' });
    expect(missingVerify.ok).toBe(false);
    expect(missingVerify.errors.some((error) => error.includes('dkg.json'))).toBe(true);

    writeFileSync(join(hermesHome, 'dkg.json'), JSON.stringify({ managedBy: 'someone-else' }));
    const unownedVerify = verifyHermesProfile({ hermesHome, profileName: 'dev' });
    expect(unownedVerify.ok).toBe(false);
    expect(unownedVerify.errors.some((error) => error.includes('not ownership-marked'))).toBe(true);
  });

  it('reports provider-mode config drift when managed memory.provider is missing', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({ hermesHome, memoryMode: 'provider' });
    writeFileSync(join(hermesHome, 'config.yaml'), 'model: gpt-5\nmemory:\n  retrieval_k: 8\n');

    const verify = verifyHermesProfile({ hermesHome, memoryMode: 'provider' });

    expect(verify.ok).toBe(false);
    expect(verify.errors.some((error) => error.includes('managed memory.provider: dkg'))).toBe(true);
  });

  it('adds a managed provider line inside an existing Hermes memory config', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    writeFileSync(join(hermesHome, 'config.yaml'), 'model: gpt-5\nmemory:\n  retrieval_k: 8\n');

    setupHermesProfile({ hermesHome, memoryMode: 'provider' });

    const config = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8');
    expect((config.match(/^memory:/gm) ?? [])).toHaveLength(1);
    expect(config).toContain('  provider: dkg');
    expect(config).toContain('  retrieval_k: 8');
  });

  it('replaces an empty Hermes provider placeholder instead of shadowing the managed DKG provider', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    writeFileSync(join(hermesHome, 'config.yaml'), [
      'model: gpt-5',
      'memory:',
      '  memory_enabled: true',
      "  provider: ''",
      '  nudge_interval: 10',
      '',
    ].join('\n'));

    setupHermesProfile({ hermesHome, memoryMode: 'provider' });

    const config = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8');
    const providerLines = config.split(/\r?\n/).filter((line) => /^\s+provider\s*:/.test(line));
    const verify = verifyHermesProfile({ hermesHome, memoryMode: 'provider' });
    expect(verify.ok).toBe(true);
    expect(providerLines).toEqual(['  provider: dkg']);
    expect(config).toContain('  memory_enabled: true');
    expect(config).toContain('  nudge_interval: 10');
    expect(config).not.toContain("provider: ''");
  });

  it('reports config drift when a later provider line overrides the managed DKG provider', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({ hermesHome, memoryMode: 'provider' });
    writeFileSync(join(hermesHome, 'config.yaml'), [
      'memory:',
      '  # BEGIN DKG ADAPTER HERMES MANAGED',
      '  provider: dkg',
      '  # END DKG ADAPTER HERMES MANAGED',
      "  provider: ''",
      '',
    ].join('\n'));

    const verify = verifyHermesProfile({ hermesHome, memoryMode: 'provider' });

    expect(verify.ok).toBe(false);
    expect(verify.errors.some((error) => error.includes('effective memory.provider: dkg'))).toBe(true);
  });

  it('marks an existing dkg provider line so verify and disconnect own it', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    writeFileSync(join(hermesHome, 'config.yaml'), 'model: gpt-5\nmemory:\n  provider: dkg\n  retrieval_k: 8\n');

    setupHermesProfile({ hermesHome, memoryMode: 'provider' });

    const config = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8');
    const verify = verifyHermesProfile({ hermesHome, memoryMode: 'provider' });
    expect(verify.ok).toBe(true);
    expect(config).toContain('BEGIN DKG ADAPTER HERMES MANAGED');
    expect(config).toContain('  retrieval_k: 8');
    expect((config.match(/provider: dkg/g) ?? [])).toHaveLength(1);

    disconnectHermesProfile({ hermesHome });

    const disconnectedConfig = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8');
    const disconnectedVerify = verifyHermesProfile({ hermesHome, memoryMode: 'provider' });
    expect(disconnectedConfig).not.toContain('provider: dkg');
    expect(disconnectedConfig).not.toContain('BEGIN DKG ADAPTER HERMES MANAGED');
    expect(disconnectedConfig).toContain('  retrieval_k: 8');
    expect(disconnectedVerify.ok).toBe(true);
    expect(disconnectedVerify.status).toBe('disconnected');
    expect(disconnectedVerify.errors.some((error) => error.includes('managed memory.provider'))).toBe(false);
  });

  it('best-effort disables the daemon registry during disconnect and uninstall', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const body = init?.method === 'GET'
        ? {
            integration: {
              id: 'hermes',
              metadata: { hermesHome },
            },
          }
        : { ok: true };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    setupHermesProfile({
      hermesHome,
      memoryMode: 'provider',
      daemonUrl: 'http://127.0.0.1:9333',
    });

    await runDisconnect({ hermesHome });
    await runUninstall({ hermesHome });

    const disconnectCalls = calls.filter((call) =>
      call.url === 'http://127.0.0.1:9333/api/local-agent-integrations/hermes'
      && call.init.method === 'PUT');
    expect(disconnectCalls).toHaveLength(2);
    for (const call of disconnectCalls) {
      const body = JSON.parse(String(call.init.body));
      expect(body.enabled).toBe(false);
      expect(body.runtime.status).toBe('disconnected');
    }
  });

  it('does not disable a daemon registry entry owned by a different Hermes profile', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-a-'));
    const otherHermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-b-'));
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        integration: {
          id: 'hermes',
          enabled: true,
          metadata: {
            profileName: 'profile-b',
            hermesHome: otherHermesHome,
          },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    setupHermesProfile({
      hermesHome,
      profileName: 'profile-a',
      daemonUrl: 'http://127.0.0.1:9333',
    });

    await runDisconnect({ hermesHome, profile: 'profile-a' });
    await runUninstall({ hermesHome, profile: 'profile-a' });

    expect(calls.filter((call) => call.init.method === 'GET')).toHaveLength(2);
    expect(calls.filter((call) => call.init.method === 'PUT')).toHaveLength(0);
  });

  it('does not create adapter setup state when disconnecting an unconfigured profile', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const plan = disconnectHermesProfile({ hermesHome });
    await runDisconnect({ hermesHome });

    expect(plan.actions).toEqual([
      expect.objectContaining({
        type: 'skip',
        reason: 'Hermes adapter is not configured for this profile',
      }),
    ]);
    expect(existsSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('removes the managed provider block when switching to tools-only mode', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));

    setupHermesProfile({ hermesHome, memoryMode: 'provider' });
    expect(readFileSync(join(hermesHome, 'config.yaml'), 'utf-8')).toContain('provider: dkg');

    const dryRun = planHermesSetup({ hermesHome, memoryMode: 'tools-only', dryRun: true });
    expect(dryRun.actions).toContainEqual(expect.objectContaining({
      type: 'update',
      path: join(hermesHome, 'config.yaml'),
    }));
    expect(readFileSync(join(hermesHome, 'config.yaml'), 'utf-8')).toContain('provider: dkg');

    const plan = setupHermesProfile({ hermesHome, memoryMode: 'tools-only' });
    const config = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8');
    const verify = verifyHermesProfile({ hermesHome });

    expect(plan.profile.memoryMode).toBe('tools-only');
    expect(config).not.toContain('provider: dkg');
    expect(config).not.toContain('BEGIN DKG ADAPTER HERMES MANAGED');
    expect(verify.ok).toBe(true);
    expect(verify.profile.memoryMode).toBe('tools-only');
  });

  it('reconnect preserves a disconnected tools-only profile mode', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    writeFileSync(join(hermesHome, 'config.yaml'), 'memory:\n  provider: mem0\n');
    setupHermesProfile({ hermesHome, memoryMode: 'tools-only' });
    disconnectHermesProfile({ hermesHome });

    await runReconnect({ hermesHome, start: false });

    const config = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8');
    const verify = verifyHermesProfile({ hermesHome });
    expect(config).toContain('provider: mem0');
    expect(config).not.toContain('provider: dkg');
    expect(verify.ok).toBe(true);
    expect(verify.profile.memoryMode).toBe('tools-only');
  });

  it('reconnect preserves persisted daemon and bridge settings when flags are omitted', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({
      hermesHome,
      memoryMode: 'tools-only',
      daemonUrl: 'https://dkg.example.com/',
      gatewayUrl: 'https://hermes.example.com/',
      bridgeHealthUrl: 'https://hermes.example.com/api/hermes-channel/health/',
    });
    disconnectHermesProfile({ hermesHome });

    await runReconnect({ hermesHome, start: false, verify: false });

    const config = JSON.parse(readFileSync(join(hermesHome, 'dkg.json'), 'utf-8'));
    const state = JSON.parse(readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8'));
    expect(config.daemon_url).toBe('https://dkg.example.com');
    expect(config.bridge).toEqual({
      protocol: 'hermes-openai',
      gatewayUrl: 'https://hermes.example.com',
      healthUrl: 'https://hermes.example.com/api/hermes-channel/health',
    });
    expect(state.daemonUrl).toBe('https://dkg.example.com');
    expect(state.bridge).toEqual(config.bridge);
    expect(state.profile.memoryMode).toBe('tools-only');
  });

  it('reconnect can override stale persisted daemon and bridge settings', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({
      hermesHome,
      memoryMode: 'tools-only',
      daemonUrl: 'https://stale-dkg.example.com',
      gatewayUrl: 'https://stale-hermes.example.com',
      bridgeHealthUrl: 'https://stale-hermes.example.com/api/hermes-channel/health',
    });
    disconnectHermesProfile({ hermesHome });

    await runReconnect({
      hermesHome,
      daemonUrl: 'https://fresh-dkg.example.com/',
      gatewayUrl: 'https://fresh-hermes.example.com/',
      bridgeHealthUrl: 'https://fresh-hermes.example.com/api/hermes-channel/health/',
      start: false,
      verify: false,
    });

    const config = JSON.parse(readFileSync(join(hermesHome, 'dkg.json'), 'utf-8'));
    const state = JSON.parse(readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8'));
    expect(config.daemon_url).toBe('https://fresh-dkg.example.com');
    expect(config.bridge).toEqual({
      protocol: 'hermes-openai',
      gatewayUrl: 'https://fresh-hermes.example.com',
      healthUrl: 'https://fresh-hermes.example.com/api/hermes-channel/health',
    });
    expect(state.daemonUrl).toBe('https://fresh-dkg.example.com');
    expect(state.bridge).toEqual(config.bridge);
  });

  it('rejects unsupported non-interactive ask memory mode', async () => {
    await expect(runSetup({
      memoryMode: 'ask' as any,
      dryRun: true,
    })).rejects.toThrow('not supported');
  });

  it('exposes a dry-run CLI setup helper for dkg hermes setup', async () => {
    await expect(runSetup({
      profile: 'dkg-smoke',
      dryRun: true,
      daemonUrl: 'http://127.0.0.1:9200/',
    })).resolves.toBeUndefined();
  });

  it('uses profile in adapter CLI setup options', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));

    // `fund: false` keeps this hermetic: runSetup funds wallets via the
    // live faucet when `fund !== false` (issue #386), and this test only
    // asserts the profile is threaded into the written config — it has no
    // fetch stub, so without this it makes a real network call to the
    // faucet and times out offline (#958).
    await runSetup({
      hermesHome,
      profile: 'explicit',
      start: false,
      verify: false,
      fund: false,
    });

    const config = JSON.parse(readFileSync(join(hermesHome, 'dkg.json'), 'utf-8'));
    const state = JSON.parse(readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8'));
    expect(config.profile_name).toBe('explicit');
    expect(state.profile.profileName).toBe('explicit');
  });

  it('reads the first usable default DKG auth token file line for setup daemon registration', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-'));
    writeFileSync(join(dkgHome, 'auth.token'), '# comment\n\nfile-token\nignored-token\n');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const oldDkgHome = process.env.DKG_HOME;
    const oldApiToken = process.env.DKG_API_TOKEN;
    const oldAuthToken = process.env.DKG_AUTH_TOKEN;
    process.env.DKG_HOME = dkgHome;
    delete process.env.DKG_API_TOKEN;
    delete process.env.DKG_AUTH_TOKEN;
    try {
      // S2.3 (issue #386): `runSetup` now flows through the new
      // `runHermesSetup` orchestrator which spawns the DKG daemon when
      // `start !== false` and funds wallets via the faucet when
      // `fund !== false`. This test exercises the daemon-registration
      // probe against an already-running daemon, so we pass
      // `start: false` + `fund: false` to skip both new steps.
      await runSetup({ hermesHome, verify: false, start: false, fund: false });
    } finally {
      if (oldDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = oldDkgHome;
      if (oldApiToken === undefined) delete process.env.DKG_API_TOKEN;
      else process.env.DKG_API_TOKEN = oldApiToken;
      if (oldAuthToken === undefined) delete process.env.DKG_AUTH_TOKEN;
      else process.env.DKG_AUTH_TOKEN = oldAuthToken;
    }

    expect(calls[0].url).toBe('http://127.0.0.1:9200/api/local-agent-integrations/connect');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer file-token');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.transport).toEqual({
      kind: 'hermes-openai',
      gatewayUrl: 'http://127.0.0.1:8642',
    });
    expect(body.transport.bridgeUrl).toBeUndefined();
  });

});
