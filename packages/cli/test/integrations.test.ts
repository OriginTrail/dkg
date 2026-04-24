import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    args: ['-y', '@origintrail-official/dkg-mcp@0.1.0'],
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

describe('registry-client token scoping', () => {
  // The threat is a developer exporting GITHUB_TOKEN and then pointing
  // DKG_REGISTRY_INDEX_URL/RAW_BASE at a staging / third-party registry for
  // testing. Naively forwarding the Authorization header sends the GitHub
  // PAT to whoever runs that endpoint.
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('forwards GITHUB_TOKEN only to GitHub hosts', async () => {
    let sentAuth: string | null = null;
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sentAuth = (init?.headers as Record<string, string>).Authorization ?? null;
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const cfg = resolveRegistryConfig({ GITHUB_TOKEN: 'ghp_secret' });
    await listSlugs(cfg);
    expect(sentAuth).toBe('Bearer ghp_secret');
  });

  it('does NOT forward GITHUB_TOKEN to a non-GitHub DKG_REGISTRY_INDEX_URL', async () => {
    let sentAuth: string | null | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sentAuth = (init?.headers as Record<string, string>).Authorization ?? null;
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const cfg = resolveRegistryConfig({
      GITHUB_TOKEN: 'ghp_secret',
      DKG_REGISTRY_INDEX_URL: 'https://staging.example.com/index',
      DKG_REGISTRY_RAW_BASE: 'https://staging.example.com/raw',
    });
    await listSlugs(cfg);
    expect(sentAuth).toBeNull();
  });

  it('forwards DKG_REGISTRY_TOKEN to a non-GitHub host', async () => {
    let sentAuth: string | null = null;
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sentAuth = (init?.headers as Record<string, string>).Authorization ?? null;
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const cfg = resolveRegistryConfig({
      GITHUB_TOKEN: 'ghp_should_not_leak',
      DKG_REGISTRY_TOKEN: 'staging-token',
      DKG_REGISTRY_INDEX_URL: 'https://staging.example.com/index',
      DKG_REGISTRY_RAW_BASE: 'https://staging.example.com/raw',
    });
    await listSlugs(cfg);
    expect(sentAuth).toBe('Bearer staging-token');
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

// ── listSlugs / fetchEntry via mocked fetch ───────────────────────────────

describe('listSlugs', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('filters out TEMPLATE.json and non-json / directory entries', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify([
          { name: 'dkg-hello-world.json', type: 'file' },
          { name: 'cursor-mcp-dkg.json', type: 'file' },
          { name: 'TEMPLATE.json', type: 'file' },
          { name: 'README.md', type: 'file' },
          { name: 'subdir', type: 'dir' },
        ]),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const slugs = await listSlugs(resolveRegistryConfig({}));
    expect(slugs).toEqual(['cursor-mcp-dkg', 'dkg-hello-world']);
  });

  it('throws a useful error on rate limit / 403', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"message":"forbidden"}', { status: 403, statusText: 'Forbidden' })) as unknown as typeof fetch;
    await expect(listSlugs(resolveRegistryConfig({}))).rejects.toThrow(/Failed to list registry entries: 403/);
  });
});

describe('fetchEntry', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('rejects directory-traversal-style slugs', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    await expect(fetchEntry('../etc/passwd', resolveRegistryConfig({}))).rejects.toThrow(/Invalid slug/);
  });

  it('returns a well-shaped entry on success', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(baseEntry), { status: 200 })) as unknown as typeof fetch;
    const e = await fetchEntry('dkg-hello-world', resolveRegistryConfig({}));
    expect(e.slug).toBe('dkg-hello-world');
    expect(e.install.kind).toBe('cli');
  });

  it('gives a specific message on 404', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;
    await expect(fetchEntry('ghost', resolveRegistryConfig({}))).rejects.toThrow(/not found in the registry/);
  });

  it('rejects payloads that do not match the schema', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ not: 'an entry' }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchEntry('dkg-hello-world', resolveRegistryConfig({}))).rejects.toThrow(/does not match the expected shape/);
  });

  it('rejects payloads whose declared slug disagrees with the filename', async () => {
    // Registry entry file is dkg-hello-world.json but internal slug says something else —
    // probably a copy/rename artifact. Installing it would silently swap packages.
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ...baseEntry, slug: 'something-else' }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(fetchEntry('dkg-hello-world', resolveRegistryConfig({}))).rejects.toThrow(
      /declares slug "something-else"/,
    );
  });
});

// ── fetchAllEntries resilience ────────────────────────────────────────────

describe('fetchAllEntries', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('returns good entries and collects per-entry failures instead of aborting', async () => {
    // A broken community entry must not hide verified / featured entries.
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/contents/integrations')) {
        return new Response(
          JSON.stringify([
            { name: 'dkg-hello-world.json', type: 'file' },
            { name: 'broken.json', type: 'file' },
          ]),
          { status: 200 },
        );
      }
      if (u.endsWith('/dkg-hello-world.json')) {
        return new Response(JSON.stringify(baseEntry), { status: 200 });
      }
      if (u.endsWith('/broken.json')) {
        return new Response(JSON.stringify({ definitely: 'not an entry' }), { status: 200 });
      }
      return new Response('', { status: 500 });
    }) as unknown as typeof fetch;

    const { entries, failures } = await fetchAllEntries(resolveRegistryConfig({}));
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
    const verifier = vi.fn();
    await installCli({ entry: baseEntry, dryRun: true, verifier, logger: () => {} });
    expect(verifier).not.toHaveBeenCalled();
  });

  it('throws when called with a non-cli entry', async () => {
    await expect(installCli({ entry: mcpEntry, dryRun: true })).rejects.toThrow(/non-cli install spec/);
  });
});

// ── installCli provenance gate ────────────────────────────────────────────

describe('installCli provenance gate', () => {
  // The provenance gate is what ties the registry-reviewed commit to the
  // tarball npm actually hands us. If the gate isn't enforced or the
  // escape hatch isn't respected, the whole "registry-audited integration"
  // claim falls apart on install.
  it('refuses to install when the verifier reports failure', async () => {
    const verifier = vi.fn(async () => failedProvenance);
    const logs: string[] = [];
    await expect(
      installCli({ entry: baseEntry, verifier, logger: (m) => logs.push(m) }),
    ).rejects.toThrow(/not cryptographically bound/);
    expect(verifier).toHaveBeenCalledWith(
      '@origintrail/dkg-hello-world',
      '0.1.0',
      'https://github.com/OriginTrail/dkg-hello-world',
    );
    expect(logs.join('\n')).toContain('Provenance check FAILED');
  });

  it('honors skipProvenance and does not call the verifier', async () => {
    const verifier = vi.fn(async () => failedProvenance);
    const runner = vi.fn(async () => 0);
    const result = await installCli({
      entry: baseEntry,
      skipProvenance: true,
      verifier,
      runner,
      logger: () => {},
    });
    expect(verifier).not.toHaveBeenCalled();
    expect(runner).toHaveBeenCalledWith('npm', ['install', '--global', '@origintrail/dkg-hello-world@0.1.0']);
    expect(result.provenance).toBeUndefined();
  });

  it('records the provenance result on the returned object when ok', async () => {
    const verifier = vi.fn(async () => okProvenance);
    const runner = vi.fn(async () => 0);
    const logs: string[] = [];
    const result = await installCli({
      entry: baseEntry,
      verifier,
      runner,
      logger: (m) => logs.push(m),
    });
    expect(verifier).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledOnce();
    expect(result.provenance?.ok).toBe(true);
    expect(logs.join('\n')).toContain('ok — tarball is attested');
  });

  it('surfaces a non-zero npm exit code as a helpful error', async () => {
    const verifier = vi.fn(async () => okProvenance);
    const runner = vi.fn(async () => 13);
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
    expect(parsed.mcpServers['cursor-mcp-dkg'].args).toEqual(['-y', '@origintrail-official/dkg-mcp@0.1.0']);
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
