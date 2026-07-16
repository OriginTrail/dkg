import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join, sep } from 'node:path';

// Hoisted stubs — vitest hoists `vi.mock` factories above imports, so plain
// top-level `let` wouldn't be reachable from inside the mock.
const hoisted = vi.hoisted(() => ({
  existsSync: (_p: string): boolean => false,
  execSync: ((_cmd: string, _opts: unknown): string => {
    throw new Error('execSync was not stubbed for this test');
  }) as (cmd: string, opts: unknown) => string,
  readFileSync: null as null | ((p: string, enc?: unknown) => string),
  cliPackageJsonPath: '' as string | null,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (p: string) => hoisted.existsSync(p),
    readFileSync: (p: string, enc?: unknown) =>
      hoisted.readFileSync ? hoisted.readFileSync(p, enc) : actual.readFileSync(p, enc as any),
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execSync: (cmd: string, opts: unknown) => hoisted.execSync(cmd, opts),
  };
});

vi.mock('node:module', async () => {
  const actual = await vi.importActual<typeof import('node:module')>('node:module');
  return {
    ...actual,
    createRequire: () => ({
      resolve: (specifier: string) => {
        if (specifier === '@origintrail-official/dkg/package.json') {
          if (hoisted.cliPackageJsonPath == null) {
            const err = new Error(`Cannot find module '${specifier}'`) as Error & { code?: string };
            err.code = 'MODULE_NOT_FOUND';
            throw err;
          }
          return hoisted.cliPackageJsonPath;
        }
        throw new Error(`unexpected require.resolve(${specifier}) in test`);
      },
    }),
  };
});

// Must import after vi.mock so setup.ts sees the stubs.
const { resolveCliPackageDir, resolveCanonicalNodeSkillSourcePath, loadNetworkConfig } =
  await import('../src/setup.js');

// Adapter root probe that setup.ts's `adapterRoot()` performs via
// `existsSync(join(adapterRoot, 'package.json'))`. Every test must allow that
// probe to succeed so branch-1 candidate paths derive correctly.
const ADAPTER_PACKAGE_JSON_SUFFIX = `adapter-openclaw${sep}package.json`;
// Branch-1 candidate: `resolve(adapterRoot(), '..', 'cli')` — i.e. the sibling
// `packages/cli` directory. resolveCliPackageDir existsSyncs its package.json.
const MONOREPO_CLI_PACKAGE_JSON_SUFFIX = `packages${sep}cli${sep}package.json`;

describe('resolveCliPackageDir', () => {
  beforeEach(() => {
    hoisted.existsSync = () => false;
    hoisted.execSync = () => {
      throw new Error('execSync should not be reached for this test');
    };
    hoisted.readFileSync = null;
    hoisted.cliPackageJsonPath = null; // MODULE_NOT_FOUND by default
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the monorepo sibling `packages/cli` when its package.json exists (branch 1)', () => {
    hoisted.existsSync = (p: string) => {
      if (p.endsWith(ADAPTER_PACKAGE_JSON_SUFFIX)) return true;
      if (p.endsWith(MONOREPO_CLI_PACKAGE_JSON_SUFFIX)) return true;
      return false;
    };

    const dir = resolveCliPackageDir();
    expect(dir).toMatch(new RegExp(`[\\\\/]packages[\\\\/]cli$`));
  });

  it('falls back to the local-install node_modules layout (branch 2) when branch 1 misses', () => {
    const fakeCliDir = join(sep, 'tmp', 'app', 'node_modules', '@origintrail-official', 'dkg');
    hoisted.cliPackageJsonPath = join(fakeCliDir, 'package.json');
    hoisted.existsSync = (p: string) => {
      if (p.endsWith(ADAPTER_PACKAGE_JSON_SUFFIX)) return true;
      return p === join(fakeCliDir, 'package.json');
    };

    expect(resolveCliPackageDir()).toBe(fakeCliDir);
  });

  it('consults the local-install probe before shelling out to `npm prefix -g` (ordering: branch 2 before branch 3)', () => {
    const fakeCliDir = join(sep, 'tmp', 'app', 'node_modules', '@origintrail-official', 'dkg');
    hoisted.cliPackageJsonPath = join(fakeCliDir, 'package.json');
    hoisted.existsSync = (p: string) => {
      if (p.endsWith(ADAPTER_PACKAGE_JSON_SUFFIX)) return true;
      return p === join(fakeCliDir, 'package.json');
    };
    const execSpy = vi.fn(() => {
      throw new Error('branch 3 should not be reached when branch 2 succeeds');
    });
    hoisted.execSync = execSpy as unknown as (cmd: string, opts: unknown) => string;

    expect(resolveCliPackageDir()).toBe(fakeCliDir);
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('falls through to `npm prefix -g` (branch 3) when branches 1 and 2 both miss', () => {
    // createRequire.resolve throws (no local install), so branch 2 misses.
    hoisted.cliPackageJsonPath = null;
    const globalPrefix = '/usr/local';
    const globalDir = join(globalPrefix, 'lib', 'node_modules', '@origintrail-official', 'dkg');
    hoisted.existsSync = (p: string) => {
      if (p.endsWith(ADAPTER_PACKAGE_JSON_SUFFIX)) return true;
      return p === join(globalDir, 'package.json');
    };
    const execSpy = vi.fn((cmd: string) => {
      if (cmd === 'npm prefix -g') return `${globalPrefix}\n`;
      throw new Error(`unexpected execSync(${cmd})`);
    });
    hoisted.execSync = execSpy as unknown as (cmd: string, opts: unknown) => string;

    expect(resolveCliPackageDir()).toBe(globalDir);
    expect(execSpy).toHaveBeenCalledWith('npm prefix -g', expect.any(Object));
  });

  it('returns null when every branch misses — callers surface their own errors', () => {
    hoisted.cliPackageJsonPath = null;
    hoisted.existsSync = (p: string) => p.endsWith(ADAPTER_PACKAGE_JSON_SUFFIX);
    hoisted.execSync = () => {
      throw new Error('npm not available');
    };

    expect(resolveCliPackageDir()).toBeNull();
  });

  it('falls through to branch 3 when `npm prefix -g` global layout resolves via `node_modules/@...` (non-lib variant)', () => {
    hoisted.cliPackageJsonPath = null;
    const globalPrefix = '/usr/local';
    const globalDir = join(globalPrefix, 'node_modules', '@origintrail-official', 'dkg'); // no `lib`
    hoisted.existsSync = (p: string) => {
      if (p.endsWith(ADAPTER_PACKAGE_JSON_SUFFIX)) return true;
      return p === join(globalDir, 'package.json');
    };
    hoisted.execSync = ((cmd: string) => {
      if (cmd === 'npm prefix -g') return `${globalPrefix}\n`;
      throw new Error(`unexpected execSync(${cmd})`);
    }) as (cmd: string, opts: unknown) => string;

    expect(resolveCliPackageDir()).toBe(globalDir);
  });
});

describe('resolveCanonicalNodeSkillSourcePath (consumer of resolveCliPackageDir)', () => {
  beforeEach(() => {
    hoisted.existsSync = () => false;
    hoisted.execSync = () => {
      throw new Error('execSync should not be reached for this test');
    };
    hoisted.readFileSync = null;
    hoisted.cliPackageJsonPath = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves SKILL.md from the local-install layout (branch 2)', () => {
    const fakeCliDir = join(sep, 'tmp', 'app', 'node_modules', '@origintrail-official', 'dkg');
    hoisted.cliPackageJsonPath = join(fakeCliDir, 'package.json');
    const skillPath = join(fakeCliDir, 'skills', 'dkg-node', 'SKILL.md');
    hoisted.existsSync = (p: string) => {
      if (p.endsWith(ADAPTER_PACKAGE_JSON_SUFFIX)) return true;
      return p === join(fakeCliDir, 'package.json') || p === skillPath;
    };

    expect(resolveCanonicalNodeSkillSourcePath()).toBe(skillPath);
  });

  it('throws when the CLI dir resolves but SKILL.md is absent', () => {
    const fakeCliDir = join(sep, 'tmp', 'app', 'node_modules', '@origintrail-official', 'dkg');
    hoisted.cliPackageJsonPath = join(fakeCliDir, 'package.json');
    hoisted.existsSync = (p: string) => {
      if (p.endsWith(ADAPTER_PACKAGE_JSON_SUFFIX)) return true;
      return p === join(fakeCliDir, 'package.json'); // SKILL.md missing
    };

    expect(() => resolveCanonicalNodeSkillSourcePath()).toThrow(
      /Could not find the canonical DKG node SKILL\.md/,
    );
  });

  it('throws when no branch locates the CLI dir', () => {
    hoisted.cliPackageJsonPath = null;
    hoisted.existsSync = (p: string) => p.endsWith(ADAPTER_PACKAGE_JSON_SUFFIX);
    hoisted.execSync = () => {
      throw new Error('npm not available');
    };

    expect(() => resolveCanonicalNodeSkillSourcePath()).toThrow(
      /Could not find the canonical DKG node SKILL\.md/,
    );
  });
});

describe('loadNetworkConfig (consumer of resolveCliPackageDir — PR #228 Codex #5)', () => {
  const sampleTestnet = {
    networkName: 'fake-testnet',
    relays: [],
    defaultContextGraphs: ['fake'],
    defaultNodeRole: 'edge',
  };

  beforeEach(() => {
    hoisted.existsSync = () => false;
    hoisted.execSync = () => {
      throw new Error('execSync should not be reached for this test');
    };
    hoisted.readFileSync = null;
    hoisted.cliPackageJsonPath = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads testnet.json from the local-install layout (branch 2)', () => {
    const fakeCliDir = join(sep, 'tmp', 'app', 'node_modules', '@origintrail-official', 'dkg');
    hoisted.cliPackageJsonPath = join(fakeCliDir, 'package.json');
    const testnetPath = join(fakeCliDir, 'network', 'testnet.json');
    hoisted.existsSync = (p: string) => {
      if (p.endsWith(ADAPTER_PACKAGE_JSON_SUFFIX)) return true;
      return p === join(fakeCliDir, 'package.json') || p === testnetPath;
    };
    hoisted.readFileSync = (p: string) => {
      if (p === testnetPath) return JSON.stringify(sampleTestnet);
      throw new Error(`unexpected readFileSync(${p})`);
    };

    expect(loadNetworkConfig()).toEqual(sampleTestnet);
  });

  it('reads testnet.json from the global-install layout (branch 3)', () => {
    hoisted.cliPackageJsonPath = null;
    const globalPrefix = '/usr/local';
    const globalDir = join(globalPrefix, 'lib', 'node_modules', '@origintrail-official', 'dkg');
    const testnetPath = join(globalDir, 'network', 'testnet.json');
    hoisted.existsSync = (p: string) => {
      if (p.endsWith(ADAPTER_PACKAGE_JSON_SUFFIX)) return true;
      return p === join(globalDir, 'package.json') || p === testnetPath;
    };
    hoisted.execSync = ((cmd: string) => {
      if (cmd === 'npm prefix -g') return `${globalPrefix}\n`;
      throw new Error(`unexpected execSync(${cmd})`);
    }) as (cmd: string, opts: unknown) => string;
    hoisted.readFileSync = (p: string) => {
      if (p === testnetPath) return JSON.stringify(sampleTestnet);
      throw new Error(`unexpected readFileSync(${p})`);
    };

    expect(loadNetworkConfig()).toEqual(sampleTestnet);
  });

  it('throws a descriptive error when no branch locates testnet.json', () => {
    hoisted.cliPackageJsonPath = null;
    hoisted.existsSync = (p: string) => p.endsWith(ADAPTER_PACKAGE_JSON_SUFFIX);
    hoisted.execSync = () => {
      throw new Error('npm not available');
    };

    expect(() => loadNetworkConfig()).toThrow(/Could not find network\/testnet\.json/);
  });
});
