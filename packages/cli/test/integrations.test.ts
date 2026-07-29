import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveRegistryConfig,
  listSlugs,
  fetchEntry,
  fetchAllEntries,
  isGithubHost,
} from '../src/integrations/registry-client.js';
import { isIntegrationEntry } from '../src/integrations/schema.js';
import { installCli } from '../src/integrations/install-cli.js';
import { installMcp } from '../src/integrations/install-mcp.js';
import { normalizeRepoUrl } from '../src/integrations/verify-npm-provenance.js';
import type { IntegrationEntry } from '../src/integrations/schema.js';
import type { ProvenanceCheckResult } from '../src/integrations/verify-npm-provenance.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const baseEntry: IntegrationEntry = {
  slug: 'dkg-hello-world',
  name: 'DKG Hello World',
  description: 'Test fixture',
  maintainer: { github: '@OriginTrail/core-developers' },
  repo: 'https://github.com/OriginTrail/dkg-hello-world',
  commit: '0000000000000000000000000000000000000000',
  license: 'Apache-2.0',
  memoryLayers: ['WM'],
  v10PrimitivesUsed: ['ContextGraph', 'Assertion'],
  publicInterfacesUsed: ['http-api'],
  install: {
    kind: 'cli',
    package: '@origintrail/dkg-hello-world',
    version: '0.1.0',
    binary: 'dkg-hello-world',
    envRequired: ['DKG_API_URL', 'DKG_AUTH_TOKEN'],
    usageHint: 'dkg-hello-world greet "first post"\ndkg-hello-world list',
  },
  security: {},
  trustTier: 'featured',
};

const mcpEntry: IntegrationEntry = {
  ...baseEntry,
  slug: 'cursor-mcp-dkg',
  name: 'DKG MCP server',
  install: {
    kind: 'mcp',
    command: 'npx',
    // Unpinned per roadmap §9 decision 14: published version is
    // `0.1.0-dev.<ts>.<sha>`, so a `@0.1.0` pin would not resolve. Tests
    // assert on package id only, not the version suffix.
    args: ['-y', '@origintrail-official/dkg-mcp'],
    envRequired: ['DKG_API_URL', 'DKG_AUTH_TOKEN'],
    supportedClients: ['cursor', 'claude-code', 'claude-desktop'],
  },
};

// A community-tier MCP entry that deliberately does NOT declare
// DKG_AUTH_TOKEN. Used to assert the installer doesn't silently hand the
// node's admin token to third-party MCP servers.
const tokenlessMcpEntry: IntegrationEntry = {
  ...baseEntry,
  slug: 'third-party-mcp',
  name: 'Third-party MCP (no token access)',
  install: {
    kind: 'mcp',
    command: 'npx',
    args: ['-y', '@some-community/mcp@1.0.0'],
    envRequired: ['SOMETHING_ELSE'],
  },
};

const okProvenance: ProvenanceCheckResult = {
  ok: true,
  found: {
    versionResolvable: true,
    hasProvenance: true,
    hasRegistrySignature: true,
    repositoryUrl: 'git+https://github.com/OriginTrail/dkg-hello-world.git',
  },
  expectedRepo: 'https://github.com/OriginTrail/dkg-hello-world',
  reasons: [],
};

const failedProvenance: ProvenanceCheckResult = {
  ok: false,
  found: {
    versionResolvable: true,
    hasProvenance: false,
    hasRegistrySignature: true,
    repositoryUrl: 'git+https://github.com/evil/lookalike.git',
  },
  expectedRepo: 'https://github.com/OriginTrail/dkg-hello-world',
  reasons: [
    'npm tarball lacks a publish-time provenance attestation.',
    'npm repository.url (git+https://github.com/evil/lookalike.git) does not match the registry entry\'s repo.',
  ],
};

// ── isIntegrationEntry ────────────────────────────────────────────────────

describe('isIntegrationEntry', () => {
  it('accepts a well-formed entry', () => {
    expect(isIntegrationEntry(baseEntry)).toBe(true);
  });

  it('accepts a well-formed mcp entry', () => {
    expect(isIntegrationEntry(mcpEntry)).toBe(true);
  });

  it('rejects null, non-objects, and entries missing required keys', () => {
    expect(isIntegrationEntry(null)).toBe(false);
    expect(isIntegrationEntry('string')).toBe(false);
    expect(isIntegrationEntry({})).toBe(false);
    expect(isIntegrationEntry({ slug: 'x', name: 'y', trustTier: 'featured' })).toBe(false);
    expect(isIntegrationEntry({ ...baseEntry, install: { notKind: true } })).toBe(false);
  });

  it('rejects entries with a missing maintainer.github handle', () => {
    const bad = { ...baseEntry, maintainer: {} as { github: string } };
    expect(isIntegrationEntry(bad)).toBe(false);
  });

  it('rejects entries with an unknown memory layer', () => {
    const bad = { ...baseEntry, memoryLayers: ['WM', 'BOGUS'] as unknown as typeof baseEntry.memoryLayers };
    expect(isIntegrationEntry(bad)).toBe(false);
  });

  it('rejects entries with a non-array v10PrimitivesUsed', () => {
    const bad = { ...baseEntry, v10PrimitivesUsed: 'ContextGraph' as unknown as string[] };
    expect(isIntegrationEntry(bad)).toBe(false);
  });

  it('rejects entries whose security block is malformed', () => {
    const bad = { ...baseEntry, security: { networkEgress: 'github.com' } as unknown as typeof baseEntry.security };
    expect(isIntegrationEntry(bad)).toBe(false);
  });

  it('rejects an unknown trustTier', () => {
    const bad = { ...baseEntry, trustTier: 'rogue' as unknown as typeof baseEntry.trustTier };
    expect(isIntegrationEntry(bad)).toBe(false);
  });

  it('rejects a cli install without package/version/binary', () => {
    const bad = {
      ...baseEntry,
      install: { kind: 'cli', package: 'foo' } as unknown as typeof baseEntry.install,
    };
    expect(isIntegrationEntry(bad)).toBe(false);
  });

  it('rejects an mcp install without args array', () => {
    const bad = {
      ...baseEntry,
      install: { kind: 'mcp', command: 'npx', args: 'not-an-array' } as unknown as typeof baseEntry.install,
    };
    expect(isIntegrationEntry(bad)).toBe(false);
  });

  it('rejects an mcp install with a non-string envRequired element', () => {
    const bad = {
      ...baseEntry,
      install: {
        kind: 'mcp',
        command: 'npx',
        args: [],
        envRequired: ['DKG_API_URL', 42],
      } as unknown as typeof baseEntry.install,
    };
    expect(isIntegrationEntry(bad)).toBe(false);
  });

  it('accepts unknown publicInterfacesUsed labels (forward compat)', () => {
    // The CLI only renders this field; it never branches on it. Hard-rejecting
    // unknown labels would stop older CLIs from reading otherwise-valid entries
    // as soon as the registry adds a new interface name.
    const forwardCompat = {
      ...baseEntry,
      publicInterfacesUsed: ['http-api', 'some-future-interface'] as unknown as typeof baseEntry.publicInterfacesUsed,
    };
    expect(isIntegrationEntry(forwardCompat)).toBe(true);
  });
});

// ── isGithubHost + token scoping ──────────────────────────────────────────

describe('isGithubHost', () => {
  it('recognizes GitHub-owned hosts', () => {
    expect(isGithubHost('https://api.github.com/repos/foo/bar')).toBe(true);
    expect(isGithubHost('https://raw.githubusercontent.com/foo/bar/main/x.json')).toBe(true);
    expect(isGithubHost('https://github.com/foo/bar')).toBe(true);
  });

  it('rejects non-GitHub hosts and malformed URLs', () => {
    expect(isGithubHost('https://staging.example.com/registry')).toBe(false);
    expect(isGithubHost('http://localhost:4873/registry')).toBe(false);
    expect(isGithubHost('https://raw-githubusercontent.com.evil.example/')).toBe(false);
    expect(isGithubHost('not a url')).toBe(false);
  });
});

// ── Real local registry server ────────────────────────────────────────────
// Replaces the retired globalThis.fetch stubs: the registry client now makes
// REAL HTTP requests to a server the test controls. The per-test route table
// is fixture DATA on a real wire; `seenAuth` records the Authorization header
// the server REALLY received (the token-leak contract is proven on the
// receiving end, not by inspecting an intercepted call).
const registryRoutes = new Map<string, { status: number; body: string }>();
const seenAuth: Array<string | null> = [];
let registryServer: HttpServer;
let registryBase = '';

beforeAll(async () => {
  registryServer = createHttpServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? null);
    const route = registryRoutes.get(req.url ?? '');
    if (!route) {
      res.writeHead(500);
      res.end('unconfigured route');
      return;
    }
    res.writeHead(route.status, { 'Content-Type': 'application/json' });
    res.end(route.body);
  });
  await new Promise<void>((resolve) => registryServer.listen(0, '127.0.0.1', resolve));
  const addr = registryServer.address();
  if (!addr || typeof addr === 'string') throw new Error('no addr');
  registryBase = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => registryServer.close(() => resolve()));
});

beforeEach(() => {
  registryRoutes.clear();
  seenAuth.length = 0;
});

function localRegistryCfg(extraEnv: Record<string, string> = {}) {
  return resolveRegistryConfig({
    DKG_REGISTRY_INDEX_URL: `${registryBase}/index`,
    DKG_REGISTRY_RAW_BASE: `${registryBase}/raw`,
    ...extraEnv,
  });
}

describe('registry-client token scoping (real wire)', () => {
  // The threat is a developer exporting GITHUB_TOKEN and then pointing
  // DKG_REGISTRY_INDEX_URL/RAW_BASE at a staging / third-party registry for
  // testing. Naively forwarding the Authorization header sends the GitHub
  // PAT to whoever runs that endpoint. The local server here IS such a
  // non-GitHub host, and it reports what it really received.
  // (The GitHub-host POSITIVE branch is held by the isGithubHost predicate
  // tests above — observing the header on a genuine github.com host would
  // require owning GitHub's server.)

  it('does NOT send GITHUB_TOKEN to a non-GitHub registry host (proven at the receiving server)', async () => {
    registryRoutes.set('/index', { status: 200, body: '[]' });
    await listSlugs(localRegistryCfg({ GITHUB_TOKEN: 'ghp_secret' }));
    expect(seenAuth).toEqual([null]);
  });

  it('sends DKG_REGISTRY_TOKEN to the explicitly-trusted non-GitHub host (and not the PAT)', async () => {
    registryRoutes.set('/index', { status: 200, body: '[]' });
    await listSlugs(
      localRegistryCfg({ GITHUB_TOKEN: 'ghp_should_not_leak', DKG_REGISTRY_TOKEN: 'staging-token' }),
    );
    expect(seenAuth).toEqual(['Bearer staging-token']);
  });
});

// ── resolveRegistryConfig ─────────────────────────────────────────────────

describe('resolveRegistryConfig', () => {
  it('falls back to registry defaults when env is empty', () => {
    const cfg = resolveRegistryConfig({});
    expect(cfg.indexUrl).toContain('api.github.com');
    expect(cfg.indexUrl).toContain('dkg-integrations');
    expect(cfg.rawBase).toContain('raw.githubusercontent.com');
    expect(cfg.githubToken).toBeUndefined();
  });

  it('honors overrides', () => {
    const cfg = resolveRegistryConfig({
      DKG_REGISTRY_INDEX_URL: 'https://staging.example/index',
      DKG_REGISTRY_RAW_BASE: 'https://staging.example/raw',
      GITHUB_TOKEN: 'ghp_xyz',
    });
    expect(cfg.indexUrl).toBe('https://staging.example/index');
    expect(cfg.rawBase).toBe('https://staging.example/raw');
    expect(cfg.githubToken).toBe('ghp_xyz');
  });
});

// ── listSlugs / fetchEntry over the REAL local registry server ────────────

describe('listSlugs (real wire)', () => {
  it('filters out TEMPLATE.json and non-json / directory entries', async () => {
    registryRoutes.set('/index', {
      status: 200,
      body: JSON.stringify([
        { name: 'dkg-hello-world.json', type: 'file' },
        { name: 'cursor-mcp-dkg.json', type: 'file' },
        { name: 'TEMPLATE.json', type: 'file' },
        { name: 'README.md', type: 'file' },
        { name: 'subdir', type: 'dir' },
      ]),
    });
    const slugs = await listSlugs(localRegistryCfg());
    expect(slugs).toEqual(['cursor-mcp-dkg', 'dkg-hello-world']);
  });

  it('throws a useful error on a REAL 403', async () => {
    registryRoutes.set('/index', { status: 403, body: '{"message":"forbidden"}' });
    await expect(listSlugs(localRegistryCfg())).rejects.toThrow(/Failed to list registry entries: 403/);
  });
});

describe('fetchEntry (real wire)', () => {
  it('rejects directory-traversal-style slugs BEFORE any request reaches the server', async () => {
    await expect(fetchEntry('../etc/passwd', localRegistryCfg())).rejects.toThrow(/Invalid slug/);
    expect(seenAuth, 'traversal slug must be rejected client-side, before any HTTP').toHaveLength(0);
  });

  it('returns a well-shaped entry on success', async () => {
    registryRoutes.set('/raw/dkg-hello-world.json', { status: 200, body: JSON.stringify(baseEntry) });
    const e = await fetchEntry('dkg-hello-world', localRegistryCfg());
    expect(e.slug).toBe('dkg-hello-world');
    expect(e.install.kind).toBe('cli');
  });

  it('gives a specific message on a REAL 404', async () => {
    registryRoutes.set('/raw/ghost.json', { status: 404, body: '' });
    await expect(fetchEntry('ghost', localRegistryCfg())).rejects.toThrow(/not found in the registry/);
  });

  it('rejects payloads that do not match the schema', async () => {
    registryRoutes.set('/raw/dkg-hello-world.json', { status: 200, body: JSON.stringify({ not: 'an entry' }) });
    await expect(fetchEntry('dkg-hello-world', localRegistryCfg())).rejects.toThrow(/does not match the expected shape/);
  });

  it('rejects payloads whose declared slug disagrees with the filename', async () => {
    // Registry entry file is dkg-hello-world.json but internal slug says something else —
    // probably a copy/rename artifact. Installing it would silently swap packages.
    registryRoutes.set('/raw/dkg-hello-world.json', {
      status: 200,
      body: JSON.stringify({ ...baseEntry, slug: 'something-else' }),
    });
    await expect(fetchEntry('dkg-hello-world', localRegistryCfg())).rejects.toThrow(
      /declares slug "something-else"/,
    );
  });
});

// ── fetchAllEntries resilience (real wire) ────────────────────────────────

describe('fetchAllEntries', () => {
  it('returns good entries and collects per-entry failures instead of aborting', async () => {
    // A broken community entry must not hide verified / featured entries.
    registryRoutes.set('/index', {
      status: 200,
      body: JSON.stringify([
        { name: 'dkg-hello-world.json', type: 'file' },
        { name: 'broken.json', type: 'file' },
      ]),
    });
    registryRoutes.set('/raw/dkg-hello-world.json', { status: 200, body: JSON.stringify(baseEntry) });
    registryRoutes.set('/raw/broken.json', { status: 200, body: JSON.stringify({ definitely: 'not an entry' }) });

    const { entries, failures } = await fetchAllEntries(localRegistryCfg());
    expect(entries.map((e) => e.slug)).toEqual(['dkg-hello-world']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.slug).toBe('broken');
    expect(failures[0]?.error).toMatch(/does not match the expected shape/);
  });
});

// ── normalizeRepoUrl ──────────────────────────────────────────────────────

describe('normalizeRepoUrl', () => {
  it('collapses common git URL shapes to a host+path key', () => {
    const expected = 'github.com/origintrail/dkg-hello-world';
    expect(normalizeRepoUrl('https://github.com/OriginTrail/dkg-hello-world')).toBe(expected);
    expect(normalizeRepoUrl('https://github.com/OriginTrail/dkg-hello-world/')).toBe(expected);
    expect(normalizeRepoUrl('https://github.com/OriginTrail/dkg-hello-world.git')).toBe(expected);
    expect(normalizeRepoUrl('git+https://github.com/OriginTrail/dkg-hello-world.git')).toBe(expected);
    expect(normalizeRepoUrl('git://github.com/OriginTrail/dkg-hello-world.git')).toBe(expected);
    expect(normalizeRepoUrl('git@github.com:OriginTrail/dkg-hello-world.git')).toBe(expected);
  });

  it('returns undefined for empty input', () => {
    expect(normalizeRepoUrl(undefined)).toBeUndefined();
    expect(normalizeRepoUrl('')).toBeUndefined();
  });
});

// ── installCli (dry-run) ──────────────────────────────────────────────────

describe('installCli', () => {
  it('renders the correct npm command in dry-run mode and emits post-instructions', async () => {
    const logs: string[] = [];
    const result = await installCli({ entry: baseEntry, dryRun: true, logger: (m) => logs.push(m) });
    expect(result.command).toBe('npm');
    expect(result.args).toEqual(['install', '--global', '@origintrail/dkg-hello-world@0.1.0']);
    expect(result.binary).toBe('dkg-hello-world');
    expect(result.postInstructions.join('\n')).toContain('DKG_AUTH_TOKEN');
    expect(result.postInstructions.join('\n')).toContain('dkg-hello-world greet');
    expect(logs.join('\n')).toContain('npm install --global @origintrail/dkg-hello-world@0.1.0');
  });

  it('dry-run does NOT invoke the provenance verifier (no side effects to guard)', async () => {
    const verifier = recordVerifier(okProvenance);
    await installCli({ entry: baseEntry, dryRun: true, verifier, logger: () => {} });
    expect(verifier.calls).toEqual([]);
  });

  it('throws when called with a non-cli entry', async () => {
    await expect(installCli({ entry: mcpEntry, dryRun: true })).rejects.toThrow(/non-cli install spec/);
  });
});

// ── installCli provenance gate ────────────────────────────────────────────

// Hand-rolled DI-seam recorders (no vitest mock API): verifier/runner are
// installCli's injection points; plain recording functions capture the calls.
function recordVerifier(result: ProvenanceCheckResult) {
  const calls: unknown[][] = [];
  const fn = async (...args: unknown[]) => {
    calls.push(args);
    return result;
  };
  return Object.assign(fn, { calls });
}
function recordRunner(exitCode: number) {
  const calls: Array<[string, string[]]> = [];
  const fn = async (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    return exitCode;
  };
  return Object.assign(fn, { calls });
}

describe('installCli provenance gate', () => {
  // The provenance gate is what ties the registry-reviewed commit to the
  // tarball npm actually hands us. If the gate isn't enforced or the
  // escape hatch isn't respected, the whole "registry-audited integration"
  // claim falls apart on install.
  it('refuses to install when the verifier reports failure', async () => {
    const verifier = recordVerifier(failedProvenance);
    const logs: string[] = [];
    await expect(
      installCli({ entry: baseEntry, verifier, logger: (m) => logs.push(m) }),
    ).rejects.toThrow(/not cryptographically bound/);
    expect(verifier.calls).toEqual([[
      '@origintrail/dkg-hello-world',
      '0.1.0',
      'https://github.com/OriginTrail/dkg-hello-world',
    ]]);
    expect(logs.join('\n')).toContain('Provenance check FAILED');
  });

  it('honors skipProvenance and does not call the verifier', async () => {
    const verifier = recordVerifier(failedProvenance);
    const runner = recordRunner(0);
    const result = await installCli({
      entry: baseEntry,
      skipProvenance: true,
      verifier,
      runner,
      logger: () => {},
    });
    expect(verifier.calls).toEqual([]);
    expect(runner.calls).toEqual([['npm', ['install', '--global', '@origintrail/dkg-hello-world@0.1.0']]]);
    expect(result.provenance).toBeUndefined();
  });

  it('records the provenance result on the returned object when ok', async () => {
    const verifier = recordVerifier(okProvenance);
    const runner = recordRunner(0);
    const logs: string[] = [];
    const result = await installCli({
      entry: baseEntry,
      verifier,
      runner,
      logger: (m) => logs.push(m),
    });
    expect(verifier.calls).toHaveLength(1);
    expect(runner.calls).toHaveLength(1);
    expect(result.provenance?.ok).toBe(true);
    expect(logs.join('\n')).toContain('ok — tarball is attested');
  });

  it('surfaces a non-zero npm exit code as a helpful error', async () => {
    const verifier = recordVerifier(okProvenance);
    const runner = recordRunner(13);
    await expect(
      installCli({ entry: baseEntry, verifier, runner, logger: () => {} }),
    ).rejects.toThrow(/npm install failed with exit code 13/);
  });
});

// ── installMcp (pure render) ──────────────────────────────────────────────

describe('installMcp', () => {
  let tmpHome: string;
  let tmpDkgHome: string;
  const originalHome = process.env.HOME;
  const originalDkgHome = process.env.DKG_HOME;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'dkg-cli-mcp-'));
    tmpDkgHome = join(tmpHome, '.dkg');
    process.env.HOME = tmpHome;
    // Pin DKG_HOME so dkgDir() resolves deterministically inside the monorepo —
    // otherwise the .dkg-dev fallback kicks in and the token-file test becomes
    // order-sensitive depending on the developer's real home layout.
    process.env.DKG_HOME = tmpDkgHome;
  });

  afterEach(async () => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalDkgHome) process.env.DKG_HOME = originalDkgHome;
    else delete process.env.DKG_HOME;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('emits a paste-ready mcpServers block with api-url and placeholder token when envRequired lists them', async () => {
    const logs: string[] = [];
    const res = await installMcp({ entry: mcpEntry, apiUrl: 'http://127.0.0.1:9200', logger: (m) => logs.push(m) });
    const parsed = JSON.parse(res.mcpJson);
    expect(parsed.mcpServers['cursor-mcp-dkg'].command).toBe('npx');
    // Loose match per roadmap §9 decision 14 — published version is
    // `0.1.0-dev.<ts>.<sha>` so we assert on package id, not pin.
    expect(parsed.mcpServers['cursor-mcp-dkg'].args).toContain('-y');
    expect(parsed.mcpServers['cursor-mcp-dkg'].args).toContain('@origintrail-official/dkg-mcp');
    expect(parsed.mcpServers['cursor-mcp-dkg'].env.DKG_API_URL).toBe('http://127.0.0.1:9200');
    expect(parsed.mcpServers['cursor-mcp-dkg'].env.DKG_AUTH_TOKEN).toBe('<DKG_AUTH_TOKEN>');
    expect(res.token).toBeUndefined();
    expect(logs.some((l) => l.includes('mcpServers'))).toBe(true);
  });

  it('substitutes the real token when <DKG_HOME>/auth.token is present', async () => {
    await mkdir(tmpDkgHome, { recursive: true });
    await writeFile(
      join(tmpDkgHome, 'auth.token'),
      '# DKG node API token — treat this like a password\nreal-token-xyz\n',
      'utf8',
    );
    const res = await installMcp({ entry: mcpEntry, apiUrl: 'http://127.0.0.1:9200', logger: () => {} });
    const parsed = JSON.parse(res.mcpJson);
    expect(parsed.mcpServers['cursor-mcp-dkg'].env.DKG_AUTH_TOKEN).toBe('real-token-xyz');
    expect(res.token).toBe('real-token-xyz');
  });

  it('honors DKG_HOME when resolving the auth token', async () => {
    const altHome = await mkdtemp(join(tmpdir(), 'dkg-cli-mcp-alt-'));
    try {
      process.env.DKG_HOME = altHome;
      await writeFile(join(altHome, 'auth.token'), 'alt-token\n', 'utf8');
      const res = await installMcp({ entry: mcpEntry, apiUrl: 'http://127.0.0.1:9200', logger: () => {} });
      expect(res.token).toBe('alt-token');
    } finally {
      await rm(altHome, { recursive: true, force: true });
    }
  });

  it('does NOT embed DKG_AUTH_TOKEN when envRequired does not declare it', async () => {
    // Core security boundary: a third-party / community MCP server that
    // doesn't ask for DKG_AUTH_TOKEN must not receive the node's admin
    // token by default — even if there is a local token on disk.
    await mkdir(tmpDkgHome, { recursive: true });
    await writeFile(join(tmpDkgHome, 'auth.token'), 'should-not-leak\n', 'utf8');

    const logs: string[] = [];
    const res = await installMcp({
      entry: tokenlessMcpEntry,
      apiUrl: 'http://127.0.0.1:9200',
      logger: (m) => logs.push(m),
    });
    const parsed = JSON.parse(res.mcpJson);
    const env = parsed.mcpServers['third-party-mcp'].env;
    expect(env).not.toHaveProperty('DKG_AUTH_TOKEN');
    // Also: DKG_API_URL is only auto-added when envRequired asks for it.
    // This entry only asks for SOMETHING_ELSE, which gets a placeholder.
    expect(env).not.toHaveProperty('DKG_API_URL');
    expect(env.SOMETHING_ELSE).toBe('<SOMETHING_ELSE>');
    expect(res.token).toBeUndefined();
    expect(logs.join('\n')).toContain('does not declare DKG_AUTH_TOKEN');
    expect(logs.join('\n')).toContain('SOMETHING_ELSE');
  });

  it('does not read the local token file when envRequired does not declare DKG_AUTH_TOKEN', async () => {
    // Belt-and-braces: not only must the token not appear in the output,
    // we shouldn't even read auth.token from disk. Write a token that
    // would stand out if it appeared anywhere in the output.
    await mkdir(tmpDkgHome, { recursive: true });
    await writeFile(join(tmpDkgHome, 'auth.token'), 'MARKER-SHOULD-NEVER-APPEAR\n', 'utf8');
    const logs: string[] = [];
    const res = await installMcp({
      entry: tokenlessMcpEntry,
      apiUrl: 'http://127.0.0.1:9200',
      logger: (m) => logs.push(m),
    });
    expect(res.mcpJson).not.toContain('MARKER-SHOULD-NEVER-APPEAR');
    expect(logs.join('\n')).not.toContain('MARKER-SHOULD-NEVER-APPEAR');
    expect(res.token).toBeUndefined();
  });
});

// ── Registry ↔ CLI contract ───────────────────────────────────────────────
//
// The CLI's validator is a hand-written re-implementation of the registry's
// published JSON Schema. It drifted STRICTER than the schema in three places
// and silently dropped every affected entry as "unreadable" — in `dkg
// integration` and in the node dashboard sidebar, which share this parser.
//
// These tests own that seam. The per-kind cases are derived from the schema's
// $defs (minimal shapes the registry can merge); the vendored cases are
// verbatim copies of live entries. The first set is what catches drift.

describe('registry ↔ CLI contract', () => {
  const contractBase = {
    schemaVersion: '0.1.0',
    slug: 'contract-fixture',
    name: 'Contract Fixture',
    description: 'x'.repeat(25),
    category: ['test'],
    maintainer: { github: '@OriginTrail/core-developers' },
    repo: 'https://github.com/OriginTrail/dkg',
    commit: 'a'.repeat(40),
    license: 'Apache-2.0',
    memoryLayers: ['WM'],
    v10PrimitivesUsed: ['UAL'],
    publicInterfacesUsed: ['http-api'],
    security: { networkEgress: [], writeAuthority: [] },
    trustTier: 'community',
  };

  // One minimal, registry-VALID shape per $defs entry in the published schema.
  // Every one of these must parse, or the registry can merge something the CLI
  // cannot read.
  const schemaValidInstalls: Array<[string, Record<string, unknown>]> = [
    ['cli', { kind: 'cli', package: 'p', version: '1.0.0', binary: 'b' }],
    ['mcp (args present)', { kind: 'mcp', command: 'npx', args: ['-y', 'p'], supportedClients: ['cursor'] }],
    // args is OPTIONAL in the schema; installMcp normalises a missing value to [].
    ['mcp (args absent)', { kind: 'mcp', command: 'npx', supportedClients: ['cursor'] }],
    ['service (npm-global)', { kind: 'service', runtime: 'npm-global', npmGlobal: { package: 'p', version: '1.0.0', binary: 'b' } }],
    // The schema requires ONLY kind + runtime for a service; every payload
    // object is optional. These minimal rows are the ones that actually pin
    // the compatibility boundary — a validator that started demanding
    // `npmGlobal` or `docker` would still pass the populated rows above and
    // reject entries the registry considers valid, which is precisely the
    // stricter-than-schema drift this PR exists to remove.
    ['service (npm-global, minimal)', { kind: 'service', runtime: 'npm-global' }],
    ['service (docker, minimal)', { kind: 'service', runtime: 'docker' }],
    ['service (docker)', { kind: 'service', runtime: 'docker', docker: { image: 'i', version: '1' } }],
    // 'binary' is in the schema's runtime enum.
    ['service (binary)', { kind: 'service', runtime: 'binary' }],
    ['agent-plugin', { kind: 'agent-plugin', framework: 'openclaw', package: 'p', version: '1.0.0' }],
    // manual requires docsUrl and FORBIDS anything but oneLiner beyond it.
    ['manual (docsUrl only)', { kind: 'manual', docsUrl: 'https://example.com/README.md' }],
    ['manual (+ oneLiner)', { kind: 'manual', docsUrl: 'https://example.com/README.md', oneLiner: 'run it' }],
  ];

  it.each(schemaValidInstalls)('accepts a schema-valid %s entry', (_label, install) => {
    expect(isIntegrationEntry({ ...contractBase, install })).toBe(true);
  });

  it('still rejects shapes the schema would also reject', () => {
    const invalid: Array<Record<string, unknown>> = [
      { kind: 'manual' }, // docsUrl is required
      { kind: 'mcp' }, // command is required
      { kind: 'cli', package: 'p' }, // version + binary required
      { kind: 'service' }, // runtime required
      { kind: 'service', runtime: 'kubernetes' }, // not in the enum
      { kind: 'not-a-kind' },
    ];
    for (const install of invalid) {
      expect(isIntegrationEntry({ ...contractBase, install })).toBe(false);
    }
  });

  it('parses every vendored live registry entry', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const dir = join(__dirname, 'fixtures', 'registry');
    const files = (await readdir(dir)).filter(
      (f) => f.endsWith('.json') && f !== 'integration.schema.json',
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const entry = JSON.parse(await readFile(join(dir, f), 'utf8'));
      expect(isIntegrationEntry(entry), `${f} must be readable by the CLI`).toBe(true);
    }
  });

  it('covers every install kind the published schema defines', async () => {
    const { readFile } = await import('node:fs/promises');
    const schema = JSON.parse(
      await readFile(join(__dirname, 'fixtures', 'registry', 'integration.schema.json'), 'utf8'),
    );
    const schemaKinds = Object.values(schema.$defs as Record<string, { properties: { kind: { const: string } } }>)
      .map((d) => d.properties.kind.const)
      .sort();
    const covered = [...new Set(schemaValidInstalls.map(([, i]) => i.kind as string))].sort();
    // If the registry adds an install kind, this fails until the CLI handles it.
    expect(covered).toEqual(schemaKinds);
  });
});

describe('installMcp with an args-less entry', () => {
  // `args` is optional in the registry schema, and legitimately so: a server
  // launched by a binary already on PATH needs none, while an npx-style
  // launcher carries the package there. The installer must emit a well-formed
  // block rather than dropping the key (JSON.stringify discards `undefined`)
  // or refusing the entry — judging whether a given command needs args is the
  // entry author's call, not the installer's.
  const mcpNoArgs: IntegrationEntry = {
    ...baseEntry,
    slug: 'no-args',
    install: { kind: 'mcp', command: 'my-mcp-server', supportedClients: ['cursor'] },
  };

  it('emits args: [] rather than omitting the key', async () => {
    const res = await installMcp({
      entry: mcpNoArgs,
      apiUrl: 'http://127.0.0.1:9200',
      logger: () => {},
    });
    const parsed = JSON.parse(res.mcpJson) as {
      mcpServers: Record<string, { command: string; args: unknown }>;
    };
    const block = parsed.mcpServers['no-args']!;
    expect(block.command).toBe('my-mcp-server');
    expect(block.args).toEqual([]);
    expect(res.mcpJson).toContain('"args"');
  });

  it('preserves declared args when present', async () => {
    const withArgs: IntegrationEntry = {
      ...mcpNoArgs,
      slug: 'with-args',
      install: { kind: 'mcp', command: 'npx', args: ['-y', 'pkg@1.0.0'] },
    };
    const res = await installMcp({
      entry: withArgs,
      apiUrl: 'http://127.0.0.1:9200',
      logger: () => {},
    });
    const parsed = JSON.parse(res.mcpJson) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(parsed.mcpServers['with-args']!.args).toEqual(['-y', 'pkg@1.0.0']);
  });
});
