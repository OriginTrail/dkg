import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';

import {
  registerIntegrationCommands,
  type IntegrationCommandDependencies,
} from '../src/integrations/commands.js';
import type { IntegrationEntry } from '../src/integrations/schema.js';
import {
  argsLessMcpEntry,
  baseIntegrationEntry,
} from './_helpers/integration-entry-fixtures.js';
import { createLocalRegistryStub } from './_helpers/local-registry-stub.js';

const baseEntry: IntegrationEntry = baseIntegrationEntry;
const registry = createLocalRegistryStub();
const registryRoutes = registry.routes;

beforeAll(() => registry.start());
afterAll(() => registry.close());

// ── Commander layer: the public `dkg integration …` contracts ──────────────
// Everything above tests helpers. The wiring between them — argument parsing,
// tier defaults, which envelope key each verb prints — lives only in
// commands.ts, so a regression there (a `search` that ignores its keyword, an
// `installed` that prints `{ entries }`) would leave every helper test green.
// These drive the real Commander tree against the real local registry server.
describe('integration commands (Commander layer, real wire)', () => {
  const manualEntry = (slug: string, name: string, tier: 'community' | 'verified'): IntegrationEntry =>
    ({
      ...baseEntry,
      slug,
      name,
      description: `${name} integration for testing`,
      install: { kind: 'manual', docsUrl: 'https://example.com/README.md' },
      trustTier: tier,
    }) as unknown as IntegrationEntry;

  // `manual` entries keep detectInstalled off the network and off npm: with no
  // cli/mcp/npm-global candidates it performs no I/O at all, so `installed`
  // stays deterministic here and still exercises the real command path.
  const alpha = manualEntry('alpha-chat', 'Alpha Chat', 'verified');
  const beta = manualEntry('beta-graph', 'Beta Graph', 'verified');
  const communityOnly = manualEntry('gamma-tool', 'Gamma Tool', 'community');

  // npm-global service WITHOUT `npmGlobal.binary` — schema-valid, and the shape
  // resolveBinary's package-name fallback exists for.
  const svcEntry = {
    ...baseEntry,
    slug: 'svc-ok',
    name: 'Service OK',
    install: {
      kind: 'service',
      runtime: 'npm-global',
      npmGlobal: { package: '@acme/svc', version: '2.0.0' },
      // Declared so the DKG_API_URL guidance renders — that line is where an
      // ignored --api-url becomes visible to an operator.
      envRequired: ['DKG_API_URL'],
    },
    trustTier: 'verified',
  } as unknown as IntegrationEntry;

  // Schema-valid (only kind + runtime are required) but NOT automatable.
  const svcNoMeta = {
    ...baseEntry,
    slug: 'svc-bare',
    name: 'Service Bare',
    install: { kind: 'service', runtime: 'npm-global' },
    trustTier: 'verified',
  } as unknown as IntegrationEntry;

  // Registry-valid, but the package is whitespace. The dispatcher used to gate
  // on truthiness while the installer trimmed, so this passed the gate, threw
  // inside installService, and surfaced as a generic "Install failed".
  const svcBlankPkg = {
    ...baseEntry,
    slug: 'svc-blank',
    name: 'Service Blank',
    install: {
      kind: 'service',
      runtime: 'npm-global',
      npmGlobal: { package: '   ', version: '1.0.0' },
    },
    trustTier: 'verified',
  } as unknown as IntegrationEntry;

  // A runtime the CLI does not automate at all. Readable, and this branch is now
  // its public install behaviour.
  const svcBinary = {
    ...baseEntry,
    slug: 'svc-binary',
    name: 'Service Binary',
    install: {
      kind: 'service',
      runtime: 'binary',
      binary: { url: 'https://example.com/svc' },
    },
    trustTier: 'verified',
  } as unknown as IntegrationEntry;

  let savedIndex: string | undefined;
  let savedRaw: string | undefined;

  beforeEach(() => {
    registry.reset();
    savedIndex = process.env.DKG_REGISTRY_INDEX_URL;
    savedRaw = process.env.DKG_REGISTRY_RAW_BASE;
    // commands.ts calls resolveRegistryConfig() with no argument, so the
    // redirect has to happen through the real environment.
    process.env.DKG_REGISTRY_INDEX_URL = `${registry.baseUrl}/index`;
    process.env.DKG_REGISTRY_RAW_BASE = `${registry.baseUrl}/raw`;

    for (const e of [
      alpha,
      beta,
      communityOnly,
      argsLessMcpEntry,
      svcEntry,
      svcNoMeta,
      svcBinary,
      svcBlankPkg,
    ]) {
      registryRoutes.set(`/raw/${e.slug}.json`, { status: 200, body: JSON.stringify(e) });
    }
    // Only the manual entries are indexed: `installed` runs detectInstalled over
    // everything the index returns, and keeping npm-backed kinds out of it means
    // no test here ever shells out to npm. `install <slug>` fetches by slug, so
    // the service entries are still reachable by the install tests below.
    registryRoutes.set('/index', {
      status: 200,
      body: JSON.stringify([alpha, beta, communityOnly].map((e) => ({ name: `${e.slug}.json` }))),
    });
  });

  afterEach(() => {
    if (savedIndex === undefined) delete process.env.DKG_REGISTRY_INDEX_URL;
    else process.env.DKG_REGISTRY_INDEX_URL = savedIndex;
    if (savedRaw === undefined) delete process.env.DKG_REGISTRY_RAW_BASE;
    else process.env.DKG_REGISTRY_RAW_BASE = savedRaw;
  });

  /** Runs the real command tree and returns whatever it printed to stdout. */
  async function runCli(
    argv: string[],
    deps: IntegrationCommandDependencies = {},
  ): Promise<string> {
    const program = new Command();
    program.exitOverride(); // never let a parse error kill the test runner
    registerIntegrationCommands(program, deps);
    const out: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(' '));
    });
    try {
      await program.parseAsync(['node', 'dkg', ...argv]);
    } finally {
      spy.mockRestore();
    }
    return out.join('\n');
  }

  it('`search <keyword> --json` filters by the keyword', async () => {
    const parsed = JSON.parse(await runCli(['integration', 'search', 'alpha', '--json']));
    expect(parsed.entries.map((e: IntegrationEntry) => e.slug)).toEqual(['alpha-chat']);
  });

  // The control for the test above: without it, a `search` that dropped its
  // keyword and returned everything would still need the filtered case to fail,
  // but a `search` that returned NOTHING would pass it vacuously.
  it('`search --json` with no keyword returns every entry at the tier', async () => {
    const parsed = JSON.parse(await runCli(['integration', 'search', '--json']));
    expect(parsed.entries.map((e: IntegrationEntry) => e.slug).sort()).toEqual([
      'alpha-chat',
      'beta-graph',
    ]);
  });

  it('`list --json` keeps its shipped { entries, failures } envelope', async () => {
    const parsed = JSON.parse(await runCli(['integration', 'list', '--json']));
    expect(Object.keys(parsed).sort()).toEqual(['entries', 'failures']);
    expect(parsed.entries.map((e: IntegrationEntry) => e.slug).sort()).toEqual([
      'alpha-chat',
      'beta-graph',
    ]);
  });

  // `installed` reports something different from `list`/`search`, so it prints a
  // different key. Printing `{ entries }` here would silently look like a
  // registry listing to any script consuming it.
  it('`installed --json` prints { installed, failures }, never { entries }', async () => {
    const parsed = JSON.parse(await runCli(['integration', 'installed', '--json']));
    expect(Object.keys(parsed).sort()).toEqual(['failures', 'installed']);
    expect(parsed.entries).toBeUndefined();
    expect(Array.isArray(parsed.installed)).toBe(true);
  });

  // The two verbs deliberately default to different tiers: browsing surfaces
  // vetted entries, while "what is on my machine" must not hide a
  // community-tier install the user actually has.
  it('defaults `search` to verified but `installed` to community', async () => {
    const searched = JSON.parse(await runCli(['integration', 'search', '--json']));
    expect(searched.entries.map((e: IntegrationEntry) => e.slug)).not.toContain('gamma-tool');

    const inst = JSON.parse(await runCli(['integration', 'installed', '--json']));
    expect(inst.installed.map((r: { slug: string }) => r.slug)).toContain('gamma-tool');
  });

  it('routes a detectable registry entry through real installed detection', async () => {
    registryRoutes.set('/index', {
      status: 200,
      body: JSON.stringify([alpha, svcEntry].map((entry) => ({ name: `${entry.slug}.json` }))),
    });

    const parsed = JSON.parse(
      await runCli(['integration', 'installed', '--json'], {
        detection: { listGlobalNpm: async () => ({ '@acme/svc': '2.0.0' }) },
      }),
    );
    expect(parsed.installed).toContainEqual({
      slug: 'svc-ok',
      kind: 'service',
      state: 'installed',
      detail: '@acme/svc@2.0.0',
    });
  });

  it('prints schema-valid MCP entries with no args through `info`', async () => {
    const output = await runCli(['integration', 'info', argsLessMcpEntry.slug]);
    expect(output).toContain('MCP No Args  [verified]');
    expect(output).toContain('command:    my-mcp-server (no args declared)');
  });

  it('`search --tier community --json` widens to community entries', async () => {
    const parsed = JSON.parse(await runCli(['integration', 'search', '--tier', 'community', '--json']));
    expect(parsed.entries.map((e: IntegrationEntry) => e.slug).sort()).toEqual([
      'alpha-chat',
      'beta-graph',
      'gamma-tool',
    ]);
  });

  // ── install dispatch ────────────────────────────────────────────────────
  // The branches below are reachable only through the command; the helpers
  // cannot tell you whether the dispatcher picked the right one or forwarded
  // its options. Exit codes are captured rather than allowed to run, or a
  // process.exit would take the test runner with it.
  async function runInstall(
    argv: string[],
  ): Promise<{ out: string; err: string; exit: number | null; exits: number[] }> {
    const program = new Command();
    program.exitOverride();
    registerIntegrationCommands(program);
    const out: string[] = [];
    const err: string[] = [];
    const exits: number[] = [];
    let exit: number | null = null;
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(a.map(String).join(' '));
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      err.push(a.map(String).join(' '));
    });
    // Records rather than throws. Throwing would be caught by the command's own
    // try/catch, which then calls process.exit(1) — turning every asserted exit
    // code into 1 and hiding which branch actually ran. Only the FIRST code is
    // kept for the same reason: it is the one the real process would have used.
    // The spy RECORDS rather than throws, because throwing is caught by the
    // command's own try/catch and converted into exit(1) — which collapses
    // every asserted exit code to 1 and hides which branch ran.
    //
    // The cost of not throwing is that execution CONTINUES past a simulated
    // exit, so a missing `break` would let a branch fall through into the
    // generic failure path while `exit` still reports the first code. Every
    // code is therefore recorded: `exits` having more than one entry means the
    // real process would already have terminated, and the test is observing
    // code that could never run.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code ?? 0);
      if (exit === null) exit = code ?? 0;
      return undefined;
    }) as never);
    try {
      await program.parseAsync(['node', 'dkg', ...argv]);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
    return { out: out.join('\n'), err: err.join('\n'), exit, exits };
  }

  it('`install <manual>` prints the docs link and does not exit non-zero', async () => {
    const r = await runInstall(['integration', 'install', 'alpha-chat']);
    expect(r.exit).toBeNull();
    expect(r.out).toContain('https://example.com/README.md');
  });

  it('`install <npm-global service> --dry-run` reaches the service installer with the pin', async () => {
    const r = await runInstall(['integration', 'install', 'svc-ok', '--dry-run']);
    expect(r.exit).toBeNull();
    // Proves dispatch reached installService AND that --dry-run was forwarded.
    expect(r.out).toContain('@acme/svc@2.0.0');
    expect(r.out).toContain('Dry-run');
  });

  // A schema-valid npm-global service with no npmGlobal block cannot be
  // automated. It must take the same graceful path docker/binary take, not
  // throw out of installService into the generic "install failed".
  it('`install` falls back gracefully for an npm-global service with no package metadata', async () => {
    const r = await runInstall(['integration', 'install', 'svc-bare']);
    expect(r.err).toContain('no npmGlobal.package/version');
    expect(r.err).not.toMatch(/undefined/);
    // Exactly one exit. Asserting only the FIRST code would still pass if the
    // branch lost its `break` and fell through into installService, printing
    // the graceful message and then the generic failure — the regression this
    // test exists to catch.
    expect(r.exits).toEqual([2]);
    expect(r.err).not.toContain('Install failed');
  });

  // Regression guard for a fix that was previously verified only BELOW this
  // boundary. `installService` accepted and rendered `apiUrl` correctly, and its
  // unit test passed — while the command never passed the flag through, so the
  // real CLI still printed the default node. Only a test that drives the actual
  // command can catch a missing property on the call.
  it('`install --api-url` reaches the service post-install guidance', async () => {
    const r = await runInstall([
      'integration',
      'install',
      'svc-ok',
      '--dry-run',
      '--api-url',
      'http://10.0.0.5:9200',
    ]);
    expect(r.exits).toEqual([]);
    expect(r.out).toContain('http://10.0.0.5:9200');
    expect(r.out).not.toContain('default http://127.0.0.1:9200');
  });

  // Control: without the flag the guidance still renders, showing the effective
  // node — so the test above cannot pass by never printing the DKG_API_URL line.
  // Commander gives --api-url a default, so opts.apiUrl is always populated and
  // the command path always echoes the URL actually in effect; the literal
  // "default …" wording only appears for direct installService callers that
  // pass no apiUrl at all.
  it('`install --dry-run` shows the effective node when no --api-url is given', async () => {
    const r = await runInstall(['integration', 'install', 'svc-ok', '--dry-run']);
    expect(r.out).toContain('DKG_API_URL');
    expect(r.out).toContain('http://127.0.0.1:9200');
    expect(r.out).not.toContain('10.0.0.5');
  });

  // The gap between the two gates: registry-valid, whitespace package. It must
  // take the same graceful path as missing metadata, not fall through to the
  // generic failure because one layer checked truthiness and the other trimmed.
  it('`install` treats a whitespace-only package as not automatable, not a hard failure', async () => {
    const r = await runInstall(['integration', 'install', 'svc-blank']);
    expect(r.exits).toEqual([2]);
    expect(r.err).toContain('no npmGlobal.package/version');
    expect(r.err).not.toContain('Install failed');
  });

  // Making docker/binary services readable also made this branch their public
  // install behaviour. A regression routing them into installService would
  // surface a generic "Install failed" (exit 1) instead of the graceful
  // runtime-not-automated message — and no helper test would notice.
  it('`install` gives a non-automated runtime the graceful path, not a generic failure', async () => {
    const r = await runInstall(['integration', 'install', 'svc-binary']);
    expect(r.exits).toEqual([2]);
    expect(r.err).toContain('binary');
    expect(r.err).toContain('not yet');
    // The generic catch-all path would say this instead.
    expect(r.err).not.toContain('Install failed');
  });
});
