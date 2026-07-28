import { describe, it, expect } from 'vitest';

import { installService } from '../src/integrations/install-service.js';
import { detectInstalled } from '../src/integrations/detect-installed.js';
import type { IntegrationEntry } from '../src/integrations/schema.js';
import type { ProvenanceCheckResult } from '../src/integrations/verify-npm-provenance.js';

const baseEntry = {
  slug: 'fixture',
  name: 'Fixture',
  description: 'Test fixture',
  maintainer: { github: '@OriginTrail/core-developers' },
  repo: 'https://github.com/OriginTrail/svc',
  commit: '0'.repeat(40),
  license: 'Apache-2.0',
  memoryLayers: ['WM'],
  v10PrimitivesUsed: ['UAL'],
  publicInterfacesUsed: ['http-api'],
  security: { networkEgress: [], writeAuthority: [] },
  trustTier: 'community',
} as unknown as IntegrationEntry;

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

const okProv = { ok: true, reasons: [], found: {} } as unknown as ProvenanceCheckResult;
const badProv = { ok: false, reasons: ['no attestation'], found: {} } as unknown as ProvenanceCheckResult;

const svcEntry = (
  npmGlobal: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): IntegrationEntry =>
  ({
    ...baseEntry,
    slug: 'svc',
    install: { kind: 'service', runtime: 'npm-global', npmGlobal, ...extra },
  }) as unknown as IntegrationEntry;

// A service install writes to the user's global npm prefix exactly like a cli
// install, so it must honour the same provenance contract. These mirror the
// installCli gate tests rather than trusting that the shared helper stays shared.
describe('installService (npm-global)', () => {
  it('refuses to install when provenance fails, before touching npm', async () => {
    const verifier = recordVerifier(badProv);
    const runner = recordRunner(0);
    await expect(
      installService({
        entry: svcEntry({ package: '@acme/svc', version: '1.0.0', binary: 'svc' }),
        verifier,
        runner,
        logger: () => {},
      }),
    ).rejects.toThrow(/cryptographically bound/i);
    expect(runner.calls).toHaveLength(0); // the gate runs BEFORE the global write
  });

  it('installs the pinned version when provenance passes', async () => {
    const verifier = recordVerifier(okProv);
    const runner = recordRunner(0);
    const res = await installService({
      entry: svcEntry({ package: '@acme/svc', version: '1.0.0', binary: 'svc' }),
      verifier,
      runner,
      logger: () => {},
    });
    expect(runner.calls).toEqual([['npm', ['install', '--global', '@acme/svc@1.0.0']]]);
    expect(res.binary).toBe('svc');
  });

  it('skips provenance and npm in dry-run', async () => {
    const verifier = recordVerifier(badProv);
    const runner = recordRunner(0);
    const res = await installService({
      entry: svcEntry({ package: '@acme/svc', version: '1.0.0', binary: 'svc' }),
      dryRun: true,
      verifier,
      runner,
      logger: () => {},
    });
    expect(verifier.calls).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
    expect(res.args).toEqual(['install', '--global', '@acme/svc@1.0.0']);
  });

  it('runs npm when provenance is explicitly skipped', async () => {
    const verifier = recordVerifier(badProv);
    const runner = recordRunner(0);
    await installService({
      entry: svcEntry({ package: '@acme/svc', version: '1.0.0' }),
      skipProvenance: true,
      verifier,
      runner,
      logger: () => {},
    });
    expect(verifier.calls).toHaveLength(0);
    expect(runner.calls).toHaveLength(1);
  });

  it('surfaces a non-zero npm exit', async () => {
    const verifier = recordVerifier(okProv);
    const runner = recordRunner(1);
    await expect(
      installService({
        entry: svcEntry({ package: '@acme/svc', version: '1.0.0' }),
        verifier,
        runner,
        logger: () => {},
      }),
    ).rejects.toThrow(/exit code 1/);
  });

  // npmGlobal.binary is OPTIONAL in the registry schema ("if different from the
  // package name"), so an entry without it must still print a usable command
  // rather than "Start it with: undefined".
  it('falls back to the package name when binary is omitted', async () => {
    const verifier = recordVerifier(okProv);
    const runner = recordRunner(0);
    const res = await installService({
      entry: svcEntry({ package: '@acme/svc', version: '1.0.0' }),
      verifier,
      runner,
      logger: () => {},
    });
    expect(res.binary).toBe('@acme/svc');
    expect(res.postInstructions.join('\n')).toContain('@acme/svc');
    expect(res.postInstructions.join('\n')).not.toContain('undefined');
  });

  it('surfaces envRequired and portsOpened in post-install guidance', async () => {
    const verifier = recordVerifier(okProv);
    const runner = recordRunner(0);
    const res = await installService({
      entry: svcEntry(
        { package: '@acme/svc', version: '1.0.0', binary: 'svc' },
        { envRequired: ['TELEGRAM_BOT_TOKEN', 'DKG_API_URL'], portsOpened: [8080] },
      ),
      verifier,
      runner,
      logger: () => {},
    });
    const text = res.postInstructions.join('\n');
    expect(text).toContain('TELEGRAM_BOT_TOKEN');
    expect(text).toContain('DKG_API_URL');
    expect(text).toContain('8080');
  });

  it('refuses runtimes it does not handle', async () => {
    const docker = {
      ...baseEntry,
      install: { kind: 'service', runtime: 'docker', docker: { image: 'i' } },
    } as unknown as IntegrationEntry;
    await expect(installService({ entry: docker, logger: () => {} })).rejects.toThrow(
      /only handles runtime "npm-global"/,
    );
  });
});

describe('detectInstalled', () => {
  const entry = (slug: string, install: Record<string, unknown>): IntegrationEntry =>
    ({ ...baseEntry, slug, install }) as unknown as IntegrationEntry;

  const clients = [
    { name: 'Cursor', configPath: '/fake/cursor.json', displayPath: '~/cursor.json' },
    { name: 'Windsurf', configPath: '/fake/windsurf.json', displayPath: '~/windsurf.json' },
  ] as never;

  it('reports cli and npm-global service entries from the global npm map', async () => {
    const rows = await detectInstalled(
      [
        entry('a-cli', { kind: 'cli', package: '@acme/cli', version: '1.0.0', binary: 'c' }),
        entry('a-svc', {
          kind: 'service',
          runtime: 'npm-global',
          npmGlobal: { package: '@acme/svc', version: '1.0.0' },
        }),
        entry('missing', { kind: 'cli', package: '@acme/nope', version: '1.0.0', binary: 'n' }),
      ],
      { listGlobalNpm: async () => ({ '@acme/cli': '1.0.0', '@acme/svc': '2.0.0' }) },
    );
    expect(rows.find((r) => r.slug === 'a-cli')).toMatchObject({ state: 'installed' });
    // A service installed by installService must not be reported undetectable.
    expect(rows.find((r) => r.slug === 'a-svc')).toMatchObject({
      state: 'installed',
      kind: 'service',
    });
    expect(rows.find((r) => r.slug === 'missing')).toMatchObject({ state: 'not installed' });
  });

  it('surfaces version drift against the registry pin', async () => {
    const [row] = await detectInstalled(
      [entry('drift', { kind: 'cli', package: '@acme/cli', version: '1.0.0', binary: 'c' })],
      { listGlobalNpm: async () => ({ '@acme/cli': '2.5.0' }) },
    );
    expect(row!.detail).toContain('2.5.0');
    expect(row!.detail).toContain('registry pins 1.0.0');
  });

  it('detects an mcp entry across every client that registers it', async () => {
    const rows = await detectInstalled(
      [entry('mcp-slug', { kind: 'mcp', command: 'npx', args: ['-y', 'p'] })],
      {
        clients,
        readServerKeys: (t) => (t.name === 'Cursor' ? ['mcp-slug', 'other'] : ['mcp-slug']),
      },
    );
    expect(rows[0]).toMatchObject({ state: 'installed' });
    expect(rows[0]!.detail).toContain('Cursor');
    expect(rows[0]!.detail).toContain('Windsurf');
  });

  it('reports an mcp entry no client registers as not installed', async () => {
    const rows = await detectInstalled(
      [entry('mcp-slug', { kind: 'mcp', command: 'npx', args: ['-y', 'p'] })],
      { clients, readServerKeys: () => [] },
    );
    expect(rows[0]).toMatchObject({ state: 'not installed' });
  });

  it('reports kinds it cannot detect as unknown, never "not installed"', async () => {
    const rows = await detectInstalled(
      [
        entry('m', { kind: 'manual', docsUrl: 'https://x/README.md' }),
        entry('ap', { kind: 'agent-plugin', framework: 'openclaw', package: 'p', version: '1' }),
        entry('sb', { kind: 'service', runtime: 'binary' }),
      ],
      { listGlobalNpm: async () => ({}) },
    );
    for (const r of rows) expect(r.state).toBe('unknown');
  });

  it('does not consult npm when no entry installs a global package', async () => {
    let called = false;
    await detectInstalled([entry('m', { kind: 'manual', docsUrl: 'https://x' })], {
      listGlobalNpm: async () => {
        called = true;
        return {};
      },
    });
    expect(called).toBe(false);
  });
});
