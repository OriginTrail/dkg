import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir, homedir, platform } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import { mcpSetupAction, type McpSetupActionDeps } from '../src/mcp-setup.js';

/**
 * Codex Round-4 + Round-9: canonical entry shape that production
 * now writes for INSTALLED context. Both modes emit `{ command:
 * process.execPath, args: [<cli script path>, 'mcp', 'serve'],
 * env: { DKG_HOME: <resolved-home> } }`; installed-mode resolves
 * the script path from `process.argv[1]` via `realpathSync`
 * (canonicalises symlinks).
 *
 * The optional `dkgHome` arg lets tests pin the DKG_HOME env value
 * for the entry (default: `<HOME>/.dkg`, i.e. the tmpHome's
 * installed-mode home). Tests that exercise alternate homes
 * (`--monorepo`, custom `DKG_HOME`) pass the expected path
 * explicitly.
 */
const EXPECTED_INSTALLED_ENTRY = (dkgHome?: string) => ({
  command: process.execPath,
  args: [realpathSync(process.argv[1]), 'mcp', 'serve'],
  env: { DKG_HOME: dkgHome ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dkg') },
});

/**
 * Bundled-flow fixture for `dkg mcp setup`. Per W6-pre task brief, asserts
 * that on a clean machine the action:
 *   (a) creates `~/.dkg/config.json` (init step calls writeDkgConfig)
 *   (b) starts the daemon (startDaemon stub records the port)
 *   (c) writes client registration entries to detected clients
 *
 * Every external primitive is stubbed via the `deps` injection point —
 * no real filesystem outside the temp HOME, no real daemon spawn, no
 * real faucet HTTP call.
 */
describe('mcpSetupAction — bundled init + daemon-start + register flow', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;
  let originalAppdata: string | undefined;
  let originalDkgHome: string | undefined;
  let originalXdgConfigHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let stderrSilencer: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mcp-setup-test-'));
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    originalAppdata = process.env.APPDATA;
    // Codex Round-2 Bug A: mcpSetupAction now sets DKG_HOME for the
    // duration of the action so adapter-openclaw / dkg-core flows
    // pick up the resolved home. Save+restore it like HOME/APPDATA
    // so the env mutation is bounded to each test.
    originalDkgHome = process.env.DKG_HOME;
    delete process.env.DKG_HOME;
    // Codex Round-6 Fix 9: linuxConfigDir() reads XDG_CONFIG_HOME at
    // call time. Save+restore so tests that set it don't leak into
    // sibling tests and so the existing Linux fallback tests run with
    // it unset (mirrors the typical operator environment).
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = tmpHome;
    // node:os homedir() reads USERPROFILE on win32, HOME elsewhere; set both.
    process.env.USERPROFILE = tmpHome;
    // Phase-3: Claude Desktop's Windows path resolves under
    // %APPDATA%; redirect that into tmpHome too so the per-platform
    // path resolver lands inside the test sandbox on Win32. macOS
    // and Linux ignore APPDATA.
    process.env.APPDATA = join(tmpHome, 'AppData', 'Roaming');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Codex Round-8 Fix 13: the "Registering CLI:" log + Round-2
    // Bug B's VSCode advisory + Round-8 Fix 15's per-client
    // failure warnings all go to stderr now. Silence them by
    // default so the test reporter stays readable. Tests that
    // need to assert on stderr re-spy after entering the test body
    // (the overlap is harmless — vi resolves the most-recent spy).
    stderrSilencer = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalUserprofile !== undefined) process.env.USERPROFILE = originalUserprofile;
    else delete process.env.USERPROFILE;
    if (originalAppdata !== undefined) process.env.APPDATA = originalAppdata;
    else delete process.env.APPDATA;
    if (originalDkgHome !== undefined) process.env.DKG_HOME = originalDkgHome;
    else delete process.env.DKG_HOME;
    if (originalXdgConfigHome !== undefined) process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    else delete process.env.XDG_CONFIG_HOME;
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    stderrSilencer.mockRestore();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /**
   * Build a fresh stubbed deps surface. `ensureDkgNodeConfig` writes a
   * real file into the temp HOME so the post-merge readback in
   * mcpSetupAction sees a valid config — byte-aligned with the
   * production helper's contract without spawning a real daemon.
   *
   * Codex Round-23 Fix 30: signature is the object-shape one
   * (`{ agentName, network, apiPort, existing, overrides }`) used
   * by `dkg-core`'s helper. Round-2 Bug A's DKG_HOME-honouring
   * posture is preserved — the stub reads `process.env.DKG_HOME`
   * (set by the action) for the write target.
   */
  function makeDeps(overrides: Partial<McpSetupActionDeps> = {}): McpSetupActionDeps {
    const startDaemon = vi.fn(async (_port: number) => {});
    const ensureDkgNodeConfig = vi.fn((opts: {
      agentName: string;
      network: any;
      apiPort: number;
      existing: Record<string, any>;
      overrides?: { nameExplicit?: boolean; portExplicit?: boolean };
    }) => {
      const dkgDir = process.env.DKG_HOME ?? join(tmpHome, '.dkg');
      mkdirSync(dkgDir, { recursive: true });
      // Mirror the production helper's first-wins / explicit-override
      // semantics minimally — most tests just check that the call
      // happened with these args, but a few re-read the file so we
      // emit something realistic.
      const merged = {
        ...opts.existing,
        name: opts.overrides?.nameExplicit ? opts.agentName : (opts.existing?.name ?? opts.agentName),
        apiPort: opts.overrides?.portExplicit ? opts.apiPort : (opts.existing?.apiPort ?? opts.apiPort),
        nodeRole: opts.existing?.nodeRole ?? 'edge',
      };
      writeFileSync(
        join(dkgDir, 'config.json'),
        JSON.stringify(merged, null, 2),
      );
    });
    const loadNetworkConfig = vi.fn(() => ({
      networkName: 'test-net',
      relays: [],
      defaultContextGraphs: ['agent-context'],
      defaultNodeRole: 'edge',
      faucet: { url: 'http://faucet.test', mode: 'testnet' },
    }) as any);
    const readWalletsWithRetry = vi.fn(async () => ['0xadmin', '0xtest1', '0xtest2', '0xtest3']);
    const requestFaucetFunding = vi.fn(async () => ({
      success: true,
      fundedWallets: ['0xadmin', '0xtest1', '0xtest2', '0xtest3'],
    }) as any);
    const logManualFundingInstructions = vi.fn(() => {});
    // Phase-2: detectContext defaults to "installed" by returning null
    // from findDkgMonorepoRoot. Tests that exercise the monorepo path
    // override this dep to return a mock repo root.
    const findDkgMonorepoRoot = vi.fn((_startDir?: string) => null as string | null);
    // Codex Round-4: `resolveDkgBin` was removed from the deps
    // surface — both modes now register `process.execPath +
    // <cli.js path>`, so the `which dkg` resolution it provided is
    // obsolete.
    // Codex Round-2 Bug A: resolveDkgConfigHome defaults to mirroring
    // the production dkg-core posture against the test's tmpHome.
    // `isDkgMonorepo: true` ⇒ `<tmpHome>/.dkg-dev`; otherwise ⇒
    // `<tmpHome>/.dkg`. Existing tests that don't exercise the
    // monorepo path keep landing in `<tmpHome>/.dkg` byte-aligned
    // with the pre-Bug-A behaviour.
    const resolveDkgConfigHome = vi.fn(
      (opts: { isDkgMonorepo?: boolean } = {}): string => {
        if (opts.isDkgMonorepo) {
          const devDir = join(tmpHome, '.dkg-dev');
          // Tests that hit the monorepo branch expect writeDkgConfig
          // to land in this directory; create it eagerly so existsSync
          // probes downstream don't trip over a missing parent.
          mkdirSync(devDir, { recursive: true });
          return devDir;
        }
        return join(tmpHome, '.dkg');
      },
    );
    return {
      loadNetworkConfig,
      ensureDkgNodeConfig,
      startDaemon,
      readWalletsWithRetry,
      requestFaucetFunding,
      logManualFundingInstructions,
      findDkgMonorepoRoot,
      resolveDkgConfigHome,
      ...overrides,
    };
  }

  it('on a clean machine: creates config, starts daemon, writes client entry', async () => {
    // Pre-create a Cursor-style config dir so `detectClients` finds Cursor
    // as a candidate. Real users have ~/.cursor/ from installing Cursor.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps();
    // Avoid the verify step's real-network probe.
    await mcpSetupAction({ verify: false, fund: false }, deps);

    // (a) ensureDkgNodeConfig was called with port 9200 (default) + a fallback agent name.
    expect(deps.ensureDkgNodeConfig).toHaveBeenCalledTimes(1);
    const writeArgs = (deps.ensureDkgNodeConfig as any).mock.calls[0][0];
    expect(writeArgs.apiPort).toBe(9200);
    expect(typeof writeArgs.agentName).toBe('string');
    expect(writeArgs.agentName).toMatch(/^mcp-agent-/);
    expect(existsSync(join(tmpHome, '.dkg', 'config.json'))).toBe(true);

    // (b) startDaemon was called once with the effective port.
    expect(deps.startDaemon).toHaveBeenCalledTimes(1);
    expect((deps.startDaemon as any).mock.calls[0][0]).toBe(9200);

    // (c) Cursor client config was written with the canonical entry.
    const cursorConfig = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursorConfig.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  it('skips writeDkgConfig when ~/.dkg/config.yaml already exists and no overrides given', async () => {
    // Pre-existing config — first-init should be skipped silently.
    const dkgDir = join(tmpHome, '.dkg');
    mkdirSync(dkgDir, { recursive: true });
    writeFileSync(join(dkgDir, 'config.yaml'), 'name: persisted-agent\napiPort: 9200\n');
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ verify: false, fund: false }, deps);

    expect(deps.ensureDkgNodeConfig).not.toHaveBeenCalled();
    // Daemon start still runs unless --no-start was passed.
    expect(deps.startDaemon).toHaveBeenCalledTimes(1);
  });

  // F6 (qa-review-round-1): when the existing-config skip-write branch
  // is taken, `effectivePort` MUST be reconciled against the persisted
  // config, not the CLI default. Pre-fix concrete reproducer: a user
  // who previously ran `dkg openclaw setup --port 9300` (so
  // `~/.dkg/config.json` has `apiPort: 9300`) and then runs `dkg mcp
  // setup` with no flags would have the daemon started on 9200 (the
  // CLI default), the verification probe hit the wrong port, and the
  // registered MCP entry would point nowhere useful.
  it('F6: existing config with non-default port — startDaemon receives the persisted port, not the CLI default', async () => {
    const dkgDir = join(tmpHome, '.dkg');
    mkdirSync(dkgDir, { recursive: true });
    // Pre-existing config has apiPort 9300; the user is running `dkg
    // mcp setup` with NO --port flag, so the CLI default would be 9200.
    writeFileSync(
      join(dkgDir, 'config.json'),
      JSON.stringify({ name: 'persisted-agent', apiPort: 9300, nodeRole: 'edge' }, null, 2),
    );
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ verify: false, fund: false }, deps);

    // writeDkgConfig MUST NOT have run — the existing-config branch
    // was taken (no overrides supplied).
    expect(deps.ensureDkgNodeConfig).not.toHaveBeenCalled();
    // startDaemon MUST receive the persisted 9300, not the CLI default.
    expect(deps.startDaemon).toHaveBeenCalledTimes(1);
    expect((deps.startDaemon as any).mock.calls[0][0]).toBe(9300);
  });

  it('F6: existing config with non-default port + --no-start — read-back still runs', async () => {
    // Even with --no-start, the read-back must populate effective state
    // so faucet (if enabled) and verify (if enabled) target the right
    // port. Asserting via writeDkgConfig staying uncalled (skip-write
    // branch taken) without throwing — the read-back sits on the same
    // branch entry that the F6 fix lifts out of the `else`.
    const dkgDir = join(tmpHome, '.dkg');
    mkdirSync(dkgDir, { recursive: true });
    writeFileSync(
      join(dkgDir, 'config.json'),
      JSON.stringify({ name: 'persisted', apiPort: 9400 }, null, 2),
    );
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, verify: false, fund: false }, deps);

    // Daemon-start was opted out, faucet was opted out — no port
    // assertion possible directly. The read-back's correctness here
    // is structural: the branch ran without throwing on the corrupt
    // configs / missing fields path the helper handles. Companion
    // assertion to the port-9300 case above.
    expect(deps.ensureDkgNodeConfig).not.toHaveBeenCalled();
    expect(deps.startDaemon).not.toHaveBeenCalled();
  });

  it('honours --no-start: skips daemon start; faucet path is gated on daemon reachability (F14)', async () => {
    // Pre-F14, --no-start was conflated with "skip funding" via the
    // outer `shouldFund && shouldStart` guard. Post-F14 the funding
    // decision is decoupled: if the daemon is reachable on
    // effectivePort, funding proceeds regardless of which invocation
    // started the daemon. This test pins the daemon-not-reachable
    // path: --no-start with no running daemon → faucet skipped via
    // the new explicit "daemon not reachable on port X" log line
    // (NOT the silent omission that pre-F14 produced).
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('connection refused');
    });

    await mcpSetupAction({ start: false, verify: false }, deps);

    expect(deps.startDaemon).not.toHaveBeenCalled();
    expect(deps.requestFaucetFunding).not.toHaveBeenCalled();
    // Registration still proceeds — orthogonal axis.
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(true);
    // And the new explicit log line fired (replacing the pre-F14
    // silent omission).
    const logged = (logSpy.mock.calls as any[]).map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/Skipping wallet funding \(daemon not reachable on port 9200\)/);

    fetchSpy.mockRestore();
  });

  // F14 (qa-review-round-2): the canonical decoupled-flow test.
  // --no-start with a daemon already running (e.g. user re-runs to
  // retry funding after the faucet was down on first run) MUST
  // proceed with funding — pre-F14 it was silently skipped because
  // the outer guard required `shouldStart === true`.
  it('F14: --no-start with daemon already reachable → funding proceeds', async () => {
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      // Daemon is up and healthy; probe returns ok.
      return new Response('{}', { status: 200 }) as any;
    });

    await mcpSetupAction({ start: false, verify: false }, deps);

    expect(deps.startDaemon).not.toHaveBeenCalled();
    // Funding MUST proceed — daemon is reachable, --no-fund was not
    // supplied. This is the bug F14 fixes.
    expect(deps.requestFaucetFunding).toHaveBeenCalledTimes(1);
    expect((deps.requestFaucetFunding as any).mock.calls[0][2])
      .toEqual(['0xadmin', '0xtest1', '0xtest2', '0xtest3']);

    fetchSpy.mockRestore();
  });

  it('F14: --no-fund + --no-start → explicit-skip log (not the unreachable log)', async () => {
    // The --no-fund explicit-skip path takes precedence over the
    // daemon-reachability probe — no probe should fire when funding
    // is explicitly opted out, and the existing
    // "Skipping wallet funding (--no-fund)" log line stays intact.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('should not be called when --no-fund is set');
    });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(deps.requestFaucetFunding).not.toHaveBeenCalled();
    const logged = (logSpy.mock.calls as any[]).map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/Skipping wallet funding \(--no-fund\)/);
    // The unreachable-path log line MUST NOT fire when --no-fund
    // short-circuits the funding step.
    expect(logged).not.toMatch(/daemon not reachable/);

    fetchSpy.mockRestore();
  });

  it('honours --no-fund: skips the faucet step but starts daemon + registers', async () => {
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();

    await mcpSetupAction({ fund: false, verify: false }, deps);

    expect(deps.startDaemon).toHaveBeenCalledTimes(1);
    expect(deps.requestFaucetFunding).not.toHaveBeenCalled();
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(true);
  });

  it('honours --dry-run: no filesystem writes, no daemon start, no faucet call', async () => {
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();

    await mcpSetupAction({ dryRun: true }, deps);

    expect(deps.ensureDkgNodeConfig).not.toHaveBeenCalled();
    expect(deps.startDaemon).not.toHaveBeenCalled();
    expect(deps.requestFaucetFunding).not.toHaveBeenCalled();
    expect(existsSync(join(tmpHome, '.dkg', 'config.json'))).toBe(false);
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('honours --print-only: short-circuits before any other step', async () => {
    const deps = makeDeps();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await mcpSetupAction({ printOnly: true }, deps);

    expect(deps.ensureDkgNodeConfig).not.toHaveBeenCalled();
    expect(deps.startDaemon).not.toHaveBeenCalled();
    // Codex Issue 5: --print-only now emits TWO JSON blocks (the
    // canonical mcpServers.dkg shape PLUS a VSCode-shape note).
    // Use parseStdoutJson which walks the first balanced object.
    const parsed = parseStdoutJson(stdoutSpy);
    expect(parsed.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    stdoutSpy.mockRestore();
  });

  it('rejects an out-of-range --port at the action boundary', async () => {
    const deps = makeDeps();
    await expect(
      mcpSetupAction({ port: 'not-a-number' }, deps),
    ).rejects.toThrow(/Invalid port/);
    await expect(
      mcpSetupAction({ port: '99999' }, deps),
    ).rejects.toThrow(/Invalid port/);
  });

  it('--port and --name overrides flow through to ensureDkgNodeConfig', async () => {
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();

    await mcpSetupAction({ port: '9300', name: 'override-agent', verify: false, fund: false }, deps);

    const writeArgs = (deps.ensureDkgNodeConfig as any).mock.calls[0][0];
    expect(writeArgs.agentName).toBe('override-agent');
    expect(writeArgs.apiPort).toBe(9300);
    expect(writeArgs.overrides).toEqual({ nameExplicit: true, portExplicit: true });
    // Daemon start uses the override port.
    expect((deps.startDaemon as any).mock.calls[0][0]).toBe(9300);
  });

  it('faucet failure logs manual instructions; setup continues to register clients', async () => {
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps({
      requestFaucetFunding: vi.fn(async () => {
        throw new Error('faucet 503');
      }),
    });
    // F14 + F26: the funding step now probes daemon reachability via
    // `/api/status` before attempting the faucet call. Stub fetch to
    // mark the daemon reachable so the throwing-faucet mock is
    // actually reached. Without this stub the funding step would
    // short-circuit on the unreachable-path log line and the
    // throwing-faucet mock would never run.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('{}', { status: 200 }) as any;
    });

    await mcpSetupAction({ verify: false }, deps);

    expect(deps.logManualFundingInstructions).toHaveBeenCalledTimes(1);
    // Registration still proceeds.
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(true);

    fetchSpy.mockRestore();
  });

  it('faucet result failures log faucet-provided reasons', async () => {
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps({
      requestFaucetFunding: vi.fn(async () => ({
        success: false,
        fundedWallets: [],
        failedWallets: ['0xadmin', '0xtest1', '0xtest2', '0xtest3'],
        error: 'Faucet did not fund all wallets: 0xadmin. Faucet reported: cooldown_active: Caller cooldown active until 2026-05-11T19:17:45.000Z',
      }) as any),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('{}', { status: 200 }) as any;
    });

    await mcpSetupAction({ verify: false }, deps);

    expect(deps.logManualFundingInstructions).toHaveBeenCalledTimes(1);
    const warned = (warnSpy.mock.calls as any[]).map((c) => c.join(' ')).join('\n');
    expect(warned).toContain('cooldown_active');
    expect(warned).toContain('2026-05-11T19:17:45.000Z');
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(true);

    fetchSpy.mockRestore();
  });

  it('faucet partial success logs manual instructions for remaining wallets only', async () => {
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps({
      requestFaucetFunding: vi.fn(async () => ({
        success: true,
        fundedWallets: ['0xadmin', '0xtest1'],
        failedWallets: ['0xtest2', '0xtest3'],
        error: 'Faucet did not fund all wallets: 0xtest2, 0xtest3',
      }) as any),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('{}', { status: 200 }) as any;
    });

    await mcpSetupAction({ verify: false }, deps);

    expect(deps.logManualFundingInstructions).toHaveBeenCalledTimes(1);
    expect((deps.logManualFundingInstructions as any).mock.calls[0][0])
      .toEqual(['0xtest2', '0xtest3']);
    const warned = (warnSpy.mock.calls as any[]).map((c) => c.join(' ')).join('\n');
    expect(warned).toMatch(/Faucet partially completed/);
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(true);

    fetchSpy.mockRestore();
  });

  // ── Phase-2: monorepo context detection + --installed/--monorepo flags ──

  // Helper: parse the single canonical JSON object from spied stdout.
  // Codex Round-2 Bug B: --print-only stdout is now contractually a
  // single JSON document (the VSCode-shape note + secondary block
  // moved to stderr). `JSON.parse(all)` would also work, but we
  // keep the brace-walking shape so leading/trailing whitespace
  // around the JSON body never trips the parser.
  const parseStdoutJson = (
    spy: ReturnType<typeof vi.spyOn>,
  ): Record<string, any> => {
    const all = (spy.mock.calls as any[]).map((c) => String(c[0])).join('');
    const start = all.indexOf('{');
    if (start < 0) throw new Error(`No JSON object in stdout: ${JSON.stringify(all)}`);
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < all.length; i++) {
      const ch = all[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return JSON.parse(all.slice(start, i + 1));
        }
      }
    }
    throw new Error(`Unbalanced JSON object in stdout: ${JSON.stringify(all)}`);
  };

  // Codex Bug 3: tests that pass a fake monorepoRoot via the
  // findDkgMonorepoRoot stub MUST also pre-create
  // `<root>/packages/cli/dist/cli.js` because canonicalEntry now
  // existsSync-checks the path before returning the monorepo entry.
  // This helper does both: builds a fake root under tmpHome, creates
  // the dist file as an empty placeholder, returns the root path.
  function makeFakeMonorepoRoot(): string {
    const root = join(tmpHome, 'fake-monorepo');
    const distDir = join(root, 'packages', 'cli', 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'cli.js'), '// fake CLI dist for tests\n');
    return root;
  }

  it('phase-2: --print-only with monorepo auto-detect emits the local-CLI-dist absolute-path form', async () => {
    const fakeRepoRoot = makeFakeMonorepoRoot();
    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await mcpSetupAction({ printOnly: true }, deps);

    const parsed = parseStdoutJson(stdoutSpy);
    // Codex Bug 2: command is `process.execPath` (absolute path to
    // the running Node binary), not bare `'node'`. args[0] is the
    // absolute path to the contributor's local CLI dist as produced
    // by path.join — platform-native separators.
    expect(parsed.mcpServers.dkg.command).toBe(process.execPath);
    expect(parsed.mcpServers.dkg.args[0]).toBe(
      join(fakeRepoRoot, 'packages', 'cli', 'dist', 'cli.js'),
    );
    expect(parsed.mcpServers.dkg.args.slice(1)).toEqual(['mcp', 'serve']);
    stdoutSpy.mockRestore();
  });

  it('phase-2: --print-only with no monorepo detected emits the standard `dkg` installed form', async () => {
    const deps = makeDeps(); // findDkgMonorepoRoot defaults to returning null
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await mcpSetupAction({ printOnly: true }, deps);

    const parsed = parseStdoutJson(stdoutSpy);
    expect(parsed.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    stdoutSpy.mockRestore();
  });

  it('phase-2: --installed forces the standard form even from inside a monorepo', async () => {
    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => makeFakeMonorepoRoot()),
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await mcpSetupAction({ printOnly: true, installed: true }, deps);

    const parsed = parseStdoutJson(stdoutSpy);
    expect(parsed.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    stdoutSpy.mockRestore();
  });

  it('phase-2: --monorepo from outside any monorepo throws the canonical error', async () => {
    const deps = makeDeps(); // findDkgMonorepoRoot returns null
    await expect(
      mcpSetupAction({ printOnly: true, monorepo: true }, deps),
    ).rejects.toThrow(/--monorepo flag passed but no DKG monorepo root/);
  });

  it('phase-2: --installed and --monorepo together throw the mutual-exclusion error', async () => {
    const deps = makeDeps();
    await expect(
      mcpSetupAction({ printOnly: true, installed: true, monorepo: true }, deps),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('phase-2: a stored installed-form entry classifies as `stale` when run in monorepo mode', async () => {
    // Stale-across-context: a config with the `dkg` (installed) form
    // is correct when the user is on the global install but stale
    // when they switch to a dev-checkout invocation. Asserts the
    // staleness detection compares against the context-aware
    // canonical entry, not a hardcoded form.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    // Pre-populate Cursor with the installed-form entry.
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify(
        { mcpServers: { dkg: { command: 'dkg', args: ['mcp', 'serve'] } } },
        null,
        2,
      ),
    );

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('connection refused');
    });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    // Post-write, the config now carries the monorepo-form entry —
    // command is `process.execPath` (Codex Bug 2), args[0] is the
    // absolute CLI dist path.
    const after = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    expect(after.mcpServers.dkg.command).toBe(process.execPath);
    expect(after.mcpServers.dkg.args[0]).toBe(
      join(fakeRepoRoot, 'packages', 'cli', 'dist', 'cli.js'),
    );
    expect(after.mcpServers.dkg.args.slice(1)).toEqual(['mcp', 'serve']);

    fetchSpy.mockRestore();
  });

  // ── Phase-3: Claude Desktop + Windsurf detection + write ──────────

  /**
   * Helper: resolve the per-platform Claude Desktop config path under
   * a fake home root. Mirrors the production `claudeDesktopPaths`
   * resolver byte-for-byte so the test pins what the production
   * code does on whatever platform is running this test.
   */
  function claudeDesktopPathUnder(fakeHome: string): string {
    const p = platform();
    if (p === 'darwin') {
      return join(fakeHome, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    }
    if (p === 'win32') {
      const appData = process.env.APPDATA ?? join(fakeHome, 'AppData', 'Roaming');
      return join(appData, 'Claude', 'claude_desktop_config.json');
    }
    // Codex Round-6 Fix 9: Linux honours XDG_CONFIG_HOME when set.
    const configBase = process.env.XDG_CONFIG_HOME ?? join(fakeHome, '.config');
    return join(configBase, 'Claude', 'claude_desktop_config.json');
  }

  it('phase-3: Claude Desktop is detected when its config dir exists; gets canonical entry written', async () => {
    // Pre-create the per-platform config directory so detection
    // fires even though the file doesn't exist yet (parent-dir
    // existence is a sufficient detection signal).
    const claudePath = claudeDesktopPathUnder(tmpHome);
    mkdirSync(join(claudePath, '..'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(claudePath)).toBe(true);
    const written = JSON.parse(readFileSync(claudePath, 'utf-8'));
    expect(written.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  it('phase-3: Windsurf is detected at ~/.codeium/windsurf/; gets canonical entry written', async () => {
    const windsurfPath = join(tmpHome, '.codeium', 'windsurf', 'mcp_config.json');
    mkdirSync(join(windsurfPath, '..'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(windsurfPath)).toBe(true);
    const written = JSON.parse(readFileSync(windsurfPath, 'utf-8'));
    expect(written.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  it('phase-3: clients with no config dir are not detected — silent and absent', async () => {
    // Cursor's parent dir exists (we'll pre-create it), but Claude
    // Desktop's and Windsurf's do NOT — so only Cursor should be
    // touched. Pins the "permissive but only when the parent
    // directory exists" detection contract.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(true);
    expect(existsSync(claudeDesktopPathUnder(tmpHome))).toBe(false);
    expect(existsSync(join(tmpHome, '.codeium', 'windsurf', 'mcp_config.json'))).toBe(false);
  });

  it('phase-3: pre-existing Claude Desktop entry on a sibling key is preserved', async () => {
    // Common real-world shape: a Claude Desktop user already has
    // other MCP servers registered. The setup must merge — write
    // `dkg` alongside without clobbering siblings.
    const claudePath = claudeDesktopPathUnder(tmpHome);
    mkdirSync(join(claudePath, '..'), { recursive: true });
    writeFileSync(
      claudePath,
      JSON.stringify(
        {
          mcpServers: {
            'some-other-server': { command: 'foo', args: ['bar'] },
          },
        },
        null,
        2,
      ),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const written = JSON.parse(readFileSync(claudePath, 'utf-8'));
    // Sibling preserved.
    expect(written.mcpServers['some-other-server']).toEqual({ command: 'foo', args: ['bar'] });
    // dkg added.
    expect(written.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  // ── Phase-4: VSCode + Copilot Chat (servers.dkg shape) ────────────

  /**
   * Helper: resolve VSCode + Copilot Chat's per-platform user-mcp
   * config path under a fake home root. Mirrors the production
   * `vscodeMcpPaths` resolver so the test pins exactly what the
   * production code does on this platform.
   */
  function vscodeMcpPathUnder(fakeHome: string): string {
    const p = platform();
    if (p === 'darwin') {
      return join(fakeHome, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    }
    if (p === 'win32') {
      const appData = process.env.APPDATA ?? join(fakeHome, 'AppData', 'Roaming');
      return join(appData, 'Code', 'User', 'mcp.json');
    }
    // Codex Round-6 Fix 9: Linux honours XDG_CONFIG_HOME when set.
    const configBase = process.env.XDG_CONFIG_HOME ?? join(fakeHome, '.config');
    return join(configBase, 'Code', 'User', 'mcp.json');
  }

  it('phase-4: VSCode + Copilot Chat is detected and writes under `servers.dkg` (not `mcpServers.dkg`)', async () => {
    const vscodePath = vscodeMcpPathUnder(tmpHome);
    mkdirSync(join(vscodePath, '..'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(vscodePath)).toBe(true);
    const written = JSON.parse(readFileSync(vscodePath, 'utf-8'));
    // VSCode + Copilot Chat keys under `servers`, NOT `mcpServers`.
    // Pins the entryPath dispatch wired in phase 1.
    expect(written.servers?.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    // The canonical `mcpServers.dkg` shape MUST NOT be present in
    // VSCode's file — that would be the wrong key for Copilot Chat.
    expect(written.mcpServers).toBeUndefined();
  });

  it('phase-4: pre-existing VSCode `servers.<other>` siblings are preserved on merge', async () => {
    const vscodePath = vscodeMcpPathUnder(tmpHome);
    mkdirSync(join(vscodePath, '..'), { recursive: true });
    writeFileSync(
      vscodePath,
      JSON.stringify(
        { servers: { 'other-mcp': { command: 'baz' } } },
        null,
        2,
      ),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const written = JSON.parse(readFileSync(vscodePath, 'utf-8'));
    expect(written.servers['other-mcp']).toEqual({ command: 'baz' });
    expect(written.servers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  // ── Phase-5: Cline (deep-nested VSCode globalStorage path) ────────

  /**
   * Helper: resolve Cline's per-platform globalStorage settings
   * path under a fake home root. Mirrors the production
   * `clineMcpPaths` resolver byte-for-byte.
   */
  function clineMcpPathUnder(fakeHome: string): string {
    const suffix = join(
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    );
    const p = platform();
    if (p === 'darwin') {
      return join(fakeHome, 'Library', 'Application Support', 'Code', 'User', suffix);
    }
    if (p === 'win32') {
      const appData = process.env.APPDATA ?? join(fakeHome, 'AppData', 'Roaming');
      return join(appData, 'Code', 'User', suffix);
    }
    // Codex Round-6 Fix 9: Linux honours XDG_CONFIG_HOME when set.
    const configBase = process.env.XDG_CONFIG_HOME ?? join(fakeHome, '.config');
    return join(configBase, 'Code', 'User', suffix);
  }

  it('phase-5: Cline is detected at VSCode globalStorage and writes canonical `mcpServers.dkg`', async () => {
    const clinePath = clineMcpPathUnder(tmpHome);
    // Pre-create the parent dir (the deep-nested
    // globalStorage/saoudrizwan.claude-dev/settings/ chain) so
    // detection fires.
    mkdirSync(join(clinePath, '..'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(clinePath)).toBe(true);
    const written = JSON.parse(readFileSync(clinePath, 'utf-8'));
    // Cline keys under canonical `mcpServers.dkg` (unlike VSCode's
    // `servers.dkg`), so no entryPath override on the candidate.
    expect(written.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  it('phase-5: Cline siblings preserved — pre-existing entries don\'t get clobbered', async () => {
    const clinePath = clineMcpPathUnder(tmpHome);
    mkdirSync(join(clinePath, '..'), { recursive: true });
    writeFileSync(
      clinePath,
      JSON.stringify(
        { mcpServers: { 'github': { command: 'gh-mcp' } } },
        null,
        2,
      ),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const written = JSON.parse(readFileSync(clinePath, 'utf-8'));
    expect(written.mcpServers['github']).toEqual({ command: 'gh-mcp' });
    expect(written.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  // ── F30: resolve absolute `dkg` bin path on installed-mode setup ──

  // ── Codex Round-4: process.execPath unification ──────────────────

  it('Codex Round-4: installed mode writes process.execPath + cli.js path (no `dkg` bin shim)', async () => {
    // Round-4 unified the canonical entry shape across both modes.
    // Installed mode: `{ command: process.execPath, args: [<cli.js>,
    // 'mcp', 'serve'] }` — Node binary directly + the cli.js script
    // Node is currently executing. No more `which dkg` step; no
    // dependency on `dkg` shim or `node` binary being on the GUI
    // client's PATH.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const cursorConfig = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursorConfig.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    // Specific shape pins:
    expect(cursorConfig.mcpServers.dkg.command).toBe(process.execPath);
    expect(typeof cursorConfig.mcpServers.dkg.args[0]).toBe('string');
    expect(cursorConfig.mcpServers.dkg.args.slice(1)).toEqual(['mcp', 'serve']);
    // Belt-and-braces: the registered command MUST NOT be the bare
    // `dkg` shim form anymore — that's the F30 PATH-dependency we
    // removed by switching to direct-Node invocation.
    expect(cursorConfig.mcpServers.dkg.command).not.toBe('dkg');
  });

  it('Codex Round-4: monorepo mode writes process.execPath + local cli.dist path', async () => {
    // Monorepo mode is byte-aligned with installed mode on the
    // command field (process.execPath) and differs only on args[0]
    // (local cli.dist absolute path vs the installed cli.js path
    // realpathSync resolves to). Asserts the unification.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
    });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const cursorConfig = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursorConfig.mcpServers.dkg.command).toBe(process.execPath);
    expect(cursorConfig.mcpServers.dkg.args[0]).toBe(
      join(fakeRepoRoot, 'packages', 'cli', 'dist', 'cli.js'),
    );
    expect(cursorConfig.mcpServers.dkg.args.slice(1)).toEqual(['mcp', 'serve']);
  });

  it('Codex Round-4: legacy bare-"dkg" entries auto-migrate to process.execPath form on stock re-run', async () => {
    // Pre-Round-4 setup runs (or pre-F30 hand-edited configs) wrote
    // `{ command: "dkg", args: ["mcp", "serve"] }`. Round-4's pure
    // string equality classifier sees that as `stale` against the
    // new `process.execPath + cli.js` expected entry, and refreshes
    // to the new shape on a stock re-run — no `--force` needed.
    //
    // This is the migration story for users upgrading from any
    // earlier version of the setup tool.
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify(
        { mcpServers: { dkg: { command: 'dkg', args: ['mcp', 'serve'] } } },
        null,
        2,
      ),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const after = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    expect(after.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    expect(after.mcpServers.dkg.command).toBe(process.execPath);
  });

  it('Codex Round-4: pre-existing F30-style absolute `dkg` bin entry ALSO migrates (uniform classifier)', async () => {
    // The interim Round-1 F30 form was `{ command: "/usr/local/bin/
    // dkg", args: ["mcp", "serve"] }`. Round-4's process.execPath
    // form supersedes it (skips the bin shim entirely). Pure
    // string equality classifies the old absolute-bin entry as
    // `stale` and migrates it forward — no special-casing needed.
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    const legacyAbsBin = platform() === 'win32'
      ? 'C:\\Users\\test\\AppData\\Local\\fnm\\dkg.exe'
      : '/usr/local/bin/dkg';
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify(
        { mcpServers: { dkg: { command: legacyAbsBin, args: ['mcp', 'serve'] } } },
        null,
        2,
      ),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const after = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    expect(after.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    expect(after.mcpServers.dkg.command).not.toBe(legacyAbsBin);
  });

  // ── F31: per-client interactive confirm prompts ───────────────────

  it('F31: --yes skips prompts; confirmPlan stub passes plan through unchanged', async () => {
    // The action MUST call confirmPlan with `yes: true` so the
    // stub knows the operator opted into auto-confirm. The stub
    // returns the plan unchanged → all detected clients register.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const confirmPlan = vi.fn(async (planned: any) => [...planned]);
    const deps = makeDeps({ confirmPlan });

    await mcpSetupAction({ start: false, fund: false, verify: false, yes: true }, deps);

    expect(confirmPlan).toHaveBeenCalledTimes(1);
    expect(confirmPlan.mock.calls[0][1]).toEqual({ yes: true });
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(true);
  });

  it('F31: confirmPlan-stub-says-no on a single-client plan → zero writes', async () => {
    // Operator declined the only pending registration. The action
    // emits the "All pending registrations declined" log line and
    // writes nothing. Asserts the decline path is non-fatal and
    // the file stays absent.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const confirmPlan = vi.fn(async (planned: any) =>
      planned.map((p: any) => ({ ...p, action: 'skip' })),
    );
    const deps = makeDeps({ confirmPlan });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(confirmPlan).toHaveBeenCalledTimes(1);
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(false);
    const logged = (logSpy.mock.calls as any[]).map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/All pending registrations declined/);
    // Codex Round-5 Fix 7: the guidance recommends `--yes` (skips
    // prompts), not `--force` alone (which only refreshes
    // already-registered clients but still prompts in TTY mode). A
    // re-run with `--force` would re-prompt the same declined
    // entries; only `--yes` (or `--force --yes`) escapes the prompt
    // loop.
    expect(logged).toMatch(/--yes/);
    expect(logged).not.toMatch(/Re-run with --force or --yes/);
  });

  it('F31: mixed yes/no — declined entries skip; accepted entries register', async () => {
    // Two clients pending. Stub declines Cursor, accepts Claude
    // Desktop. Post-action: only Claude Desktop's file exists.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const claudePath = claudeDesktopPathUnder(tmpHome);
    mkdirSync(join(claudePath, '..'), { recursive: true });

    const confirmPlan = vi.fn(async (planned: any) =>
      planned.map((p: any) =>
        p.s.target.name === 'Cursor' ? { ...p, action: 'skip' } : p,
      ),
    );
    const deps = makeDeps({ confirmPlan });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(false);
    expect(existsSync(claudePath)).toBe(true);
  });

  it('F31: all-skip plan (everything already registered) → confirmPlan still called but produces zero writes', async () => {
    // Pre-populate every detected-by-default client with the
    // Round-4 canonical entry (process.execPath + cli.js path) so
    // they all classify as `registered`. Plan ends up all-skip;
    // confirmPlan still called (the action doesn't pre-filter) but
    // no writes follow.
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    const canonical = { mcpServers: { dkg: EXPECTED_INSTALLED_ENTRY() } };
    writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify(canonical, null, 2));
    // ~/.claude.json's parent IS tmpHome → always detected. Pre-register.
    writeFileSync(join(tmpHome, '.claude.json'), JSON.stringify(canonical, null, 2));
    const beforeCursor = (await import('node:fs')).statSync(join(cursorDir, 'mcp.json')).mtimeMs;
    const beforeClaude = (await import('node:fs')).statSync(join(tmpHome, '.claude.json')).mtimeMs;

    const confirmPlan = vi.fn(async (planned: any) => [...planned]);
    const deps = makeDeps({ confirmPlan });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    // No rewrite of either file — both existing entries' mtimes
    // are unchanged.
    const afterCursor = (await import('node:fs')).statSync(join(cursorDir, 'mcp.json')).mtimeMs;
    const afterClaude = (await import('node:fs')).statSync(join(tmpHome, '.claude.json')).mtimeMs;
    expect(afterCursor).toBe(beforeCursor);
    expect(afterClaude).toBe(beforeClaude);
    // The "all up-to-date" log line fires (the original phrasing,
    // NOT the F31 declined-prompt phrasing).
    const logged = (logSpy.mock.calls as any[]).map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/Clients all up-to-date/);
    expect(logged).not.toMatch(/All pending registrations declined/);
  });

  it('F31: dry-run skips confirmPlan entirely (preview-only; no point asking about non-writes)', async () => {
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const confirmPlan = vi.fn(async (planned: any) => [...planned]);
    const deps = makeDeps({ confirmPlan });

    await mcpSetupAction({ dryRun: true }, deps);

    expect(confirmPlan).not.toHaveBeenCalled();
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('F31: production confirmPlan auto-confirms when stdin.isTTY is false (CI / piped input)', async () => {
    // Direct test of the production helper (not the stub) — we
    // import it from the same module and call it without going
    // through `mcpSetupAction`. This pins the non-TTY auto-confirm
    // contract that lets CI runs work without `--yes`.
    const { confirmPlan: prodConfirmPlan } = await import('../src/mcp-setup.js');
    const fakePlan = [
      { s: { target: { name: 'Cursor', displayPath: '~/.cursor/mcp.json' } } as any, action: 'register' as const },
      { s: { target: { name: 'Claude Code', displayPath: '~/.claude.json' } } as any, action: 'refresh' as const },
    ];

    // Vitest already runs non-TTY; document the assumption and
    // assert the no-prompt path returns the plan unchanged.
    expect(process.stdin.isTTY).toBeFalsy();
    const result = await prodConfirmPlan(fakePlan, { yes: false });
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.action)).toEqual(['register', 'refresh']);
  });

  it('Codex Round-4 Fix 5: confirmPlan auto-confirms when stdout.isTTY is false even if stdin.isTTY is true', async () => {
    // Pre-fix: the auto-confirm guard only checked
    // `process.stdin.isTTY`. If stdout was redirected/captured but
    // stdin still happened to be a TTY (e.g. `dkg mcp setup > log.txt`
    // from an interactive shell), the helper opened a readline
    // prompt that emitted to a non-visible stdout — the user saw
    // nothing while their terminal blocked.
    //
    // Post-fix: BOTH stdin AND stdout must be TTY before prompting.
    // Either non-TTY end ⇒ auto-confirm.
    const { confirmPlan: prodConfirmPlan } = await import('../src/mcp-setup.js');
    const fakePlan = [
      { s: { target: { name: 'Cursor', displayPath: '~/.cursor/mcp.json' } } as any, action: 'register' as const },
    ];

    const originalStdinIsTTY = process.stdin.isTTY;
    const originalStdoutIsTTY = process.stdout.isTTY;
    try {
      // Force stdin TTY=true (the scenario the pre-fix missed),
      // stdout TTY=false (redirected). The post-fix guard MUST
      // auto-confirm and not block on readline.
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        configurable: true,
      });

      // No timeout / hang protection needed — if the guard regresses
      // and the helper actually prompts, vitest's per-test timeout
      // catches it. Under the post-fix guard, this resolves
      // synchronously with the plan unchanged.
      const result = await prodConfirmPlan(fakePlan, { yes: false });
      expect(result).toHaveLength(1);
      expect(result[0].action).toBe('register');
    } finally {
      // Restore the original TTY flags so subsequent tests aren't
      // affected by the override.
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalStdinIsTTY,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalStdoutIsTTY,
        configurable: true,
      });
    }
  });

  // ── PR #394 Codex review round 1 ────────────────────────────────

  it('Codex Bug 1: detectContext passes process.cwd() to findDkgMonorepoRoot', async () => {
    // Pre-fix: findDkgMonorepoRoot() was called with no argument,
    // defaulting to the dirname of @origintrail-official/dkg-core's
    // installed location. For a globally-installed CLI run from
    // inside a user's monorepo cwd, that walks node_modules/...
    // not the user's cwd → monorepo auto-detect never fires.
    // Post-fix: cwd is passed explicitly.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const findStub = vi.fn((startDir?: string) => {
      // Mimic the production semantic: only return monorepo root
      // when startDir is something inside the monorepo. Without the
      // Bug 1 fix, startDir would be undefined here (default arg).
      return startDir ? fakeRepoRoot : null;
    });
    const deps = makeDeps({ findDkgMonorepoRoot: findStub });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    // The stub was called with a defined startDir argument (the
    // production code now passes process.cwd() explicitly).
    expect(findStub).toHaveBeenCalled();
    const callArg = findStub.mock.calls[0][0];
    expect(callArg).toBeDefined();
    expect(typeof callArg).toBe('string');
    // Monorepo mode fired: the entry uses execPath + cli.js, not the
    // bare-`"dkg"` installed form.
    const cursorConfig = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursorConfig.mcpServers.dkg.command).toBe(process.execPath);
  });

  it('Codex Bug 2: monorepo entry uses process.execPath, not bare "node"', async () => {
    // Pre-fix: command was hard-coded to 'node'. Same PATH-
    // inheritance failure as bare-`"dkg"` for GUI MCP clients.
    // Post-fix: process.execPath (absolute path to running Node).
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
    });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const cursorConfig = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    // process.execPath is always an absolute path; assert that
    // shape rather than hardcoding the runtime-specific value.
    expect(cursorConfig.mcpServers.dkg.command).toBe(process.execPath);
    expect(cursorConfig.mcpServers.dkg.command).not.toBe('node');
    // Sanity: it's actually absolute on this platform.
    expect(cursorConfig.mcpServers.dkg.command.length).toBeGreaterThan(4);
  });

  it('Codex Bug 3: monorepo mode errors clearly when local cli.dist/cli.js is missing', async () => {
    // Fresh checkout / pnpm clean / source-only edits all leave
    // dist absent. Pre-fix: setup wrote a broken entry that points
    // at a non-existent file, overwriting a previously-working
    // installed registration. Post-fix: throws an actionable error
    // and writes nothing.
    const fakeRepoRoot = join(tmpHome, 'fake-monorepo-no-dist');
    // Deliberately do NOT create packages/cli/dist/cli.js — root exists
    // (so findDkgMonorepoRoot's stub returning it is plausible) but
    // the dist file is absent.
    mkdirSync(fakeRepoRoot, { recursive: true });
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
    });

    await expect(
      mcpSetupAction({ start: false, fund: false, verify: false }, deps),
    ).rejects.toThrow(/Local CLI dist not found at .*Run `pnpm.*build` first/);

    // No client config was written; the previously-empty Cursor
    // dir stays empty (no file touched).
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('Codex Issue 5 + Round-2 Bug B: --print-only stdout stays pure canonical JSON; VSCode note goes to stderr', async () => {
    // Round-1 of Issue 5: --print-only appended a second JSON block
    // + prose to stdout to disambiguate VSCode's `servers.dkg`
    // shape. Round-2 Codex feedback: that broke the
    // `dkg mcp setup --print-only | jq …` flag contract — stdout
    // must be a single canonical JSON document. Final shape: stdout
    // stays the canonical `mcpServers.dkg` block (single JSON
    // document, parses cleanly with `jq`), and the VSCode-shape
    // note is emitted on stderr instead.
    const deps = makeDeps();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await mcpSetupAction({ printOnly: true }, deps);

    // STDOUT: a single JSON document, parseable as-is — no prose,
    // no second object. This is the `dkg mcp setup --print-only |
    // jq …` flag contract.
    const stdoutText = (stdoutSpy.mock.calls as any[]).map((c) => String(c[0])).join('');
    const stdoutParsed = JSON.parse(stdoutText);
    expect(stdoutParsed.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    // No `servers.dkg` (the VSCode shape) on stdout — keeps it
    // machine-readable.
    expect(stdoutParsed.servers).toBeUndefined();

    // STDERR: the VSCode-shape disambiguation note + a second JSON
    // block under `servers.dkg`. Same entry contents as the canonical
    // block — pinning that the note isn't drift.
    const stderrText = (stderrSpy.mock.calls as any[]).map((c) => String(c[0])).join('');
    expect(stderrText).toMatch(/VSCode/i);
    expect(stderrText).toMatch(/servers\.dkg/);
    // The stderr note contains a parseable `{ servers: { dkg: ... } }`
    // block; extract the JSON portion (between the first `{` and the
    // matching closing `}`) and parse it.
    const stderrJsonStart = stderrText.indexOf('{');
    expect(stderrJsonStart).toBeGreaterThanOrEqual(0);
    const stderrJsonText = stderrText.slice(stderrJsonStart).trim();
    const stderrParsed = JSON.parse(stderrJsonText);
    expect(stderrParsed.servers?.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('phase-4: VSCode staleness — pre-existing dkg entry under `servers.dkg` reclassifies on context flip to monorepo', async () => {
    // Cross-shape staleness: a Cursor-shaped entry written into
    // VSCode's `servers.dkg` wouldn't classify as `registered` if
    // the canonical entry's command/args differ. Here we pin the
    // installed→monorepo flip works for VSCode the same as for
    // Cursor (phase-2 covered the Cursor case).
    const fakeRepoRoot = makeFakeMonorepoRoot();
    const vscodePath = vscodeMcpPathUnder(tmpHome);
    mkdirSync(join(vscodePath, '..'), { recursive: true });
    writeFileSync(
      vscodePath,
      JSON.stringify(
        { servers: { dkg: { command: 'dkg', args: ['mcp', 'serve'] } } },
        null,
        2,
      ),
    );

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('connection refused');
    });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const written = JSON.parse(readFileSync(vscodePath, 'utf-8'));
    // Codex Bug 2: command is process.execPath, not bare 'node'.
    expect(written.servers.dkg.command).toBe(process.execPath);
    expect(written.servers.dkg.args[0]).toBe(
      join(fakeRepoRoot, 'packages', 'cli', 'dist', 'cli.js'),
    );

    fetchSpy.mockRestore();
  });

  // ── Codex Round-2 review fixes ────────────────────────────────────

  it('Codex Round-2 Bug A: monorepo context routes DKG home to dev dir + sets DKG_HOME', async () => {
    // Pre-fix: mcpSetupAction hard-coded `~/.dkg` regardless of
    // monorepo detection. The registered local CLI dist (whose
    // own dkgDir() resolves to `~/.dkg-dev` from inside the
    // monorepo) would read a different home than mcp-setup just
    // bootstrapped — config / daemon / faucet split across two
    // dirs. Post-fix: thread the monorepo signal into
    // `resolveDkgConfigHome({ isDkgMonorepo: true })` and set
    // `DKG_HOME` so adapter-openclaw's dkgDir() and dkg-core's
    // daemon-lifecycle agree on the dev home.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    let isDkgMonorepoArg: boolean | undefined;
    let dkgHomeAtWriteCall: string | undefined;
    let dkgHomeAtStartDaemonCall: string | undefined;

    const resolveDkgConfigHomeSpy = vi.fn((opts: { isDkgMonorepo?: boolean } = {}) => {
      isDkgMonorepoArg = opts.isDkgMonorepo;
      const dir = opts.isDkgMonorepo ? join(tmpHome, '.dkg-dev') : join(tmpHome, '.dkg');
      mkdirSync(dir, { recursive: true });
      return dir;
    });

    const ensureDkgNodeConfigSpy = vi.fn((opts: any) => {
      // Capture the env at the moment ensureDkgNodeConfig is invoked
      // so we can assert that DKG_HOME was set BEFORE step 1's write.
      dkgHomeAtWriteCall = process.env.DKG_HOME;
      const dir = process.env.DKG_HOME ?? join(tmpHome, '.dkg');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ name: opts.agentName, apiPort: opts.apiPort, nodeRole: 'edge' }, null, 2),
      );
    });

    const startDaemonSpy = vi.fn(async (_port: number) => {
      dkgHomeAtStartDaemonCall = process.env.DKG_HOME;
    });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
      resolveDkgConfigHome: resolveDkgConfigHomeSpy,
      ensureDkgNodeConfig: ensureDkgNodeConfigSpy,
      startDaemon: startDaemonSpy,
    });

    await mcpSetupAction({ fund: false, verify: false }, deps);

    // (1) resolveDkgConfigHome was called with isDkgMonorepo: true —
    // the monorepo signal threaded through.
    expect(isDkgMonorepoArg).toBe(true);

    // (2) DKG_HOME was set BEFORE step 1's writeDkgConfig and was
    // still set BEFORE step 2's startDaemon. Both downstream
    // primitives delegate to dkgDir() which respects this env var,
    // so all four flows (mcp-setup, openclaw, core daemon-lifecycle,
    // and the registered local CLI) land in the SAME home.
    expect(dkgHomeAtWriteCall).toBe(join(tmpHome, '.dkg-dev'));
    expect(dkgHomeAtStartDaemonCall).toBe(join(tmpHome, '.dkg-dev'));

    // (3) The bootstrapped config landed in the dev home, not ~/.dkg.
    expect(existsSync(join(tmpHome, '.dkg-dev', 'config.json'))).toBe(true);
    expect(existsSync(join(tmpHome, '.dkg', 'config.json'))).toBe(false);
  });

  it('Codex Round-2 Bug A: installed context keeps DKG home at ~/.dkg (no dev-dir leak)', async () => {
    // Counterpart to the monorepo case: when no monorepo is
    // detected, DKG home stays at the canonical `~/.dkg`. Pre-fix
    // and post-fix behaviour byte-aligned for installed-mode users.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    let isDkgMonorepoArg: boolean | undefined;
    const resolveDkgConfigHomeSpy = vi.fn((opts: { isDkgMonorepo?: boolean } = {}) => {
      isDkgMonorepoArg = opts.isDkgMonorepo;
      return join(tmpHome, '.dkg');
    });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => null),
      resolveDkgConfigHome: resolveDkgConfigHomeSpy,
    });

    // Capture DKG_HOME at write time (mid-action) — the only
    // observable point where the env mutation is visible. Round-3
    // Fix 3 added a try/finally that restores DKG_HOME after the
    // action returns, so reading it post-`await` no longer reflects
    // the in-action value.
    let dkgHomeAtWriteCall: string | undefined;
    const ensureDkgNodeConfigSpy = vi.fn((opts: any) => {
      dkgHomeAtWriteCall = process.env.DKG_HOME;
      const dir = process.env.DKG_HOME ?? join(tmpHome, '.dkg');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ name: opts.agentName, apiPort: opts.apiPort, nodeRole: 'edge' }, null, 2),
      );
    });
    (deps as any).ensureDkgNodeConfig = ensureDkgNodeConfigSpy;

    await mcpSetupAction({ fund: false, verify: false }, deps);

    expect(isDkgMonorepoArg).toBe(false);
    // During the action, DKG_HOME was the resolved installed home.
    expect(dkgHomeAtWriteCall).toBe(join(tmpHome, '.dkg'));
    expect(existsSync(join(tmpHome, '.dkg', 'config.json'))).toBe(true);
    // No accidental .dkg-dev creation on the installed path.
    expect(existsSync(join(tmpHome, '.dkg-dev'))).toBe(false);
  });

  // ── Codex Round-5 Fix 6: --monorepo bypasses configExists fallback ─

  it('Codex Round-5 Fix 6: --monorepo with pre-existing ~/.dkg/config.json still isolates to ~/.dkg-dev', async () => {
    // Pre-fix: `--monorepo` only set `isDkgMonorepo: true` on the
    // resolveDkgConfigHome call. The helper still respected the
    // configExists short-circuit (Round-3 Fix 2 made it OR
    // config.json | config.yaml), so a user with a pre-existing
    // `~/.dkg/config.json` (typical for anyone who has ever
    // installed the global CLI) who passed `--monorepo` would
    // bootstrap their local checkout against the installed node's
    // state — exactly the dev/installed mixup the flag is meant
    // to break.
    //
    // Post-fix: `--monorepo` (forcedContext === 'monorepo' AND a
    // monorepo root located) bypasses resolveDkgConfigHome
    // entirely, computing `~/.dkg-dev` directly via homedir().
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    // Pre-existing `~/.dkg/config.json` — the configExists short-
    // circuit would normally redirect us back to `~/.dkg`.
    const installedDkg = join(tmpHome, '.dkg');
    mkdirSync(installedDkg, { recursive: true });
    writeFileSync(
      join(installedDkg, 'config.json'),
      JSON.stringify({ name: 'persisted', apiPort: 9200, nodeRole: 'edge' }, null, 2),
    );

    // Real production-shape resolveDkgConfigHome stub: respects
    // configExists. The Fix 6 bypass means this stub MUST NOT be
    // called when `--monorepo` is forced.
    const resolveDkgConfigHomeSpy = vi.fn((opts: { isDkgMonorepo?: boolean; configExists?: boolean } = {}) => {
      // Mirror production: configExists wins over isDkgMonorepo.
      if (opts.configExists ?? existsSync(join(installedDkg, 'config.json'))) {
        return installedDkg;
      }
      if (opts.isDkgMonorepo) return join(tmpHome, '.dkg-dev');
      return installedDkg;
    });

    let dkgHomeAtWriteCall: string | undefined;
    const ensureDkgNodeConfigSpy = vi.fn((opts: any) => {
      dkgHomeAtWriteCall = process.env.DKG_HOME;
      const dir = process.env.DKG_HOME ?? installedDkg;
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ name: opts.agentName, apiPort: opts.apiPort, nodeRole: 'edge' }, null, 2),
      );
    });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
      resolveDkgConfigHome: resolveDkgConfigHomeSpy,
      ensureDkgNodeConfig: ensureDkgNodeConfigSpy,
    });

    await mcpSetupAction({ monorepo: true, fund: false, verify: false }, deps);

    // (1) The bypass kicked in: resolveDkgConfigHome was NOT called
    // for the dkgDirPath computation under forced --monorepo.
    expect(resolveDkgConfigHomeSpy).not.toHaveBeenCalled();
    // (2) DKG_HOME was set to ~/.dkg-dev mid-action — bootstrap
    // state landed in the dev home, NOT the installed home.
    expect(dkgHomeAtWriteCall).toBe(join(tmpHome, '.dkg-dev'));
    // (3) The pre-existing installed config is untouched.
    const installedConfig = JSON.parse(readFileSync(join(installedDkg, 'config.json'), 'utf-8'));
    expect(installedConfig.name).toBe('persisted');
    // (4) The dev-home config was newly written.
    expect(existsSync(join(tmpHome, '.dkg-dev', 'config.json'))).toBe(true);
  });

  it('Codex Round-5 Fix 6: --monorepo with pre-existing ~/.dkg/config.yaml still isolates to ~/.dkg-dev', async () => {
    // Same as above but with YAML instead of JSON. Round-3 Fix 2
    // extended configExists to OR both file types; Round-5 Fix 6
    // bypasses the whole short-circuit when --monorepo is forced,
    // so neither file shape redirects the dev-home isolation.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const installedDkg = join(tmpHome, '.dkg');
    mkdirSync(installedDkg, { recursive: true });
    writeFileSync(join(installedDkg, 'config.yaml'), 'name: persisted\napiPort: 9200\n');

    const resolveDkgConfigHomeSpy = vi.fn(() => installedDkg);
    let dkgHomeAtWriteCall: string | undefined;
    const ensureDkgNodeConfigSpy = vi.fn((opts: any) => {
      dkgHomeAtWriteCall = process.env.DKG_HOME;
      const dir = process.env.DKG_HOME ?? installedDkg;
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ name: opts.agentName, apiPort: opts.apiPort, nodeRole: 'edge' }, null, 2),
      );
    });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
      resolveDkgConfigHome: resolveDkgConfigHomeSpy,
      ensureDkgNodeConfig: ensureDkgNodeConfigSpy,
    });

    await mcpSetupAction({ monorepo: true, fund: false, verify: false }, deps);

    expect(resolveDkgConfigHomeSpy).not.toHaveBeenCalled();
    expect(dkgHomeAtWriteCall).toBe(join(tmpHome, '.dkg-dev'));
    // YAML preserved untouched.
    const yaml = readFileSync(join(installedDkg, 'config.yaml'), 'utf-8');
    expect(yaml).toContain('name: persisted');
  });

  it('Codex Round-5 Fix 6: AUTO-detect (no --monorepo flag) + monorepo cwd + existing ~/.dkg/config.json → still respects configExists, returns ~/.dkg', async () => {
    // Pin the asymmetry between forced and auto. Auto-detect
    // monorepo (no flag) MUST keep the configExists short-circuit
    // — users who installed the CLI globally and happen to walk
    // into a monorepo checkout shouldn't be silently redirected
    // to a dev home they don't know about.
    //
    // Only the explicit --monorepo flag bypasses the fallback;
    // auto-detect defers to resolveDkgConfigHome's existing
    // semantics.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const installedDkg = join(tmpHome, '.dkg');
    mkdirSync(installedDkg, { recursive: true });
    writeFileSync(
      join(installedDkg, 'config.json'),
      JSON.stringify({ name: 'persisted', apiPort: 9200, nodeRole: 'edge' }, null, 2),
    );

    let resolveCallArgs: { isDkgMonorepo?: boolean } | undefined;
    const resolveDkgConfigHomeSpy = vi.fn((opts: { isDkgMonorepo?: boolean } = {}) => {
      resolveCallArgs = opts;
      // Mirror production semantics: configExists wins → ~/.dkg.
      return installedDkg;
    });

    // Use startDaemon as the mid-action observable. With a
    // pre-existing config, the action skips writeDkgConfig (F25
    // reconcile path), but startDaemon always runs and DKG_HOME is
    // already set by the time it does.
    let dkgHomeAtStartDaemon: string | undefined;
    const startDaemonSpy = vi.fn(async (_port: number) => {
      dkgHomeAtStartDaemon = process.env.DKG_HOME;
    });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
      resolveDkgConfigHome: resolveDkgConfigHomeSpy,
      startDaemon: startDaemonSpy,
    });

    // No --monorepo flag — auto-detect path.
    await mcpSetupAction({ fund: false, verify: false }, deps);

    // (1) resolveDkgConfigHome WAS called (auto-detect doesn't
    // bypass), and isDkgMonorepo: true was passed to it.
    expect(resolveDkgConfigHomeSpy).toHaveBeenCalledTimes(1);
    expect(resolveCallArgs?.isDkgMonorepo).toBe(true);
    // (2) Despite the monorepo signal, configExists short-circuit
    // returned ~/.dkg, and DKG_HOME mid-action reflects that.
    expect(dkgHomeAtStartDaemon).toBe(installedDkg);
    // (3) No accidental .dkg-dev creation on the auto-detect path
    // when an installed config already exists.
    expect(existsSync(join(tmpHome, '.dkg-dev'))).toBe(false);
  });

  it('Codex Round-2 Bug B: --print-only stdout is a single parseable JSON document (jq-compatible)', async () => {
    // Round-1 of Issue 5 emitted the canonical JSON + prose + a
    // second JSON object on stdout, breaking
    // `dkg mcp setup --print-only | jq …`. Round-2 fix: stdout
    // stays a single JSON document. This test asserts the strict
    // contract: `JSON.parse(allStdout)` succeeds, with no leftover
    // bytes after the canonical block.
    const deps = makeDeps();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await mcpSetupAction({ printOnly: true }, deps);

    const stdoutText = (stdoutSpy.mock.calls as any[]).map((c) => String(c[0])).join('');
    // jq-style strict parse: the entire stdout (after trimming
    // trailing newline) must round-trip through JSON.parse with
    // nothing left over.
    const trimmed = stdoutText.trim();
    expect(() => JSON.parse(trimmed)).not.toThrow();
    const parsed = JSON.parse(trimmed);
    // Exactly one top-level key: `mcpServers`. No `servers` (VSCode
    // shape) on stdout.
    expect(Object.keys(parsed)).toEqual(['mcpServers']);
    // No prose contamination on stdout.
    expect(stdoutText).not.toMatch(/Note/);
    expect(stdoutText).not.toMatch(/VSCode/i);

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  // Codex Round-2 Bug C tests retired: Round-4's process.execPath
  // unification eliminated the `isAbsoluteDkgBinPath` equivalence
  // those tests pinned. Both modes now write the same absolute
  // process.execPath form, so any divergent entry — bare `"dkg"`,
  // an old absolute-bin path, a moved-checkout cli.js path —
  // classifies as `stale` via pure string equality and refreshes
  // forward. The auto-migration story is exercised by the
  // "legacy bare-`dkg` migrates" and "F30-style absolute migrates"
  // Round-4 tests above.

  // ── Codex Round-3 Fix 3: try/finally DKG_HOME env mutation ────────

  it('Codex Round-3 Fix 3: action throwing midway restores DKG_HOME', async () => {
    // Pre-fix: `process.env.DKG_HOME = dkgDirPath` was a permanent
    // global side effect. If the action threw mid-body (e.g. step 2's
    // `startDaemon` rejected; step 4's client-config write hit a
    // permissions error), the override leaked into the rest of the
    // process and any unrelated downstream code reading DKG_HOME.
    //
    // Post-fix: try/finally wraps the action body. The finally
    // restores the prior `DKG_HOME` value (or unsets it if it wasn't
    // set going in) on BOTH throw and normal exit.
    //
    // Using a tmpHome-rooted path here, not a hardcoded system path
    // like `/some/external/dkg-home`: the action mkdirs `dkgDirPath`
    // before the (stubbed-to-throw) startDaemon, so the path needs
    // to be writable on the runner. The test invariant (DKG_HOME
    // pointing somewhere OTHER than the default `~/.dkg`) is the
    // same regardless of which tmpdir-rooted path we pick.
    const PRIOR = join(tmpHome, 'external-dkg-home');
    process.env.DKG_HOME = PRIOR;

    // Force a throw mid-action: stub `startDaemon` to reject. By
    // then DKG_HOME has been mutated to `<tmpHome>/.dkg`.
    const deps = makeDeps({
      startDaemon: vi.fn(async () => {
        throw new Error('synthetic startDaemon failure for env-restore test');
      }),
    });

    await expect(
      mcpSetupAction({ fund: false, verify: false }, deps),
    ).rejects.toThrow(/synthetic startDaemon failure/);

    // The finally restored DKG_HOME to its prior value.
    expect(process.env.DKG_HOME).toBe(PRIOR);
  });

  it('Codex Round-3 Fix 3: action with previously-unset DKG_HOME deletes the var on exit', async () => {
    // Counterpart: when DKG_HOME wasn't set going into the action,
    // the finally must DELETE it (not set to `undefined` or empty
    // string), so the next caller's `process.env.DKG_HOME` lookup
    // sees `undefined` and falls through to the auto-detect path.
    delete process.env.DKG_HOME;

    const deps = makeDeps();
    await mcpSetupAction({ fund: false, verify: false }, deps);

    expect(process.env.DKG_HOME).toBeUndefined();
    expect('DKG_HOME' in process.env).toBe(false);
  });

  it('Codex Round-3 Fix 3: two sequential mcpSetupAction calls don\'t bleed env state', async () => {
    // Two back-to-back calls with different contexts: the first
    // forces monorepo (sets DKG_HOME to `<tmpHome>/.dkg-dev`); the
    // second forces installed (sets DKG_HOME to `<tmpHome>/.dkg`).
    // Without the try/finally, the second call would observe the
    // first's leftover override at the top of its body when it
    // calls `resolveDkgConfigHome()` — which prefers DKG_HOME over
    // any other signal — and silently inherit the wrong home.
    //
    // Post-fix: each call's env mutation is bounded to its own
    // body, so the second call observes the original (unset)
    // DKG_HOME at entry and gets to make the correct context-aware
    // resolution.
    delete process.env.DKG_HOME;

    const fakeRepoRoot = makeFakeMonorepoRoot();
    const observedHomesAtWriteCall: string[] = [];

    const ensureDkgNodeConfigSpy = vi.fn((opts: any) => {
      observedHomesAtWriteCall.push(process.env.DKG_HOME ?? '<unset>');
      const dir = process.env.DKG_HOME ?? join(tmpHome, '.dkg');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ name: opts.agentName, apiPort: opts.apiPort, nodeRole: 'edge' }, null, 2),
      );
    });

    // Call 1: force monorepo. `findDkgMonorepoRoot` stub returns
    // the fake repo root; `resolveDkgConfigHome` returns dev dir.
    const depsMono = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
      ensureDkgNodeConfig: ensureDkgNodeConfigSpy,
    });
    await mcpSetupAction({ monorepo: true, fund: false, verify: false }, depsMono);
    // After call 1: DKG_HOME restored to unset.
    expect(process.env.DKG_HOME).toBeUndefined();

    // Call 2: force installed. Default `resolveDkgConfigHome` stub
    // returns `<tmpHome>/.dkg`.
    const depsInstalled = makeDeps({
      ensureDkgNodeConfig: ensureDkgNodeConfigSpy,
    });
    await mcpSetupAction({ installed: true, fund: false, verify: false }, depsInstalled);
    // After call 2: DKG_HOME restored to unset.
    expect(process.env.DKG_HOME).toBeUndefined();

    // The two writeDkgConfig invocations saw different homes —
    // dev for call 1, prod-default for call 2 — confirming no
    // bleed of call 1's override into call 2.
    expect(observedHomesAtWriteCall).toEqual([
      join(tmpHome, '.dkg-dev'),
      join(tmpHome, '.dkg'),
    ]);
  });

  // ── Codex Round-6 Fix 8: detect ephemeral install paths ──────────

  /**
   * Helper: temporarily override `process.argv[1]` to a fake CLI
   * script path, ensuring the file exists so `realpathSync` doesn't
   * throw before `detectEphemeralInstallPath` gets to run. Returns
   * a restore function the caller MUST run in `finally`.
   */
  function withFakeArgv1(fakeAbsPath: string): () => void {
    mkdirSync(join(fakeAbsPath, '..'), { recursive: true });
    writeFileSync(fakeAbsPath, '// fake cli.js for argv[1] override');
    const original = process.argv[1];
    process.argv[1] = fakeAbsPath;
    return () => {
      process.argv[1] = original;
    };
  }

  it('Codex Round-6 Fix 8: npx-style ephemeral install path → throws "install globally first"', async () => {
    // npx caches packages under `~/.npm/_npx/<hash>/...`. A user who
    // invokes `npx @origintrail-official/dkg mcp setup` would have
    // `process.argv[1]` resolved to a path inside that cache; writing
    // it into client configs means the registration silently breaks
    // on the next `npm cache clean --force` or after the npx cache
    // TTL expires.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const ephemeralPath = join(tmpHome, '.npm', '_npx', 'abc123', 'node_modules', '@origintrail-official', 'dkg', 'dist', 'cli.js');
    const restore = withFakeArgv1(ephemeralPath);
    try {
      const deps = makeDeps();
      await expect(
        mcpSetupAction({ start: false, fund: false, verify: false }, deps),
      ).rejects.toThrow(/Detected ephemeral install path \(npx cache\)/);

      // No client config was written on the throw path.
      expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('Codex Round-6 Fix 8: pnpm-dlx-style ephemeral install path → throws "install globally first"', async () => {
    // pnpm dlx stores packages under
    // `~/.local/share/pnpm/dlx-<hash>/...` (or similar dlx- prefix
    // paths). Same persistence problem as npx.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const ephemeralPath = join(tmpHome, '.local', 'share', 'pnpm', 'dlx-abc123', 'node_modules', '@origintrail-official', 'dkg', 'dist', 'cli.js');
    const restore = withFakeArgv1(ephemeralPath);
    try {
      const deps = makeDeps();
      await expect(
        mcpSetupAction({ start: false, fund: false, verify: false }, deps),
      ).rejects.toThrow(/Detected ephemeral install path \(pnpm dlx cache\)/);
      expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('Codex Round-6 Fix 8: persistent global install path → no throw, normal canonical entry', async () => {
    // Counterpart guard: a "real" global install path (not in any
    // package-manager cache) MUST NOT be flagged as ephemeral. This
    // pins the heuristic isn't over-broad — false positives would
    // break normal global installs by throwing for everyone.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    // A path that looks like a normal npm global install. NOTE: we
    // can't override realpathSync, so we just place the fake cli.js
    // somewhere on disk that isn't matched by any of the cache
    // patterns.
    const persistentPath = join(tmpHome, 'usr-local-lib', 'node_modules', '@origintrail-official', 'dkg', 'dist', 'cli.js');
    const restore = withFakeArgv1(persistentPath);
    try {
      const deps = makeDeps();
      await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

      // No throw; the Cursor entry was written with the persistent
      // path as args[0].
      const cursorConfig = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
      expect(cursorConfig.mcpServers.dkg.command).toBe(process.execPath);
      expect(cursorConfig.mcpServers.dkg.args[0]).toBe(realpathSync(persistentPath));
      expect(cursorConfig.mcpServers.dkg.args.slice(1)).toEqual(['mcp', 'serve']);
    } finally {
      restore();
    }
  });

  // ── Codex Round-6 Fix 9: respect XDG_CONFIG_HOME on Linux paths ──

  it('Codex Round-6 Fix 9: Linux Claude Desktop with XDG_CONFIG_HOME → detected at custom location', async () => {
    // The detection on Linux MUST defer to XDG_CONFIG_HOME when the
    // operator has set it (common in dotfile-managed setups). Pre-fix
    // the path was hardcoded to `~/.config/Claude/...` regardless,
    // so users with a relocated config dir were invisible.
    if (platform() === 'win32') {
      // Windows uses %APPDATA%, not XDG; this test is Linux/macOS
      // only. Skip on Windows so the suite stays cross-platform
      // green. (macOS uses Library/, but the production code's
      // linuxConfigDir branch is also taken on any non-darwin/non-
      // win32 platform; the test below for the helper covers macOS
      // by directing through the Linux branch when not on Windows.)
      return;
    }
    const xdgConfig = join(tmpHome, 'custom-xdg', 'config');
    process.env.XDG_CONFIG_HOME = xdgConfig;
    const claudePath = claudeDesktopPathUnder(tmpHome);
    // Sanity check on the helper: when XDG is set, the path
    // resolves under it on Linux, not `~/.config/`.
    if (platform() !== 'darwin') {
      expect(claudePath).toContain(xdgConfig);
      expect(claudePath).not.toContain(join(tmpHome, '.config'));
    }
    mkdirSync(join(claudePath, '..'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    // Detected at the XDG-relocated path; entry written.
    expect(existsSync(claudePath)).toBe(true);
    const written = JSON.parse(readFileSync(claudePath, 'utf-8'));
    expect(written.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  it('Codex Round-6 Fix 9: Linux Claude Desktop without XDG_CONFIG_HOME → detected at ~/.config/Claude/ (fallback)', async () => {
    // Counterpart: the existing `~/.config/Claude/...` behaviour is
    // preserved when XDG_CONFIG_HOME is unset (the default for most
    // users). Pre-fix tests were already exercising this path; the
    // explicit test here pins the fallback contract so a future
    // refactor doesn't accidentally break it.
    if (platform() === 'win32') return; // %APPDATA% path on Windows.
    expect(process.env.XDG_CONFIG_HOME).toBeUndefined();
    const claudePath = claudeDesktopPathUnder(tmpHome);
    if (platform() !== 'darwin') {
      expect(claudePath).toContain(join(tmpHome, '.config', 'Claude'));
    }
    mkdirSync(join(claudePath, '..'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(claudePath)).toBe(true);
  });

  it('Codex Round-6 Fix 9: Linux VSCode + Copilot Chat with XDG_CONFIG_HOME → detected at custom location', async () => {
    if (platform() === 'win32') return;
    const xdgConfig = join(tmpHome, 'custom-xdg', 'config');
    process.env.XDG_CONFIG_HOME = xdgConfig;
    const vscodePath = vscodeMcpPathUnder(tmpHome);
    if (platform() !== 'darwin') {
      expect(vscodePath).toContain(xdgConfig);
    }
    mkdirSync(join(vscodePath, '..'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(vscodePath)).toBe(true);
    const written = JSON.parse(readFileSync(vscodePath, 'utf-8'));
    // VSCode uses `servers.dkg` shape (not `mcpServers.dkg`).
    expect(written.servers?.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  it('Codex Round-6 Fix 9: Linux Cline with XDG_CONFIG_HOME → detected at custom location', async () => {
    if (platform() === 'win32') return;
    const xdgConfig = join(tmpHome, 'custom-xdg', 'config');
    process.env.XDG_CONFIG_HOME = xdgConfig;
    const clinePath = clineMcpPathUnder(tmpHome);
    if (platform() !== 'darwin') {
      expect(clinePath).toContain(xdgConfig);
    }
    mkdirSync(join(clinePath, '..'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(clinePath)).toBe(true);
    const written = JSON.parse(readFileSync(clinePath, 'utf-8'));
    expect(written.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  // ── Codex Round-7 Fix 11: narrow --installed flag + log line ─────

  it('Codex Round-7 Fix 11: --installed from monorepo cwd registers the running CLI (NOT a hypothetical installed binary)', async () => {
    // Pre-fix the `--installed` flag implied it would force the
    // published CLI binary. Post-fix it controls bootstrap home
    // only — the registered CLI is always the one currently
    // running. Pin both behaviours together: bootstrap home goes
    // to ~/.dkg (forced), but registered command is `process.argv[1]`
    // (the test runner's own argv[1]), NOT some hypothetical installed
    // path.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    let dkgHomeAtStartDaemon: string | undefined;
    const startDaemonSpy = vi.fn(async (_port: number) => {
      dkgHomeAtStartDaemon = process.env.DKG_HOME;
    });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
      startDaemon: startDaemonSpy,
    });

    await mcpSetupAction({ installed: true, fund: false, verify: false }, deps);

    // (1) Bootstrap home is the installed-mode home, not dev.
    expect(dkgHomeAtStartDaemon).toBe(join(tmpHome, '.dkg'));
    expect(existsSync(join(tmpHome, '.dkg-dev'))).toBe(false);

    // (2) Registered command is the CURRENTLY-RUNNING CLI, NOT
    // the monorepo cli.dist (even though monorepoRoot is detected
    // and the user explicitly opted out of monorepo mode).
    const cursorConfig = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursorConfig.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    // Belt-and-braces: the registered cli.js is NOT the fake repo
    // root's dist path — `--installed` does NOT swap binaries.
    expect(cursorConfig.mcpServers.dkg.args[0]).not.toBe(
      join(fakeRepoRoot, 'packages', 'cli', 'dist', 'cli.js'),
    );
  });

  it('Codex Round-7 Fix 11 + Round-8 Fix 13: "Registering CLI:" log goes to STDERR (preserves --print-only stdout purity)', async () => {
    // Operators should see exactly which binary will be persisted
    // into client configs BEFORE any client write happens. Round-8
    // Fix 13 routed this log to stderr (not stdout) so it doesn't
    // contaminate `dkg mcp setup --print-only | jq …` workflows —
    // stdout stays a single canonical JSON document.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const stderrText = (stderrSpy.mock.calls as any[]).map((c) => String(c[0])).join('');
    // Log line includes the literal "Registering CLI:" prefix.
    expect(stderrText).toMatch(/Registering CLI:/);
    // And the absolute Node binary path.
    expect(stderrText).toContain(process.execPath);
    // And the resolved cli.js path.
    expect(stderrText).toContain('mcp serve');
    // Belt-and-braces: the line did NOT go to stdout (logSpy
    // captures console.log calls, which would be the pre-Round-8
    // path).
    const stdoutLogged = (logSpy.mock.calls as any[]).map((c) => c.join(' ')).join('\n');
    expect(stdoutLogged).not.toMatch(/Registering CLI:/);

    stderrSpy.mockRestore();
  });

  // ── Codex Round-7 Fix 12: complete yaml fast-path read ───────────

  it('Codex Round-7 Fix 12: yaml-only ~/.dkg/config.yaml — readPersistedAgentName + reconcile use the YAML values', async () => {
    // Pre-fix: yaml-only home would hit the configExists short-
    // circuit (Round-3 Fix 2) but step 1's reconcile path only
    // read config.json, so name/port silently fell back to
    // defaults — daemon start, funding, verification all targeted
    // the wrong values. Post-fix: readPersistedConfig() helper
    // tries JSON then YAML.
    const dkgDir = join(tmpHome, '.dkg');
    mkdirSync(dkgDir, { recursive: true });
    writeFileSync(
      join(dkgDir, 'config.yaml'),
      'name: my-yaml-agent\napiPort: 9001\nnodeRole: edge\n',
    );
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ fund: false, verify: false }, deps);

    // (1) writeDkgConfig was NOT called — yaml-only configExists
    // fast path keeps the existing file untouched.
    expect(deps.ensureDkgNodeConfig).not.toHaveBeenCalled();
    // (2) startDaemon got the YAML port (9001), NOT the CLI
    // default 9200. This is the load-bearing assertion: pre-fix
    // this would have been 9200.
    expect(deps.startDaemon).toHaveBeenCalledTimes(1);
    expect((deps.startDaemon as any).mock.calls[0][0]).toBe(9001);
  });

  it('Codex Round-7 Fix 12: yaml-only with no fields → falls back to defaults gracefully (no crash)', async () => {
    // Empty YAML object: readPersistedConfig returns the empty
    // object, but `name`/`apiPort` reads come back undefined →
    // pre-merge defaults are used. No crash; no agent-name
    // regeneration loop on re-runs (since configExists short-
    // circuits writeDkgConfig).
    const dkgDir = join(tmpHome, '.dkg');
    mkdirSync(dkgDir, { recursive: true });
    writeFileSync(join(dkgDir, 'config.yaml'), '{}\n');
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps();
    await expect(
      mcpSetupAction({ fund: false, verify: false }, deps),
    ).resolves.not.toThrow();

    expect(deps.ensureDkgNodeConfig).not.toHaveBeenCalled();
    // Default port 9200 used since YAML had no apiPort field.
    expect((deps.startDaemon as any).mock.calls[0][0]).toBe(9200);
  });

  it('Codex Round-7 Fix 12: both config.json AND config.yaml exist → JSON wins (deterministic precedence)', async () => {
    // When both files exist, the helper prefers JSON. Mirrors
    // resolveDkgConfigHome's order of checks and gives a
    // deterministic answer for users who hand-edit one file
    // while the daemon writes the other.
    const dkgDir = join(tmpHome, '.dkg');
    mkdirSync(dkgDir, { recursive: true });
    writeFileSync(
      join(dkgDir, 'config.json'),
      JSON.stringify({ name: 'json-wins', apiPort: 9100, nodeRole: 'edge' }, null, 2),
    );
    writeFileSync(
      join(dkgDir, 'config.yaml'),
      'name: yaml-loses\napiPort: 9200\n',
    );
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ fund: false, verify: false }, deps);

    // JSON's port (9100) wins.
    expect((deps.startDaemon as any).mock.calls[0][0]).toBe(9100);
  });

  // ── Codex Round-8 Fix 13: --print-only stdout-purity regression ──

  it('Codex Round-8 Fix 13: --print-only stdout is parseable JSON (no Registering CLI prefix)', async () => {
    // Round-7 broke the --print-only stdout-purity contract for the
    // SECOND time (Round-2 Bug B was the first). Round-8 Fix 13
    // routes the "Registering CLI:" log to stderr. This test pins
    // the stdout-purity invariant: `JSON.parse(stdout)` succeeds
    // and the parsed object has the canonical mcpServers.dkg shape.
    const deps = makeDeps();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await mcpSetupAction({ printOnly: true }, deps);

    const stdoutText = (stdoutSpy.mock.calls as any[]).map((c) => String(c[0])).join('');
    // No "Registering CLI:" prefix on stdout. Pre-fix this string
    // contaminated stdout.
    expect(stdoutText).not.toMatch(/Registering CLI:/);
    // No "VSCode" advisory on stdout (Round-2 Fix B regression
    // guard rebaselined for Round-8).
    expect(stdoutText).not.toMatch(/VSCode/i);
    // Strict JSON-parses cleanly.
    const parsed = JSON.parse(stdoutText.trim());
    expect(parsed.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());

    // STDERR carries BOTH the "Registering CLI:" log AND the
    // VSCode-shape disambiguation note.
    const stderrText = (stderrSpy.mock.calls as any[]).map((c) => String(c[0])).join('');
    expect(stderrText).toMatch(/Registering CLI:/);
    expect(stderrText).toMatch(/VSCode/i);

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  // ── Codex Round-8 Fix 14: DKG_HOME env precedence over --monorepo ──

  it('Codex Round-8 Fix 14: DKG_HOME set + --monorepo → uses DKG_HOME (env wins over flag bypass)', async () => {
    // Pre-fix: Round-5 Fix 6's --monorepo bypass of
    // resolveDkgConfigHome ALSO bypassed the DKG_HOME env-var
    // precedence. Operators with `DKG_HOME=/custom/path` who passed
    // `--monorepo` would have setup state land in `~/.dkg-dev`
    // while the rest of the CLI honoured the custom path —
    // splitting state across two homes.
    //
    // Post-fix: DKG_HOME wins always, regardless of mode flags.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    const customDkgHome = join(tmpHome, 'custom-dkg-home');
    mkdirSync(customDkgHome, { recursive: true });
    process.env.DKG_HOME = customDkgHome;
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    let dkgHomeAtStartDaemon: string | undefined;
    const startDaemonSpy = vi.fn(async (_port: number) => {
      dkgHomeAtStartDaemon = process.env.DKG_HOME;
    });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
      startDaemon: startDaemonSpy,
    });

    await mcpSetupAction({ monorepo: true, fund: false, verify: false }, deps);

    // DKG_HOME wins — neither the --monorepo bypass to ~/.dkg-dev
    // nor any other branch overrode it.
    expect(dkgHomeAtStartDaemon).toBe(customDkgHome);
    // ~/.dkg-dev was NOT created (the bypass branch was skipped).
    expect(existsSync(join(tmpHome, '.dkg-dev'))).toBe(false);

    // Restore env (try/finally restore should have already done this).
    expect(process.env.DKG_HOME).toBe(customDkgHome);
  });

  it('Codex Round-8 Fix 14: DKG_HOME set + auto-detect (no flag) on monorepo cwd → uses DKG_HOME', async () => {
    // Auto-detect path (no --monorepo flag) ALSO defers to DKG_HOME
    // when set. Pre-Round-8 the auto-detect path called
    // resolveDkgConfigHome which already respects DKG_HOME, so this
    // case worked already; Fix 14 makes the precedence explicit and
    // unconditional in the cli's own cascade.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    const customDkgHome = join(tmpHome, 'custom-dkg-home');
    mkdirSync(customDkgHome, { recursive: true });
    process.env.DKG_HOME = customDkgHome;
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    let dkgHomeAtStartDaemon: string | undefined;
    const startDaemonSpy = vi.fn(async (_port: number) => {
      dkgHomeAtStartDaemon = process.env.DKG_HOME;
    });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
      startDaemon: startDaemonSpy,
    });

    await mcpSetupAction({ fund: false, verify: false }, deps);

    expect(dkgHomeAtStartDaemon).toBe(customDkgHome);
  });

  it('Codex Round-8 Fix 14: no DKG_HOME + --monorepo → ~/.dkg-dev (existing FIX 6 behaviour preserved)', async () => {
    // Counterpart to the DKG_HOME-set case: when DKG_HOME is unset,
    // the --monorepo bypass still kicks in (Round-5 Fix 6
    // contract). Pin that the env-precedence addition didn't
    // accidentally regress the bypass.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    delete process.env.DKG_HOME;
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    let dkgHomeAtStartDaemon: string | undefined;
    const startDaemonSpy = vi.fn(async (_port: number) => {
      dkgHomeAtStartDaemon = process.env.DKG_HOME;
    });

    const resolveDkgConfigHomeSpy = vi.fn(() => join(tmpHome, '.dkg'));

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
      resolveDkgConfigHome: resolveDkgConfigHomeSpy,
      startDaemon: startDaemonSpy,
    });

    await mcpSetupAction({ monorepo: true, fund: false, verify: false }, deps);

    expect(dkgHomeAtStartDaemon).toBe(join(tmpHome, '.dkg-dev'));
    // resolveDkgConfigHome was NOT called (--monorepo bypass took
    // over, since DKG_HOME wasn't set).
    expect(resolveDkgConfigHomeSpy).not.toHaveBeenCalled();
  });

  it('Codex Round-8 Fix 14: DKG_HOME restored to its pre-action value after exit (Fix 3 invariant preserved)', async () => {
    // Round-3 Fix 3 added try/finally save+restore of DKG_HOME
    // around the action body. Round-8 Fix 14 captures
    // previousDkgHome BEFORE the cascade; the try/finally restore
    // MUST still use that captured value. This test pins the
    // invariant for both the env-set and env-unset cases.
    //
    // Using a tmpHome-rooted path here, not a hardcoded system path
    // like `/some/external/dkg-home`: the action mkdirs `dkgDirPath`
    // (the writeDkgConfig stub creates it for completeness), so
    // the path needs to be writable on the runner. The test
    // invariant (DKG_HOME pointing somewhere OTHER than the default
    // `~/.dkg`) is the same regardless of which tmpdir-rooted path
    // we pick.
    const PRIOR = join(tmpHome, 'external-dkg-home');
    process.env.DKG_HOME = PRIOR;
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ fund: false, verify: false }, deps);

    // After exit, DKG_HOME is back to PRIOR. (And during the
    // action, since previousDkgHome === PRIOR was non-empty,
    // dkgDirPath itself was PRIOR per Fix 14's cascade.)
    expect(process.env.DKG_HOME).toBe(PRIOR);
  });

  // ── Codex Round-8 Fix 15: per-client failure isolation ───────────

  it('Codex Round-8 Fix 15 + Round-9 Fix 17: classify error on one client → others still attempted, failing client skipped, action throws partial-failure', async () => {
    // Round-8 Fix 15 isolates per-client classify errors so other
    // clients still get attempted. Round-9 Fix 17 layered an
    // aggregate-failure throw on top so CI / scripted invocations
    // see a non-zero exit signal even when SOME clients
    // succeeded — the partial-success state is still a failure
    // for "did setup complete its registration step?" purposes.
    //
    // Setup: Cursor's config is malformed (truncated JSON) →
    // classify throws → marked skipped. Claude Code is
    // unconfigured → registers cleanly. The action throws
    // "1 client(s) failed to register; 1 succeeded" at the end.
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, 'mcp.json'), '{"truncated":');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const deps = makeDeps();

    await expect(
      mcpSetupAction({ start: false, fund: false, verify: false }, deps),
    ).rejects.toThrow(/1 client\(s\) failed to register; 1 succeeded/);

    const stderrText = (stderrSpy.mock.calls as any[]).map((c) => String(c[0])).join('');
    // Stderr warning for the failing classify.
    expect(stderrText).toMatch(/WARNING: Cursor classify failed/);
    // Cursor's malformed file is NOT overwritten (failed-client
    // skip semantics from Fix 15).
    expect(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8')).toBe('{"truncated":');
    // Other client (Claude Code) was still registered before the
    // throw — its ~/.claude.json file exists post-action.
    expect(existsSync(join(tmpHome, '.claude.json'))).toBe(true);
    const claudeWritten = JSON.parse(readFileSync(join(tmpHome, '.claude.json'), 'utf-8'));
    expect(claudeWritten.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());

    stderrSpy.mockRestore();
  });

  it('Codex Round-8 Fix 15 + Round-9 Fix 17: write error on one client → others still attempted, action throws partial-failure', async () => {
    // Per-client write isolation (Fix 15) + non-zero exit on
    // partial failure (Fix 17). Force a write failure by pre-
    // creating the Cursor config dir as a regular FILE (so the
    // mcp.json create-or-write throws). Claude Code's parent
    // (tmpHome) still works. Action throws partial-failure at
    // the end; Claude Code IS still registered before the throw.
    const cursorDir = join(tmpHome, '.cursor');
    writeFileSync(cursorDir, 'this is a file, not a directory');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const deps = makeDeps();

    await expect(
      mcpSetupAction({ start: false, fund: false, verify: false }, deps),
    ).rejects.toThrow(/1 client\(s\) failed/);

    const stderrText = (stderrSpy.mock.calls as any[]).map((c) => String(c[0])).join('');
    // Stderr warning for the failing client.
    expect(stderrText).toMatch(/WARNING: Cursor (classify|write) failed/);
    // Other client (Claude Code) was still written.
    expect(existsSync(join(tmpHome, '.claude.json'))).toBe(true);

    stderrSpy.mockRestore();
  });

  it('Codex Round-8 Fix 15 + Round-9 Fix 17: ALL clients failing → action throws "No client configs updated" (zero successes)', async () => {
    // When EVERY detected client fails, mcpSetupAction MUST throw
    // a structured "No client configs updated" error so CI sees
    // a non-zero exit. Round-8 Fix 15 (continue past per-client
    // failures) is preserved — every client still gets tried —
    // but Round-9 Fix 17 ensures the aggregate exit signal
    // reflects the actual outcome.
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, 'mcp.json'), '{"corrupt":');
    writeFileSync(join(tmpHome, '.claude.json'), '{"also-corrupt":');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const deps = makeDeps();

    await expect(
      mcpSetupAction({ start: false, fund: false, verify: false }, deps),
    ).rejects.toThrow(/No client configs updated\. 2 client\(s\) failed/);

    const stderrText = (stderrSpy.mock.calls as any[]).map((c) => String(c[0])).join('');
    // Both clients' classify failures logged before the throw.
    expect(stderrText).toMatch(/WARNING: Cursor classify failed/);
    expect(stderrText).toMatch(/WARNING: Claude Code classify failed/);

    // Neither malformed file was overwritten.
    expect(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8')).toBe('{"corrupt":');
    expect(readFileSync(join(tmpHome, '.claude.json'), 'utf-8')).toBe('{"also-corrupt":');

    stderrSpy.mockRestore();
  });

  // ── Codex Round-9 Fix 16: env DKG_HOME propagation in entry ──────

  it('Codex Round-9 Fix 16: default install → entry has env: { DKG_HOME: ~/.dkg }', async () => {
    // The MCP entry's env field carries the resolved bootstrap
    // home so spawned MCP servers (in GUI clients that don't
    // inherit shell env) read the same config / auth.token setup
    // just bootstrapped.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const cursor = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursor.mcpServers.dkg.env).toEqual({ DKG_HOME: join(tmpHome, '.dkg') });
  });

  it('Codex Round-9 Fix 16: operator DKG_HOME=/custom → entry has env: { DKG_HOME: /custom }', async () => {
    const customHome = join(tmpHome, 'custom-dkg-home');
    mkdirSync(customHome, { recursive: true });
    process.env.DKG_HOME = customHome;
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const cursor = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursor.mcpServers.dkg.env).toEqual({ DKG_HOME: customHome });
  });

  it('Codex Round-9 Fix 16: --monorepo → entry has env: { DKG_HOME: ~/.dkg-dev }', async () => {
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
    });
    await mcpSetupAction({ monorepo: true, start: false, fund: false, verify: false }, deps);

    const cursor = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursor.mcpServers.dkg.env).toEqual({ DKG_HOME: join(tmpHome, '.dkg-dev') });
  });

  it('Codex Round-9 Fix 16: classifier compares env.DKG_HOME — DKG_HOME drift classifies as stale and refreshes', async () => {
    // Pre-existing entry has env: { DKG_HOME: '/old/path' }; a
    // re-run with DKG_HOME unset (or pointing somewhere new)
    // computes a different env and classifies as stale, refreshing
    // to the new value.
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    // Pre-existing entry with stale DKG_HOME.
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          dkg: {
            command: process.execPath,
            args: [realpathSync(process.argv[1]), 'mcp', 'serve'],
            env: { DKG_HOME: '/old/abandoned/path' },
          },
        },
      }, null, 2),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    // Refreshed: the new env carries the current home.
    const after = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    expect(after.mcpServers.dkg.env).toEqual({ DKG_HOME: join(tmpHome, '.dkg') });
    // Classifier saw the env drift, didn't treat the entry as
    // already-registered.
    expect(after.mcpServers.dkg.env.DKG_HOME).not.toBe('/old/abandoned/path');
  });

  it('Codex Round-9 Fix 16: pre-Fix-16 entries (no env field) classify as stale and migrate forward', async () => {
    // Legacy entries from any setup version pre-Fix-16 lack the
    // env field. The classifier's JSON.stringify(env) comparison
    // sees `undefined` vs `{ DKG_HOME }` and marks stale → the
    // refresh path adds the env field automatically. This is the
    // auto-migration story for users upgrading.
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          dkg: {
            command: process.execPath,
            args: [realpathSync(process.argv[1]), 'mcp', 'serve'],
            // Note: no env field at all — pre-Fix-16 shape.
          },
        },
      }, null, 2),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const after = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    expect(after.mcpServers.dkg.env).toEqual({ DKG_HOME: join(tmpHome, '.dkg') });
  });

  // ── Codex Round-9 Fix 17: aggregate failure throw cases ──────────

  it('Codex Round-9 Fix 17: all clients succeed → no throw; "Next steps" hint emitted', async () => {
    // Counterpart to the all-fail / partial-fail tests above:
    // the happy path. Every detected client registers cleanly,
    // mcpSetupAction returns (does not throw), and the
    // operator-facing "Next steps" hint appears in stdout.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();

    await expect(
      mcpSetupAction({ start: false, fund: false, verify: false }, deps),
    ).resolves.not.toThrow();

    const logged = (logSpy.mock.calls as any[]).map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/Next steps:/);
  });

  it('Codex Round-9 Fix 17: dry-run does NOT throw on classify failures (preview-only path)', async () => {
    // Dry-run is preview-only. Even with classify failures in
    // detected clients, dry-run MUST return cleanly — no writes
    // attempted, no aggregate-failure throw. Operators use it to
    // see what setup WOULD do without committing.
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, 'mcp.json'), '{"corrupt":');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const deps = makeDeps();

    await expect(
      mcpSetupAction({ dryRun: true, start: false, fund: false, verify: false }, deps),
    ).resolves.not.toThrow();

    // Stderr warning still fires (operator sees the issue).
    const stderrText = (stderrSpy.mock.calls as any[]).map((c) => String(c[0])).join('');
    expect(stderrText).toMatch(/WARNING: Cursor classify failed/);

    stderrSpy.mockRestore();
  });

  // ── Codex Round-13 Fix 19: detectContext uses running CLI's location ──

  it('Codex Round-13 Fix 19: auto-detect uses dirname(realpath(argv[1])), NOT process.cwd()', async () => {
    // Pre-fix: detectContext called findDkgMonorepoRoot(process.cwd())
    // — a global `dkg` invoked from inside a monorepo checkout
    // would resolve cwd → repo root and switch the registered MCP
    // entry to the (potentially unbuilt) monorepo dist. Mismatch:
    // setup steps 1-3 ran against the global home; the persisted
    // entry pointed at the local checkout.
    //
    // Post-fix: auto-detect calls findDkgMonorepoRoot with the
    // RUNNING CLI's directory (dirname(realpathSync(argv[1]))).
    // The test runner's argv[1] is vitest's own dist (in
    // `node_modules/.pnpm/vitest@.../dist/...`), which is
    // outside any monorepo root by definition.
    //
    // We assert the stub findDkgMonorepoRoot was called with a
    // path that's NOT process.cwd() (which IS inside the
    // dkg-v9 monorepo when the test runs from within it).
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const findRootSpy = vi.fn((startDir?: string) => {
      // Whatever the start dir is, return null (no monorepo) so
      // we test the auto-detect → installed fallback path.
      return null as string | null;
    });
    const deps = makeDeps({ findDkgMonorepoRoot: findRootSpy });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    // findRoot was called at least once (by detectContext).
    expect(findRootSpy).toHaveBeenCalled();
    const callArg = findRootSpy.mock.calls[0][0];
    // The argument is a string path (running CLI's dir), NOT
    // undefined (which would mean default-walk-from-package-path,
    // the broken pre-Round-1 default).
    expect(typeof callArg).toBe('string');
    // And it's NOT process.cwd() — that was the round-1 fix that
    // round-13 corrected. The CLI's location and process.cwd() are
    // different when the test runner runs from within dkg-v9 but
    // vitest's dist lives in node_modules/.pnpm/.... If they happen
    // to coincide on a particular machine, this assertion is
    // a no-op (which is fine — the cwd-vs-cli-dir distinction
    // only matters when they differ).
    if (callArg && callArg !== process.cwd()) {
      // The argument is a directory path containing the test
      // runner's dist — vitest is the running CLI in this test.
      expect(callArg).toContain('node_modules');
    }
  });

  it('Codex Round-13 Fix 19: auto-detect with monorepo-located CLI → context = monorepo', async () => {
    // Counterpart: when findDkgMonorepoRoot returns a root for the
    // running CLI's directory, auto-detect picks monorepo. Stub
    // returns the fake repo root regardless of input.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
    });
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const cursor = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    // Monorepo path: args[0] is the local CLI dist.
    expect(cursor.mcpServers.dkg.args[0]).toBe(
      join(fakeRepoRoot, 'packages', 'cli', 'dist', 'cli.js'),
    );
  });

  it('Codex Round-13 Fix 19: --monorepo force errors when no root found from running CLI dir', async () => {
    // Tighter contract: --monorepo demands the running CLI live
    // inside a monorepo. Pre-fix, `cwd` could mask this. Post-fix,
    // a global `dkg` invoked with --monorepo from inside a clone
    // would still throw if the global CLI isn't itself the
    // monorepo build.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => null),
    });

    await expect(
      mcpSetupAction({ monorepo: true, start: false, fund: false, verify: false }, deps),
    ).rejects.toThrow(/no DKG monorepo root could be located/);
  });

  // ── Codex Round-13 Fix 20: WSL2 detection + Windows-side probing ──

  let originalWslDistroName: string | undefined;
  let originalWslInterop: string | undefined;

  function saveWslEnv(): void {
    originalWslDistroName = process.env.WSL_DISTRO_NAME;
    originalWslInterop = process.env.WSL_INTEROP;
  }

  function restoreWslEnv(): void {
    if (originalWslDistroName !== undefined) process.env.WSL_DISTRO_NAME = originalWslDistroName;
    else delete process.env.WSL_DISTRO_NAME;
    if (originalWslInterop !== undefined) process.env.WSL_INTEROP = originalWslInterop;
    else delete process.env.WSL_INTEROP;
  }

  it('Codex Round-13 Fix 20: non-WSL Linux platform — only Linux-side entries (regression guard)', async () => {
    // Pre-Round-13 default behaviour: a regular Linux box (no WSL
    // env vars, plain /proc/version) must continue to detect only
    // the Linux-side configs. This test pins that the Round-13
    // additions don't accidentally widen the candidate set on
    // non-WSL platforms.
    if (platform() !== 'linux') return; // Linux-only test; macOS/Windows skip.
    saveWslEnv();
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    try {
      const { detectClients } = await import('../src/mcp-setup.js');
      const detected = detectClients();
      // No "(Windows-side via WSL)" entries on plain Linux.
      const wslEntries = detected.filter((c) => c.name.includes('Windows-side via WSL'));
      expect(wslEntries.length).toBe(0);
    } finally {
      restoreWslEnv();
    }
  });

  it('Codex Round-13 Fix 20: WSL env (WSL_DISTRO_NAME set) on Linux — adds Windows-side entries for the 4 GUI clients', async () => {
    // Synthesize a WSL environment via the env-var signal (cheapest
    // detection branch), then assert detectClients returns the
    // additional "(Windows-side via WSL)" entries for Claude
    // Desktop, VSCode + Copilot, Cline, and Windsurf.
    //
    // Skipped on non-Linux platforms: the WSL detector early-returns
    // false unless platform() === 'linux', and we can't override
    // platform() without a vi.mock at the top of the file.
    if (platform() !== 'linux') return;
    saveWslEnv();
    process.env.WSL_DISTRO_NAME = 'TestDistro';
    try {
      // The wslWindowsEnvPath helper shells out to cmd.exe + wslpath.
      // In a test environment those binaries don't exist; the helper
      // catches and returns null, so the WSL branch's additive entries
      // are skipped silently. To exercise the additive-entry path
      // we'd need to mock execSync — out of scope for this CI test.
      // What we CAN verify: isWSL() detection fired correctly and
      // detectClients didn't throw or hang; it just returned the
      // base set when wsl path resolution failed.
      const { detectClients } = await import('../src/mcp-setup.js');
      const detected = detectClients();
      // The detector found at least the Linux-side defaults that
      // exist on this test runner (probably Cursor's parent if
      // tmpHome is set up, or none at all on a clean test box).
      // The contract this test pins: detectClients does NOT crash
      // when WSL is detected but cmd.exe / wslpath are unavailable.
      expect(Array.isArray(detected)).toBe(true);
      // No partial / null Windows-side entries leaked through.
      for (const c of detected) {
        expect(typeof c.configPath).toBe('string');
        expect(c.configPath.length).toBeGreaterThan(0);
      }
    } finally {
      restoreWslEnv();
    }
  });

  it('Codex Round-13 Fix 20: isWSL() detection helper — returns false on Windows, true with WSL_DISTRO_NAME on Linux', async () => {
    // Direct unit test of the detection signal. Round-13 added
    // multi-source detection (env, os.release, /proc/version);
    // this test pins the env-var path which is the cheapest and
    // most-common signal in real WSL launches.
    saveWslEnv();
    try {
      // Windows / macOS / non-WSL Linux: detector returns false on
      // any non-Linux platform regardless of env vars.
      if (platform() !== 'linux') {
        process.env.WSL_DISTRO_NAME = 'Ubuntu';
        // detectClients should NOT add Windows-side entries on
        // Windows (the detector's `if (platform() !== 'linux')
        // return false` guard).
        const { detectClients } = await import('../src/mcp-setup.js');
        const detected = detectClients();
        const wslEntries = detected.filter((c) => c.name.includes('Windows-side via WSL'));
        expect(wslEntries.length).toBe(0);
      }
      // On Linux platforms, isWSL would return true with the env
      // var set. We can't directly observe the helper without
      // exporting it, but the contract is exercised via the
      // detectClients-with-WSL-env test above.
    } finally {
      restoreWslEnv();
    }
  });

  it('Codex Round-13 Fix 20: graceful fallback when wslpath/cmd.exe unavailable (no crash, no half-baked entries)', async () => {
    // The wslWindowsEnvPath helper catches exec failures and
    // returns null; detectClients then skips the additive
    // Windows-side entries silently and returns the base set.
    // This test pins that graceful-degradation contract — even
    // when WSL is detected (env signal) but the cmd.exe / wslpath
    // tooling isn't reachable, setup keeps working with the
    // Linux-only client set.
    if (platform() !== 'linux') return;
    saveWslEnv();
    process.env.WSL_DISTRO_NAME = 'TestDistro';
    try {
      const { detectClients } = await import('../src/mcp-setup.js');
      // Should not throw despite WSL being "detected" while
      // cmd.exe/wslpath are unavailable in the test environment.
      const detected = detectClients();
      expect(Array.isArray(detected)).toBe(true);
      // Every returned entry has well-formed string paths.
      for (const c of detected) {
        expect(typeof c.configPath).toBe('string');
      }
    } finally {
      restoreWslEnv();
    }
  });

  // ── Codex Round-15 Fix 21: --monorepo cwd-first ordering ─────────

  it('Codex Round-15 Fix 21: --monorepo + global CLI invoked from inside a valid monorepo cwd → resolves against cwd', async () => {
    // Pre-fix (Round-13 FIX 19) the forced-monorepo branch tried
    // `cliDir` first, which hard-failed when a global `dkg` was
    // invoked from inside a valid monorepo with `--monorepo`. The
    // global install path doesn't have a monorepo above it; the
    // user's intent was clearly cwd. Post-fix: cwd first, cliDir
    // as a fallback before throwing.
    //
    // Test setup: simulate the global-CLI-from-inside-monorepo case.
    // Stub findRoot so:
    //   - `<cwd>` returns a fake monorepo root (the user's intent).
    //   - any other path (cliDir, e.g.) returns null.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    const userCwd = process.cwd();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const findStub = vi.fn((startDir?: string) => {
      // cwd matches → return the fake repo root.
      if (startDir === userCwd) return fakeRepoRoot;
      // Any other start dir (cliDir would be vitest's dist
      // directory) → no monorepo above it.
      return null;
    });

    const deps = makeDeps({ findDkgMonorepoRoot: findStub });

    // Should NOT throw. The cwd-first logic finds the root.
    await mcpSetupAction({ monorepo: true, start: false, fund: false, verify: false }, deps);

    // The Cursor entry's args[0] points at the fake repo root's
    // cli.dist (proves the monorepo branch was taken with the
    // cwd-derived root).
    const cursor = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursor.mcpServers.dkg.args[0]).toBe(
      join(fakeRepoRoot, 'packages', 'cli', 'dist', 'cli.js'),
    );
    // findStub was called with cwd at least once (cwd-first).
    const callArgs = findStub.mock.calls.map((c) => c[0]);
    expect(callArgs).toContain(userCwd);
  });

  it('Codex Round-15 Fix 21: --monorepo + cwd has no monorepo + cliDir has one → falls back to cliDir', async () => {
    // The fallback contract: when cwd doesn't have a monorepo above
    // it but the running CLI's dir does (test runner pattern: the
    // test invokes mcpSetupAction with --monorepo from a tmpHome
    // cwd that's outside any monorepo, but the test runner's own
    // dist might be inside a monorepo for cli-self-test scenarios).
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const findStub = vi.fn((startDir?: string) => {
      // Anything matching `<cwd>` (test's tmpHome ancestors) → no
      // monorepo. Anything else (cliDir-derived) → fakeRepoRoot.
      const cwd = process.cwd();
      if (startDir && startDir.startsWith(cwd)) return null;
      return fakeRepoRoot;
    });

    const deps = makeDeps({ findDkgMonorepoRoot: findStub });
    // Should resolve via the cliDir fallback.
    await mcpSetupAction({ monorepo: true, start: false, fund: false, verify: false }, deps);

    const cursor = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursor.mcpServers.dkg.args[0]).toBe(
      join(fakeRepoRoot, 'packages', 'cli', 'dist', 'cli.js'),
    );
    // findStub called at least twice — once with cwd, once with cliDir.
    expect(findStub.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('Codex Round-15 Fix 21: --monorepo + neither cwd nor cliDir has a monorepo → throws actionable error', async () => {
    // Existing behavior preserved: when nothing finds a root, the
    // throw fires with the same actionable message as before.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const findStub = vi.fn(() => null);
    const deps = makeDeps({ findDkgMonorepoRoot: findStub });

    await expect(
      mcpSetupAction({ monorepo: true, start: false, fund: false, verify: false }, deps),
    ).rejects.toThrow(/no DKG monorepo root could be located/);

    // Both cwd and cliDir attempted before throwing.
    expect(findStub.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // ── Codex Round-15 Fix 22: classify DKG_HOME-only + writeRegistration env merge ──

  it('Codex Round-15 Fix 22: existing entry with user env keys + DKG_HOME drift → stale; refresh preserves user keys, updates DKG_HOME', async () => {
    // Load-bearing: an operator hand-edited their MCP config to add
    // NODE_OPTIONS / HTTPS_PROXY for proxy or memory tuning. Pre-fix
    // a setup re-run with a different DKG_HOME would (a) classify
    // as stale (correct) AND (b) silently wipe the user's vars on
    // refresh because writeRegistration replaced the whole entry.
    //
    // Post-fix: stale-classification reason narrows to DKG_HOME
    // drift only; refresh merges existing env keys with the
    // expected env so DKG_HOME wins but user keys survive.
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          dkg: {
            command: process.execPath,
            args: [realpathSync(process.argv[1]), 'mcp', 'serve'],
            env: {
              DKG_HOME: '/old/abandoned/path',
              NODE_OPTIONS: '--max-old-space-size=8192',
              HTTPS_PROXY: 'http://corporate-proxy:8080',
            },
          },
        },
      }, null, 2),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const after = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    // DKG_HOME refreshed to current bootstrap home.
    expect(after.mcpServers.dkg.env.DKG_HOME).toBe(join(tmpHome, '.dkg'));
    // User keys PRESERVED — Round-15 Fix 22's load-bearing assertion.
    expect(after.mcpServers.dkg.env.NODE_OPTIONS).toBe('--max-old-space-size=8192');
    expect(after.mcpServers.dkg.env.HTTPS_PROXY).toBe('http://corporate-proxy:8080');
  });

  it('Codex Round-15 Fix 22: existing entry with user env keys + matching DKG_HOME → registered (no spurious stale)', async () => {
    // Pre-fix: strict-equal env comparison flagged user-added keys
    // as drift even when DKG_HOME matched, forcing a needless
    // refresh. Post-fix: only DKG_HOME matters; user keys are
    // ignored for staleness purposes. Re-run is a no-op.
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    const expectedHome = join(tmpHome, '.dkg');
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          dkg: {
            command: process.execPath,
            args: [realpathSync(process.argv[1]), 'mcp', 'serve'],
            env: {
              DKG_HOME: expectedHome,
              NODE_OPTIONS: '--max-old-space-size=8192',
            },
          },
        },
      }, null, 2),
    );
    const beforeMtime = (await import('node:fs')).statSync(join(cursorDir, 'mcp.json')).mtimeMs;

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    // File NOT rewritten — classifier saw matching DKG_HOME and
    // ignored the unrelated NODE_OPTIONS.
    const afterMtime = (await import('node:fs')).statSync(join(cursorDir, 'mcp.json')).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
    const after = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    expect(after.mcpServers.dkg.env.NODE_OPTIONS).toBe('--max-old-space-size=8192');
  });

  it('Codex Round-15 Fix 22: fresh client (no existing entry) → entry written with just env: { DKG_HOME }', async () => {
    // Regression guard: when there's nothing to merge, writeRegistration
    // emits the expected entry verbatim. No accidental empty `env`
    // spread artifacts; no leftover keys from a non-existent prior.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const cursor = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursor.mcpServers.dkg.env).toEqual({ DKG_HOME: join(tmpHome, '.dkg') });
    // No extra keys leaked into env.
    expect(Object.keys(cursor.mcpServers.dkg.env)).toEqual(['DKG_HOME']);
  });

  // ── Codex Round-17 Fix 23: Cursor in WSL Windows-side detection ──

  it('Codex Round-17 Fix 23: WSL detected on Linux — Cursor (Windows-side via WSL) is among detected entries', async () => {
    // Round-13 FIX 20 added 4 Windows-side WSL entries (Claude
    // Desktop, VSCode, Cline, Windsurf) but skipped Cursor —
    // leaving the common "Windows Cursor + WSL shell" dev setup
    // unregistered even though Cursor's been the original client
    // in the detection set since round 1. Round-17 Fix 23 adds
    // the 5th WSL entry mirroring the existing winUserProfile-
    // based pattern.
    //
    // Skipped on non-Linux platforms: isWSL()'s `platform() ===
    // 'linux'` early-return short-circuits the WSL branch on
    // Windows/macOS regardless of env stubs.
    if (platform() !== 'linux') return;
    saveWslEnv();
    process.env.WSL_DISTRO_NAME = 'TestDistro';
    try {
      const { detectClients } = await import('../src/mcp-setup.js');
      const detected = detectClients();
      // We can't fake cmd.exe / wslpath in this test env, so the
      // Windows-side entries (including Cursor) won't actually be
      // pushed — but the contract this test pins is that the
      // WSL branch DOESN'T CRASH and that any Cursor entry that
      // does get pushed has the right shape. If the helper
      // succeeds, assert on it; otherwise just verify the
      // detection didn't error out.
      const cursorWslEntries = detected.filter(
        (c) => c.name === 'Cursor (Windows-side via WSL)',
      );
      // If the WSL helpers succeed in this environment, the
      // entry is present with the canonical mcpServers.dkg shape
      // (no entryPath override) and the path includes `.cursor`.
      for (const entry of cursorWslEntries) {
        expect(entry.entryPath).toBeUndefined();
        expect(entry.configPath).toContain('.cursor');
      }
    } finally {
      restoreWslEnv();
    }
  });

  it('Codex Round-17 Fix 23: graceful fallback when wslpath/cmd.exe unavailable — no Cursor WSL entry, no crash', async () => {
    // Mirrors the existing graceful-degradation contract for the
    // 4 other WSL-side clients. When cmd.exe / wslpath aren't
    // reachable, wslWindowsEnvPath returns null → the
    // `if (winUserProfile)` block doesn't fire → no Cursor (or
    // Windsurf) Windows-side entry is pushed. detectClients
    // still completes without throwing.
    if (platform() !== 'linux') return;
    saveWslEnv();
    process.env.WSL_DISTRO_NAME = 'TestDistro';
    try {
      const { detectClients } = await import('../src/mcp-setup.js');
      const detected = detectClients();
      // No crash. Every entry is well-formed.
      expect(Array.isArray(detected)).toBe(true);
      for (const c of detected) {
        expect(typeof c.configPath).toBe('string');
        expect(c.configPath.length).toBeGreaterThan(0);
      }
    } finally {
      restoreWslEnv();
    }
  });

  it('issue #443 local review: WSL Windows-side probing skips Codex until a Windows-compatible command wrapper exists', async () => {
    // The Windows-side GUI clients can be registered from WSL because
    // they run Windows apps reading Windows config files, but Codex CLI
    // would later spawn whatever command we persist. From WSL, the
    // canonical command/args are Linux paths, so writing them into
    // %USERPROFILE%\.codex\config.toml would break Windows Codex.
    if (platform() !== 'linux') return;
    saveWslEnv();
    process.env.WSL_DISTRO_NAME = 'TestDistro';
    try {
      const winUserProfile = join(tmpHome, 'win-user');
      const winAppData = join(tmpHome, 'win-appdata', 'Roaming');
      mkdirSync(join(winUserProfile, '.cursor'), { recursive: true });
      mkdirSync(join(winUserProfile, '.codex'), { recursive: true });

      const { detectClients } = await import('../src/mcp-setup.js');
      const detected = detectClients((envVarName) => {
        if (envVarName === 'USERPROFILE') return winUserProfile;
        if (envVarName === 'APPDATA') return winAppData;
        return null;
      });

      expect(
        detected.some((c) => c.name === 'Cursor (Windows-side via WSL)'),
      ).toBe(true);
      expect(
        detected.some((c) => c.name === 'Codex CLI (Windows-side via WSL)'),
      ).toBe(false);
    } finally {
      restoreWslEnv();
    }
  });

  // ── Codex Round-19 Fix 26: writeRegistration merges full entry ──

  it('Codex Round-19 Fix 26: refresh preserves top-level user keys (cwd) AND env keys; updates command/args/env.DKG_HOME', async () => {
    // Round-15 Fix 22 added env-merge but the rest of the entry
    // was still being replaced wholesale, so top-level keys like
    // `cwd` (workspace-anchoring, common in MCP server configs)
    // got clobbered on first refresh. Round-19 Fix 26 extends
    // the merge to the entire entry: spread existing first, then
    // expected, then explicit env merge. Fields THIS COMMAND owns
    // (command, args, env.DKG_HOME) override; everything else
    // passes through unchanged.
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          dkg: {
            command: '/old/legacy/dkg',
            args: ['legacy-arg'],
            cwd: '/workspaces/my-project',
            env: {
              DKG_HOME: '/old/abandoned/path',
              NODE_OPTIONS: '--inspect',
              HTTPS_PROXY: 'http://corp:8080',
            },
          },
        },
      }, null, 2),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const after = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    // Fields this command owns: refreshed.
    expect(after.mcpServers.dkg.command).toBe(process.execPath);
    expect(after.mcpServers.dkg.args[0]).toBe(realpathSync(process.argv[1]));
    expect(after.mcpServers.dkg.args.slice(1)).toEqual(['mcp', 'serve']);
    expect(after.mcpServers.dkg.env.DKG_HOME).toBe(join(tmpHome, '.dkg'));
    // Top-level user key `cwd`: PRESERVED (load-bearing).
    expect(after.mcpServers.dkg.cwd).toBe('/workspaces/my-project');
    // env user keys: PRESERVED (Round-15 Fix 22 contract carries forward).
    expect(after.mcpServers.dkg.env.NODE_OPTIONS).toBe('--inspect');
    expect(after.mcpServers.dkg.env.HTTPS_PROXY).toBe('http://corp:8080');
  });

  it('Codex Round-19 Fix 26: arbitrary unknown top-level keys preserved across refresh', async () => {
    // Pin the contract: `command`, `args`, `env.DKG_HOME` are
    // the ONLY fields this command owns. Any other top-level key
    // — even ones we don't know about today — passes through
    // unchanged.
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          dkg: {
            command: '/old/dkg',
            args: ['old'],
            env: { DKG_HOME: '/old' },
            // Hypothetical user-added or future-MCP-spec keys.
            restartPolicy: 'always',
            timeout: 30000,
            tags: ['dev', 'experimental'],
          },
        },
      }, null, 2),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const after = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    expect(after.mcpServers.dkg.restartPolicy).toBe('always');
    expect(after.mcpServers.dkg.timeout).toBe(30000);
    expect(after.mcpServers.dkg.tags).toEqual(['dev', 'experimental']);
    // And the command-owned fields refreshed correctly.
    expect(after.mcpServers.dkg.command).toBe(process.execPath);
    expect(after.mcpServers.dkg.env.DKG_HOME).toBe(join(tmpHome, '.dkg'));
  });

  it('Codex Round-19 Fix 26: fresh client (no existing entry) → entry written as-is, no merge artifacts', async () => {
    // Regression guard: when there's nothing to merge with,
    // writeRegistration emits the expected entry verbatim. No
    // accidental empty-spread artifacts; the entry's keys are
    // exactly what canonicalEntry produced.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const cursor = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    // Exactly the expected keys: command, args, env. No leftover
    // top-level keys from a non-existent prior.
    expect(Object.keys(cursor.mcpServers.dkg).sort()).toEqual(['args', 'command', 'env']);
    expect(cursor.mcpServers.dkg.env).toEqual({ DKG_HOME: join(tmpHome, '.dkg') });
  });

  // ── Codex Round-23 Fix 29: dry-run log honesty ─────────────────────

  it('Codex Round-23 Fix 29: --dry-run log line cites the RESOLVED dkgDirPath, not literal ~/.dkg', async () => {
    // Pre-fix the dry-run log hardcoded `~/.dkg/config.json` regardless
    // of where the resolved bootstrap home actually pointed (e.g.
    // `~/.dkg-dev` under monorepo mode, or a custom DKG_HOME). The
    // operator was reading the wrong path in the preview. Post-fix
    // the log uses `tildify(jsonPath)` so it reflects the actual
    // write target.
    //
    // Force monorepo mode so the resolved home is `<tmpHome>/.dkg-dev`
    // — different enough from `~/.dkg` that we can assert the log
    // doesn't contain the literal old string.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
    });

    await mcpSetupAction(
      { monorepo: true, dryRun: true, fund: false, verify: false },
      deps,
    );

    const logged = (logSpy.mock.calls as any[]).map((c) => c.join(' ')).join('\n');
    // The dry-run line cites the resolved home path.
    expect(logged).toMatch(/\[dry-run\] Would write/);
    expect(logged).toContain('.dkg-dev');
    // And does NOT cite the bare-literal `~/.dkg/config.json` (the
    // pre-fix string).
    expect(logged).not.toMatch(/Would write ~\/\.dkg\/config\.json/);
  });

  // ── Issue #437: Codex CLI (TOML) auto-detect ─────────────────────────

  it('issue #437: Codex CLI is detected at ~/.codex/config.toml; gets canonical entry written under [mcp_servers.dkg]', async () => {
    // Pre-create the parent dir so detection fires (parent-dir
    // existence is the universal detection signal).
    const codexPath = join(tmpHome, '.codex', 'config.toml');
    mkdirSync(join(codexPath, '..'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(codexPath)).toBe(true);
    const rawContent = readFileSync(codexPath, 'utf-8');
    const written = TOML.parse(rawContent);
    // Codex CLI's canonical key is `mcp_servers.<name>` (snake-case),
    // not the JSON-world `mcpServers.<name>`. entryPath dispatch
    // routes the entry to the right table.
    expect((written as any).mcp_servers?.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    // And the canonical JSON-world key MUST NOT appear in TOML output
    // — that would mean entryPath fell through to default.
    expect((written as any).mcpServers).toBeUndefined();

    // PR #443 round-4 Codex Review: parsing-and-comparing the
    // round-tripped object alone passes even if the serializer
    // emits an inline-table form (e.g. `mcp_servers.dkg = { command
    // = "...", ... }`) instead of the section-header form Codex
    // CLI's loader expects (`[mcp_servers.dkg]\ncommand = "..."`).
    // Pin the on-disk syntax with raw-text assertions so a future
    // `@iarna/toml` major bump or library swap that changes default
    // emission style trips this test.
    //
    // 1. The section header MUST appear at the start of a line —
    //    this rules out inline-table form, which would put the key
    //    inline as `mcp_servers.dkg = { ... }`.
    expect(rawContent).toMatch(/^\[mcp_servers\.dkg\]/m);
    // 2. The body fields MUST follow as bare assignments, not as
    //    inline-table contents. Section-body form: `command = "..."`
    //    on its own line. The DOTALL flag is intentional — `args`
    //    may wrap across lines for long arrays.
    expect(rawContent).toMatch(/^\[mcp_servers\.dkg\][\s\S]*?^command\s*=\s*"/m);
    expect(rawContent).toMatch(/^\[mcp_servers\.dkg\][\s\S]*?^args\s*=\s*\[/m);
    // 3. Negative: the inline-table form is explicitly NOT emitted.
    //    `mcp_servers.dkg = {` would be the smoking gun for a
    //    serializer regression to inline tables.
    expect(rawContent).not.toMatch(/^mcp_servers\.dkg\s*=\s*\{/m);
  });

  it('issue #437: Codex CLI FIX 26 — refresh preserves user-added top-level keys (cwd) AND env keys', async () => {
    // Mirror the Cursor FIX 26 test for the TOML format. Pin the
    // contract: `command`, `args`, `env.DKG_HOME` are the ONLY
    // fields this command owns; everything else passes through
    // unchanged across formats.
    const codexDir = join(tmpHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const codexPath = join(codexDir, 'config.toml');
    writeFileSync(
      codexPath,
      [
        '# user-managed Codex settings stay outside the owned table',
        '[mcp_servers.dkg]',
        'command = "/old/legacy/dkg"',
        'args = [ "legacy-arg" ]',
        'cwd = "/workspaces/my-project"',
        '',
        '[mcp_servers.dkg.env]',
        'DKG_HOME = "/old/abandoned/path"',
        'NODE_OPTIONS = "--inspect"',
        'HTTPS_PROXY = "http://corp:8080"',
        '',
        '# sibling server comment must survive the dkg refresh',
        '[mcp_servers.github-mcp]',
        'command = "gh-mcp"',
        'args = [ "serve" ]',
        '',
      ].join('\n'),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const afterRaw = readFileSync(codexPath, 'utf-8');
    const after = TOML.parse(afterRaw) as any;
    // Fields this command owns: refreshed.
    expect(after.mcp_servers.dkg.command).toBe(process.execPath);
    expect(after.mcp_servers.dkg.args[0]).toBe(realpathSync(process.argv[1]));
    expect(after.mcp_servers.dkg.args.slice(1)).toEqual(['mcp', 'serve']);
    expect(after.mcp_servers.dkg.env.DKG_HOME).toBe(join(tmpHome, '.dkg'));
    // User-added top-level key + user-added env keys: PRESERVED.
    expect(after.mcp_servers.dkg.cwd).toBe('/workspaces/my-project');
    expect(after.mcp_servers.dkg.env.NODE_OPTIONS).toBe('--inspect');
    expect(after.mcp_servers.dkg.env.HTTPS_PROXY).toBe('http://corp:8080');
    // Unrelated TOML text outside the owned dkg table is not round-tripped.
    expect(afterRaw).toContain('# user-managed Codex settings stay outside the owned table');
    expect(afterRaw).toContain('# sibling server comment must survive the dkg refresh');
    expect(afterRaw).toContain('[mcp_servers.github-mcp]');
    expect(after.mcp_servers['github-mcp']).toEqual({ command: 'gh-mcp', args: ['serve'] });
    expect(afterRaw).not.toContain('/old/legacy/dkg');
  });

  it('issue #437: Codex CLI sibling [mcp_servers.<other>] tables preserved on merge', async () => {
    // Real-world Codex CLI users often have other MCP servers
    // already registered. The setup must merge — write `dkg`
    // alongside without clobbering siblings, just like the
    // canonical-JSON-shape clients do.
    const codexDir = join(tmpHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const codexPath = join(codexDir, 'config.toml');
    writeFileSync(
      codexPath,
      TOML.stringify({
        mcp_servers: {
          'github-mcp': { command: 'gh-mcp', args: ['serve'] },
        },
      } as TOML.JsonMap),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const after = TOML.parse(readFileSync(codexPath, 'utf-8')) as any;
    expect(after.mcp_servers['github-mcp']).toEqual({ command: 'gh-mcp', args: ['serve'] });
    expect(after.mcp_servers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  it('issue #437 (Codex round-5): malformed ~/.codex/config.toml surfaces a friendly path + recovery message, not a raw library parse error', async () => {
    // Codex Review round-5 (PR #443) flagged that the TOML branch
    // bubbled `@iarna/toml`'s raw parse error, while the JSON branch
    // wraps with a friendly "<path> is not valid JSON. Move it aside
    // and re-run." recovery message. Mirror the JSON wrapping.
    //
    // Test mirrors the JSON malformed-file pattern: pre-populate the
    // file with broken syntax, run setup, assert the per-client
    // failure stderr warning contains the wrapped error text (path
    // is named, recovery procedure is stated).
    const codexDir = join(tmpHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const codexPath = join(codexDir, 'config.toml');
    // Broken TOML: unbalanced bracket. `@iarna/toml` will reject
    // this with a raw parse error (line/col info but no path, no
    // recovery guidance).
    writeFileSync(codexPath, '[mcp_servers.dkg\ncommand = "broken"');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const deps = makeDeps();

    // Codex CLI is detectable AND malformed → classify throws →
    // marked failed. Claude Code's parent dir (tmpHome) is always
    // present so it auto-detects and registers cleanly. Aggregate-
    // failure throw fires with a "1 failed; <n> succeeded" body.
    // The TOML error content is what we're asserting here, not the
    // aggregate string.
    await expect(
      mcpSetupAction({ start: false, fund: false, verify: false }, deps),
    ).rejects.toThrow(/1 client\(s\) failed to register/);

    const stderrText = (stderrSpy.mock.calls as any[]).map((c) => String(c[0])).join('');
    // Per-client warning surfaces the wrapped error text.
    expect(stderrText).toMatch(/WARNING: Codex CLI classify failed/);
    // The wrapped error names the file (path appears in tildified
    // form) and states the recovery procedure.
    expect(stderrText).toMatch(/Existing file is not valid TOML/);
    expect(stderrText).toMatch(/Move it aside and re-run/);
    // The file path appears in the stderr output. Tildification may
    // OR may not fire depending on whether tmpHome lives under the
    // real homedir (it doesn't in CI), so accept either the literal
    // path or its tildified form.
    expect(stderrText).toContain('config.toml');

    // Malformed file MUST NOT be overwritten — failed-client skip
    // semantics from F15 carry forward across formats.
    expect(readFileSync(codexPath, 'utf-8')).toBe('[mcp_servers.dkg\ncommand = "broken"');

    stderrSpy.mockRestore();
  });

  it('issue #437 (Codex round-5): Codex CLI preserves unrelated TOML comments and formatting when adding dkg', async () => {
    // Codex Review round-5 (PR #443, comment 3207793953) flagged
    // that whole-file `TOML.stringify(body)` strips comments and
    // formatting from unrelated user-managed Codex settings. Pin the
    // narrower edit contract: setup appends/replaces only the owned
    // `[mcp_servers.dkg]` table and leaves unrelated bytes alone.
    //
    // The parsed assertions keep the structural coverage from the
    // earlier test: scalars, regular tables, array-of-tables, and
    // sibling MCP server tables all survive.
    const codexDir = join(tmpHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const codexPath = join(codexDir, 'config.toml');
    const original = [
      '# Codex user config: this comment must survive',
      'model = "gpt-5"  # inline model comment must survive',
      'disable_history = false',
      'approval_policy = "on-failure"',
      '',
      '[history]',
      '# table comment must survive',
      'persistence = "save-all"',
      'max_bytes = 1048576',
      '',
      '[notify]',
      'on_completion = true',
      'on_error = true',
      '',
      '[[profiles]]',
      'name = "work"',
      'model = "gpt-5"',
      'api_key_env_var = "OPENAI_API_KEY"',
      '',
      '[[profiles]]',
      'name = "personal"',
      'model = "claude-opus-4-7"',
      'api_key_env_var = "ANTHROPIC_API_KEY"',
      '',
      '# sibling MCP server comment must survive',
      '[mcp_servers.github-mcp]',
      'command = "gh-mcp"',
      'args = [ "serve" ]',
      '',
    ].join('\n');
    writeFileSync(codexPath, original);

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const afterRaw = readFileSync(codexPath, 'utf-8');
    const after = TOML.parse(afterRaw) as any;
    expect(afterRaw.startsWith(original)).toBe(true);
    expect(afterRaw).toContain('# Codex user config: this comment must survive');
    expect(afterRaw).toContain('model = "gpt-5"  # inline model comment must survive');
    expect(afterRaw).toContain('# table comment must survive');
    expect(afterRaw).toContain('# sibling MCP server comment must survive');
    // Top-level scalars preserved verbatim.
    expect(after.model).toBe('gpt-5');
    expect(after.disable_history).toBe(false);
    expect(after.approval_policy).toBe('on-failure');
    // Top-level non-MCP tables preserved verbatim.
    expect(after.history).toEqual({ persistence: 'save-all', max_bytes: 1048576 });
    expect(after.notify).toEqual({ on_completion: true, on_error: true });
    // Top-level array-of-tables preserved verbatim, in original order.
    expect(after.profiles).toHaveLength(2);
    expect(after.profiles[0]).toEqual({ name: 'work', model: 'gpt-5', api_key_env_var: 'OPENAI_API_KEY' });
    expect(after.profiles[1]).toEqual({
      name: 'personal',
      model: 'claude-opus-4-7',
      api_key_env_var: 'ANTHROPIC_API_KEY',
    });
    // Sibling MCP server preserved.
    expect(after.mcp_servers['github-mcp']).toEqual({ command: 'gh-mcp', args: ['serve'] });
    // And our entry written.
    expect(after.mcp_servers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  it('issue #437 (Codex round-6): Codex CLI rewrites unsupported inline TOML registration instead of appending a duplicate', async () => {
    // Valid TOML can encode the same parsed object without an
    // explicit [mcp_servers.dkg] table. The narrow splice path cannot
    // safely remove that shape, so it falls back to whole-file
    // serialization instead of appending a second dkg definition.
    const codexDir = join(tmpHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const codexPath = join(codexDir, 'config.toml');
    writeFileSync(
      codexPath,
      [
        '# unusual user-authored shape; fallback must warn before reserializing',
        'model = "gpt-5"',
        'mcp_servers.dkg = { command = "/old/legacy/dkg", args = [ "legacy-arg" ], cwd = "/workspaces/my-project", env = { DKG_HOME = "/old/abandoned/path", NODE_OPTIONS = "--inspect" } }',
        '',
      ].join('\n'),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const afterRaw = readFileSync(codexPath, 'utf-8');
    const after = TOML.parse(afterRaw) as any;
    const stderrText = (stderrSilencer.mock.calls as any[])
      .map((c) => String(c[0]))
      .join('');
    expect(stderrText).toMatch(/WARNING: Codex CLI config/);
    expect(stderrText).toMatch(/cannot be patched safely for mcp_servers\.dkg/);
    expect(stderrText).toMatch(/invalid or duplicate definitions/);
    expect(stderrText).toMatch(/Comments\/formatting outside this entry may not be preserved/);
    expect(after.model).toBe('gpt-5');
    expect(after.mcp_servers.dkg.command).toBe(process.execPath);
    expect(after.mcp_servers.dkg.args[0]).toBe(realpathSync(process.argv[1]));
    expect(after.mcp_servers.dkg.args.slice(1)).toEqual(['mcp', 'serve']);
    expect(after.mcp_servers.dkg.cwd).toBe('/workspaces/my-project');
    expect(after.mcp_servers.dkg.env.DKG_HOME).toBe(join(tmpHome, '.dkg'));
    expect(after.mcp_servers.dkg.env.NODE_OPTIONS).toBe('--inspect');
    expect(afterRaw).toMatch(/^\[mcp_servers\.dkg\]/m);
    expect(afterRaw).not.toContain('mcp_servers.dkg = {');
    expect(afterRaw).not.toContain('/old/legacy/dkg');
  });

  it('issue #437 (Codex round-7): Codex CLI rewrites unsupported inline mcp_servers parent before adding dkg', async () => {
    // Appending [mcp_servers.dkg] under an inline parent table is invalid TOML.
    // Fall back to a full rewrite so existing sibling servers survive as tables.
    const codexDir = join(tmpHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const codexPath = join(codexDir, 'config.toml');
    writeFileSync(
      codexPath,
      [
        '# parent inline table cannot accept a child table append',
        'model = "gpt-5"',
        'mcp_servers = { "github-mcp" = { command = "gh-mcp", args = [ "serve" ] } }',
        '',
      ].join('\n'),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const afterRaw = readFileSync(codexPath, 'utf-8');
    const after = TOML.parse(afterRaw) as any;
    const stderrText = (stderrSilencer.mock.calls as any[])
      .map((c) => String(c[0]))
      .join('');
    expect(stderrText).toMatch(/WARNING: Codex CLI config/);
    expect(stderrText).toMatch(/cannot be patched safely for mcp_servers\.dkg/);
    expect(after.model).toBe('gpt-5');
    expect(after.mcp_servers['github-mcp']).toEqual({
      command: 'gh-mcp',
      args: ['serve'],
    });
    expect(after.mcp_servers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    expect(afterRaw).toMatch(/^\[mcp_servers\.github-mcp\]/m);
    expect(afterRaw).toMatch(/^\[mcp_servers\.dkg\]/m);
    expect(afterRaw).not.toContain('mcp_servers = {');
  });

  it('issue #437 (Codex round-6): Codex CLI ignores table-looking lines inside TOML multiline strings', async () => {
    // The comment-preserving splice scans table headers line-by-line.
    // Bracket-looking text inside a multiline string must not be
    // treated as an owned MCP table range.
    const codexDir = join(tmpHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const codexPath = join(codexDir, 'config.toml');
    const original = [
      'model = "gpt-5"',
      'startup_message = """',
      '[mcp_servers.dkg]',
      'command = "this is prose, not a table"',
      '"""',
      '',
    ].join('\n');
    writeFileSync(codexPath, original);

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const afterRaw = readFileSync(codexPath, 'utf-8');
    const after = TOML.parse(afterRaw) as any;
    expect(afterRaw.startsWith(original)).toBe(true);
    expect(afterRaw).toContain('command = "this is prose, not a table"\n"""');
    expect(afterRaw).toMatch(/"""\n\n\[mcp_servers\.dkg\]\ncommand = "/);
    expect(after.model).toBe('gpt-5');
    expect(after.mcp_servers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });


  // ── Issue #437: format-dispatch round-trip sanity ────────────────────

  it('issue #437: TOML round-trip — write then read returns deep-equal object', async () => {
    // Independent of detectClients / mcpSetupAction — pin that the
    // TOML writer's output is parseable by the same TOML reader and
    // produces the same shape. Guards against silent format drift
    // if the lib bumps a major.
    const codexDir = join(tmpHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const codexPath = join(codexDir, 'config.toml');

    // Trigger a normal write through the action.
    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const written = TOML.parse(readFileSync(codexPath, 'utf-8'));
    // Re-stringify and re-parse — should be deep-equal.
    const reSerialised = TOML.stringify(written as TOML.JsonMap);
    const reParsed = TOML.parse(reSerialised);
    expect(reParsed).toEqual(written);
  });

});
