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
    startDaemon: vi.fn(async () => {}),
  };
});
import { resolveDkgConfigHome, resolveDkgHome, startDaemon } from '@origintrail-official/dkg-core';
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
  runHermesSetup,
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



  // issue #960 — end-to-end YAML-only Hermes path. A daemon home that has
  // only a `config.yaml` (no `config.json`) is a valid existing node:
  // `resolveDkgConfigHome` and the daemon's `loadConfig` both honor it. The
  // Hermes bootstrap step must treat such a home as already configured and
  // NOT write a fresh `config.json` — doing so would shadow the operator's
  // YAML config and could seed a store backend they never chose.
  it('honors an existing config.yaml DKG home during setup and does not write a shadowing config.json (issue #960)', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-yaml-'));
    const yamlBefore = 'name: yaml-only-node\napiPort: 9201\nnodeRole: edge\n';
    writeFileSync(join(dkgHome, 'config.yaml'), yamlBefore);

    // Registration probe fires regardless of `start` (decoupled per #386),
    // so stub fetch to keep the orchestrator offline-safe.
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const oldDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;
    try {
      await runSetup({ hermesHome, verify: false, start: false, fund: false });
    } finally {
      if (oldDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = oldDkgHome;
    }

    // Bootstrap skipped — no shadowing config.json written.
    expect(existsSync(join(dkgHome, 'config.json'))).toBe(false);
    // The operator's YAML config is left byte-for-byte intact.
    expect(readFileSync(join(dkgHome, 'config.yaml'), 'utf-8')).toBe(yamlBefore);
  });

  // issue #1306 — eager wallet creation. The injected `loadOpWallets` hook
  // fires after config bootstrap and before daemon start, even with --no-fund
  // (mainnet has no faucet but the node still needs wallets), and is skipped
  // under --dry-run. Existing tests omit the hook, so they are unaffected.
  it('#1306: eagerly creates wallets via the injected hook (even --no-fund), skipped on --dry-run', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-1306-'));
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const oldDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;
    try {
      const loadOpWallets = vi.fn(async () => ({
        adminWallet: { address: '0xAAAA', privateKey: '0x0' },
        wallets: [],
      }));

      await runSetup({ hermesHome, verify: false, start: false, fund: false }, { loadOpWallets });
      expect(loadOpWallets).toHaveBeenCalledTimes(1);
      expect(loadOpWallets.mock.calls[0][0]).toBe(dkgHome);

      loadOpWallets.mockClear();
      await runSetup({ hermesHome, verify: false, start: false, fund: false, dryRun: true }, { loadOpWallets });
      expect(loadOpWallets).not.toHaveBeenCalled();
    } finally {
      if (oldDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = oldDkgHome;
      rmSync(hermesHome, { recursive: true, force: true });
      rmSync(dkgHome, { recursive: true, force: true });
    }
  });

  it('#1443: invokes the post-config setup hook, skipped on --dry-run', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-1439-'));
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const oldDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;
    try {
      const afterConfigBootstrap = vi.fn(async () => {});

      await runSetup(
        { hermesHome, verify: false, start: false, fund: false },
        { afterConfigBootstrap },
      );
      expect(afterConfigBootstrap).toHaveBeenCalledTimes(1);
      expect(afterConfigBootstrap.mock.calls[0][0]).toBe(dkgHome);

      afterConfigBootstrap.mockClear();
      await runSetup(
        { hermesHome, verify: false, start: false, fund: false, dryRun: true },
        { afterConfigBootstrap },
      );
      expect(afterConfigBootstrap).not.toHaveBeenCalled();
    } finally {
      if (oldDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = oldDkgHome;
      rmSync(hermesHome, { recursive: true, force: true });
      rmSync(dkgHome, { recursive: true, force: true });
    }
  });

  it('#1451: honors deprecated ensureDashboardCredentials hook as a runtime fallback', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-legacy-hook-'));
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const oldDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;
    try {
      const ensureDashboardCredentials = vi.fn(async () => {});

      await runSetup(
        { hermesHome, verify: false, start: false, fund: false },
        { ensureDashboardCredentials },
      );
      expect(ensureDashboardCredentials).toHaveBeenCalledTimes(1);
      expect(ensureDashboardCredentials.mock.calls[0][0]).toBe(dkgHome);
    } finally {
      if (oldDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = oldDkgHome;
      rmSync(hermesHome, { recursive: true, force: true });
      rmSync(dkgHome, { recursive: true, force: true });
    }
  });

  it('#1439: creates dashboard credentials in the config DKG home when setup starts the daemon', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const configDkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-config-'));
    const daemonDkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-daemon-url-'));
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const oldDkgHome = process.env.DKG_HOME;
    delete process.env.DKG_HOME;
    const configResolver = vi.mocked(resolveDkgConfigHome);
    const homeResolver = vi.mocked(resolveDkgHome);
    const originalResolveDkgConfigHome = configResolver.getMockImplementation();
    const originalResolveDkgHome = homeResolver.getMockImplementation();
    configResolver.mockReturnValue(configDkgHome);
    homeResolver.mockReturnValue(daemonDkgHome);
    vi.mocked(startDaemon).mockClear();
    try {
      const afterConfigBootstrap = vi.fn(async () => {});

      await runSetup(
        {
          hermesHome,
          daemonUrl: 'http://127.0.0.1:9300',
          verify: false,
          fund: false,
        },
        { afterConfigBootstrap },
      );

      expect(startDaemon).toHaveBeenCalledWith(9300);
      expect(resolveDkgHome).toHaveBeenCalledWith({ daemonUrl: 'http://127.0.0.1:9300' });
      expect(afterConfigBootstrap).toHaveBeenCalledTimes(1);
      expect(afterConfigBootstrap.mock.calls[0][0]).toBe(configDkgHome);
      expect(afterConfigBootstrap.mock.calls[0][0]).not.toBe(daemonDkgHome);
    } finally {
      if (originalResolveDkgConfigHome) configResolver.mockImplementation(originalResolveDkgConfigHome);
      if (originalResolveDkgHome) homeResolver.mockImplementation(originalResolveDkgHome);
      vi.mocked(startDaemon).mockClear();
      if (oldDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = oldDkgHome;
      rmSync(hermesHome, { recursive: true, force: true });
      rmSync(configDkgHome, { recursive: true, force: true });
      rmSync(daemonDkgHome, { recursive: true, force: true });
    }
  });

  it('#1439: creates dashboard credentials in the daemon-url resolved DKG home when setup does not start the daemon', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const daemonDkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-daemon-url-'));
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const oldDkgHome = process.env.DKG_HOME;
    delete process.env.DKG_HOME;
    const resolver = vi.mocked(resolveDkgHome);
    const originalResolveDkgHome = resolver.getMockImplementation();
    resolver.mockReturnValue(daemonDkgHome);
    try {
      const afterConfigBootstrap = vi.fn(async () => {});

      await runSetup(
        {
          hermesHome,
          daemonUrl: 'http://127.0.0.1:9300',
          verify: false,
          start: false,
          fund: false,
        },
        { afterConfigBootstrap },
      );

      expect(resolveDkgHome).toHaveBeenCalledWith({ daemonUrl: 'http://127.0.0.1:9300' });
      expect(afterConfigBootstrap).toHaveBeenCalledTimes(1);
      expect(afterConfigBootstrap.mock.calls[0][0]).toBe(daemonDkgHome);
    } finally {
      if (originalResolveDkgHome) resolver.mockImplementation(originalResolveDkgHome);
      if (oldDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = oldDkgHome;
      rmSync(hermesHome, { recursive: true, force: true });
      rmSync(daemonDkgHome, { recursive: true, force: true });
    }
  });

  it('#1443: a failing post-config setup hook does not flip setup to degraded', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-1439f-'));
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const oldDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;
    try {
      const afterConfigBootstrap = vi.fn(async () => { throw new Error('invalid credential file'); });
      const result = await runHermesSetup(
        { hermesHome, verify: false, start: false, fund: false },
        { afterConfigBootstrap },
      );
      expect(afterConfigBootstrap).toHaveBeenCalledTimes(1);
      expect(result.warnings.join('\n')).not.toContain('dashboard login credentials');
      expect(result.errors.join('\n')).not.toContain('dashboard login credentials');
    } finally {
      if (oldDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = oldDkgHome;
      rmSync(hermesHome, { recursive: true, force: true });
      rmSync(dkgHome, { recursive: true, force: true });
    }
  });

  // issue #1306 — a failing wallet pre-creation is best-effort and must NOT push
  // into the status-bearing `warnings[]` (which would flip the integration to
  // `degraded` in the daemon-UI). It goes to console.warn instead. Call
  // runHermesSetup directly to observe `result.warnings`.
  it('#1306: a failing loadOpWallets does not flip setup to degraded (console.warn channel)', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-1306f-'));
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const oldDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;
    try {
      const loadOpWallets = vi.fn(async () => { throw new Error('boom'); });
      const result = await runHermesSetup(
        { hermesHome, verify: false, start: false, fund: false },
        { loadOpWallets },
      );
      expect(loadOpWallets).toHaveBeenCalledTimes(1);
      // The wallet failure must NOT appear in the status-bearing warnings/errors.
      expect(result.warnings.join('\n')).not.toContain('pre-create wallets');
      expect(result.errors.join('\n')).not.toContain('pre-create wallets');
    } finally {
      if (oldDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = oldDkgHome;
      rmSync(hermesHome, { recursive: true, force: true });
      rmSync(dkgHome, { recursive: true, force: true });
    }
  });

  // issue #960 — positive control for the test above: a genuinely fresh DKG
  // home (no config.json AND no config.yaml) DOES get bootstrapped, and the
  // written config adopts the `oxigraph-server` store default. This proves the
  // bootstrap write path is live in this test environment, so the YAML-only
  // test above is meaningfully guarding the gate (not passing vacuously).
  it('bootstraps a fresh DKG home with the oxigraph-server store default during setup (issue #960)', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-fresh-'));

    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const oldDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;
    try {
      await runSetup({ hermesHome, verify: false, start: false, fund: false });
    } finally {
      if (oldDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = oldDkgHome;
    }

    const configPath = join(dkgHome, 'config.json');
    expect(existsSync(configPath)).toBe(true);
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.store).toEqual({ backend: 'oxigraph-server' });
  });

  it('uses the shared monorepo DKG home when DKG_HOME is unset for setup daemon registration', async () => {
    const homeRoot = mkdtempSync(join(tmpdir(), 'hermes-dkg-home-'));
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const dkgHome = join(homeRoot, '.dkg');
    const dkgDevHome = join(homeRoot, '.dkg-dev');
    mkdirSync(dkgHome, { recursive: true });
    mkdirSync(dkgDevHome, { recursive: true });
    writeFileSync(join(dkgHome, 'auth.token'), 'stale-npm-token\n');
    writeFileSync(join(dkgDevHome, 'auth.token'), '# DKG node API token\nlive-dev-token\n');

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
    const oldHome = process.env.HOME;
    const oldUserProfile = process.env.USERPROFILE;
    delete process.env.DKG_HOME;
    delete process.env.DKG_API_TOKEN;
    delete process.env.DKG_AUTH_TOKEN;
    process.env.HOME = homeRoot;
    process.env.USERPROFILE = homeRoot;
    const resolver = vi.mocked(resolveDkgHome);
    resolver.mockClear();

    try {
      // S2.3: pass `start: false` + `fund: false` to skip both new
      // orchestrator steps; this test exercises the registration-probe
      // path against an already-running daemon (registration is decoupled
      // from --no-start per issue #386 brief, so the probe still fires).
      await runSetup({ hermesHome, verify: false, start: false, fund: false });
    } finally {
      if (oldDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = oldDkgHome;
      if (oldApiToken === undefined) delete process.env.DKG_API_TOKEN;
      else process.env.DKG_API_TOKEN = oldApiToken;
      if (oldAuthToken === undefined) delete process.env.DKG_AUTH_TOKEN;
      else process.env.DKG_AUTH_TOKEN = oldAuthToken;
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
    }

    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer live-dev-token');
    const config = JSON.parse(readFileSync(join(hermesHome, 'dkg.json'), 'utf-8'));
    const state = JSON.parse(readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8'));
    expect(config.dkg_home).toBe(dkgDevHome);
    expect(state.dkgHome).toBe(dkgDevHome);
    expect(resolver.mock.calls.some(([opts]) => {
      return (opts as any)?.daemonUrl === 'http://127.0.0.1:9200';
    })).toBe(true);
  });

  it('preserves explicit gateway transport inputs during setup registration', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await runSetup({
      hermesHome,
      verify: false,
      // S2.3: skip new orchestrator steps not under test
      // (test exercises bridge transport persistence, not daemon
      // spawn or faucet funding).
      start: false,
      fund: false,
      gatewayUrl: 'https://hermes.example.com/',
      bridgeHealthUrl: 'https://hermes.example.com/api/hermes-channel/health/',
    });

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.transport).toEqual({
      kind: 'hermes-openai',
      gatewayUrl: 'https://hermes.example.com',
      healthUrl: 'https://hermes.example.com/api/hermes-channel/health',
    });
    const state = JSON.parse(readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8'));
    expect(state.bridge).toEqual({
      protocol: 'hermes-openai',
      gatewayUrl: 'https://hermes.example.com',
      healthUrl: 'https://hermes.example.com/api/hermes-channel/health',
    });
  });

  it('registers tools-only profiles without provider-owned memory capabilities', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await runSetup({
      hermesHome,
      verify: false,
      // S2.3: skip new orchestrator steps not under test
      // (this test exercises tools-only memory-mode capabilities, not
      // daemon spawn or faucet funding).
      start: false,
      fund: false,
      memoryMode: 'tools-only',
    });

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.metadata.memoryMode).toBe('tools-only');
    expect(body.capabilities.dkgPrimaryMemory).toBe(false);
    expect(body.capabilities.wmImportPipeline).toBe(false);
    expect(body.capabilities.localChat).toBe(true);
  });

  it('rejects bridge health URLs without a matching transport base', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));

    // S2.3: skip new orchestrator steps not under test on each
    // invocation. These three cases test bridge-URL validation inside
    // `setupHermesProfile`, not the daemon-start or faucet flows.
    await expect(runSetup({
      hermesHome,
      verify: false,
      start: false,
      fund: false,
      bridgeHealthUrl: 'https://hermes.example.com/health',
    })).rejects.toThrow('requires --bridge-url or --gateway-url');

    await expect(runSetup({
      hermesHome,
      verify: false,
      start: false,
      fund: false,
      gatewayUrl: 'https://hermes.example.com',
      bridgeHealthUrl: 'https://other-hermes.example.com/api/hermes-channel/health',
    })).rejects.toThrow('must belong to the configured');

    await expect(runSetup({
      hermesHome,
      verify: false,
      start: false,
      fund: false,
      gatewayUrl: 'https://hermes.example.com',
      bridgeHealthUrl: 'https://hermes.example.com/health',
    })).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // S2 step 4 — dry-run hardening (issue #386 contract §5 + H-AC-21/25/26).
  // ---------------------------------------------------------------------------

  // H-AC-21: `--dry-run` does not write any file (no `dkg.json`, no
  // plugin dir, no skill, no `setup-state.json`, no `config.yaml.bak.*`,
  // no mutation of existing `config.yaml`). Brief explicitly calls out
  // "no backup file" — assert no `config.yaml.bak.*` exists.
  it('H-AC-21: --dry-run does not write any file under hermesHome', async () => {
    const { runHermesSetup } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-dryrun-'));
    // Pre-snapshot the empty hermesHome contents.
    const before = readdirSync(hermesHome);
    expect(before).toEqual([]);

    const result = await runHermesSetup({
      hermesHome,
      dryRun: true,
      // start/fund/verify default to true but dryRun must short-circuit
      // them per contract §5. We deliberately leave them at defaults to
      // exercise the dryRun-overrides-everything guarantee.
    });

    // Post-snapshot: no files anywhere under hermesHome.
    const after = readdirSync(hermesHome);
    expect(after).toEqual([]);
    // Defense-in-depth: glob-style assertion that no `config.yaml.bak.*`
    // landed (the brief explicitly calls this out).
    const allEntries = [...after];
    for (const entry of allEntries) {
      expect(entry).not.toMatch(/config\.yaml\.bak\./);
    }
    // Result still populated for caller inspection.
    expect(result.daemonStarted).toBe(false);
    expect(result.fundedWallets).toEqual([]);
    expect(result.transport.kind).toMatch(/^hermes-/);
  });

  // H-AC-25: `--dry-run` returns a `HermesSetupResult` where `state` is
  // populated from the in-memory plan (so callers can inspect what
  // would be written), but no actual filesystem writes occurred.
  it('H-AC-25: --dry-run returns a populated state without writing files', async () => {
    const { runHermesSetup } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-dryrun-state-'));

    const result = await runHermesSetup({
      hermesHome,
      dryRun: true,
    });

    // The plan-state IS populated so the caller can preview what would
    // be written (contract §5: "plan describes the planned actions
    // without executing any").
    expect(result.state).toBeDefined();
    expect(result.state?.profile.hermesHome).toBe(resolve(hermesHome));
    expect(result.state?.managedFiles.length).toBeGreaterThan(0);
    // But none of those managed files actually exist on disk.
    for (const path of result.state?.managedFiles ?? []) {
      expect(existsSync(path)).toBe(false);
    }
  });

  // H-AC-58: when both `--port` and `--daemon-url` are passed and the
  // URL host:port disagrees with `--port`, `daemonUrl` wins (first-wins)
  // AND a `console.warn` line is emitted with the verbatim format
  // documented in setup-entrypoint-contract.md §2.
  it('H-AC-58: --port + --daemon-url conflict warns; daemonUrl wins', async () => {
    const { runHermesSetup } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-port-conflict-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runHermesSetup({
      hermesHome,
      daemonUrl: 'http://127.0.0.1:9200',
      port: 9300,
      // Skip new orchestrator steps — we're testing the warn, not the
      // full lifecycle.
      start: false,
      fund: false,
      verify: false,
    });

    // Warn fired with the verbatim format.
    const warnedLines = warnSpy.mock.calls.map((args) => String(args[0]));
    expect(warnedLines).toContain(
      'daemon URL host:port (127.0.0.1:9200) does not match --port (9300); using URL',
    );
    // First-wins: result.state.daemonUrl is the URL, not the port-derived URL.
    expect(result.state?.daemonUrl).toBe('http://127.0.0.1:9200');

    warnSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // S4 step 2 — replace-by-default + backup + prior-provider capture
  // (issue #386, contract §4 + parity-matrix.md Layer 4 + H-AC-27..31).
  // ---------------------------------------------------------------------------

  // H-AC-27: default `runHermesSetup` replaces an existing non-DKG
  // memory.provider with the managed DKG block.
  it('H-AC-27: replaces existing non-DKG memory.provider with managed DKG block by default', async () => {
    const { runHermesSetup, setupHermesProfile } = await import('../src/setup.js');
    void runHermesSetup; // silence unused-import in case orchestrator path is not exercised here
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-replace-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: redis\n  url: redis://localhost\n');

    setupHermesProfile({ hermesHome });

    const after = readFileSync(configPath, 'utf-8');
    expect(after).toContain('# BEGIN DKG ADAPTER HERMES MANAGED');
    expect(after).toContain('# END DKG ADAPTER HERMES MANAGED');
    expect(after).toContain('provider: dkg');
  });

  // H-AC-28: replacement writes a timestamped backup at
  // `<hermesHome>/config.yaml.bak.<unix-ts-ms>`. Bytes equal pre-seeded
  // config.yaml (whole-file backup, not partial).
  it('H-AC-28: replacement writes timestamped backup with verbatim original bytes', async () => {
    const { setupHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-backup-'));
    const configPath = join(hermesHome, 'config.yaml');
    const original = 'memory:\n  provider: claude-memory\n  api_key: sk-fake\n';
    writeFileSync(configPath, original);

    setupHermesProfile({ hermesHome });

    const entries = readdirSync(hermesHome);
    const backups = entries.filter((e) => /^config\.yaml\.bak\.\d+$/.test(e));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(hermesHome, backups[0]), 'utf-8')).toBe(original);
  });

  // H-AC-29: replacement captures prior provider in adapter state.
  // `setup-state.json.priorMemoryProvider` is `{ provider, configBackupPath, capturedAt }`.
  it('H-AC-29: replacement captures priorMemoryProvider in setup-state.json', async () => {
    const { setupHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-capture-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: openai-memory\n');

    setupHermesProfile({ hermesHome });

    const stateRaw = readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8');
    const state = JSON.parse(stateRaw);
    expect(state.priorMemoryProvider).toBeDefined();
    expect(state.priorMemoryProvider.provider).toBe('openai-memory');
    expect(state.priorMemoryProvider.configBackupPath).toMatch(/config\.yaml\.bak\.\d+$/);
    expect(state.priorMemoryProvider.capturedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  // H-AC-29 negative: fresh install (no prior provider) does NOT
  // populate priorMemoryProvider.
  it('H-AC-29 (negative): fresh install does not populate priorMemoryProvider', async () => {
    const { setupHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-fresh-'));
    // No pre-existing config.yaml.

    setupHermesProfile({ hermesHome });

    const stateRaw = readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8');
    const state = JSON.parse(stateRaw);
    expect(state.priorMemoryProvider).toBeUndefined();
    // No backup file either.
    const entries = readdirSync(hermesHome);
    expect(entries.filter((e) => /\.bak\./.test(e))).toEqual([]);
  });

  // H-AC-30 (adapter half): `--preserve-provider` (preserveProvider:true)
  // refuses replacement and throws with the verbatim string from the
  // pre-#386 code so external grep / log scrapers stay stable.
  it('H-AC-30 (adapter): preserveProvider:true throws with verbatim message', async () => {
    const { setupHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-preserve-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: redis\n');

    expect(() => setupHermesProfile({ hermesHome, preserveProvider: true })).toThrow(
      'Refusing to replace existing Hermes memory.provider: redis',
    );
    // No backup written when we throw.
    const entries = readdirSync(hermesHome);
    expect(entries.filter((e) => /\.bak\./.test(e))).toEqual([]);
  });

});
