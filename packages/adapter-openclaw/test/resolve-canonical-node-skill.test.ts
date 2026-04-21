import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join, sep } from 'node:path';

// Use hoisted state so the `vi.mock` factories can read it — vitest hoists
// `vi.mock` calls above imports, so plain top-level `let` wouldn't be visible.
const hoisted = vi.hoisted(() => ({
  existsSync: (_p: string): boolean => false,
  execSync: ((_cmd: string, _opts: unknown): string => {
    throw new Error('execSync was not stubbed for this test');
  }) as (cmd: string, opts: unknown) => string,
  cliPackageJsonPath: '' as string | null,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (p: string) => hoisted.existsSync(p),
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
      // Only the `resolve('@origintrail-official/dkg/package.json')` call
      // matters for this suite. A null `cliPackageJsonPath` simulates the CLI
      // not being installed locally — the real `require.resolve` would
      // throw a MODULE_NOT_FOUND error, which we mirror here.
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

// setup.ts must be imported *after* vi.mock calls so the mocks apply.
const { resolveCanonicalNodeSkillSourcePath } = await import('../src/setup.js');

// Used to keep the `adapterRoot()` probe inside setup.ts happy — it calls
// `existsSync(join(adapterRoot, 'package.json'))` to verify the derived root.
const ADAPTER_PACKAGE_JSON_SUFFIX = `adapter-openclaw${sep}package.json`;

describe('resolveCanonicalNodeSkillSourcePath', () => {
  beforeEach(() => {
    // Default: nothing exists, execSync throws. Each test overrides as needed.
    hoisted.existsSync = () => false;
    hoisted.execSync = () => {
      throw new Error('execSync should not be reached for this test');
    };
    hoisted.cliPackageJsonPath = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers the monorepo dev layout (branch 1) when the sibling cli package is present', () => {
    // setup.ts's `adapterRoot()` consults `existsSync(…/adapter-openclaw/package.json)`
    // to verify the derived root before returning it. Our mock must let that
    // probe succeed so branch-1 computes against the real monorepo layout.
    hoisted.existsSync = (p: string) => {
      if (p.endsWith(ADAPTER_PACKAGE_JSON_SUFFIX)) return true;
      // Branch-1 candidate: the sibling `packages/cli/skills/dkg-node/SKILL.md`.
      if (/[\\/]packages[\\/]cli[\\/]skills[\\/]dkg-node[\\/]SKILL\.md$/.test(p)) return true;
      return false;
    };

    const returned = resolveCanonicalNodeSkillSourcePath();
    expect(returned).toMatch(/[\\/]packages[\\/]cli[\\/]skills[\\/]dkg-node[\\/]SKILL\.md$/);
  });

  it('falls back to the local-install node_modules layout (branch 2) when branch 1 is missing', () => {
    // Fake a locally-installed CLI at /tmp/fake-install/node_modules/@origintrail-official/dkg/
    const fakeCliRoot = '/tmp/fake-install/node_modules/@origintrail-official/dkg';
    hoisted.cliPackageJsonPath = join(fakeCliRoot, 'package.json');
    const branch2Candidate = join(fakeCliRoot, 'skills', 'dkg-node', 'SKILL.md');

    hoisted.existsSync = (p: string) => {
      if (p.endsWith(ADAPTER_PACKAGE_JSON_SUFFIX)) return true; // adapterRoot() probe
      if (p === branch2Candidate) return true; // branch-2 hit
      return false; // branch-1 missing
    };

    expect(resolveCanonicalNodeSkillSourcePath()).toBe(branch2Candidate);
  });

  it('consults the local-install probe before shelling out to `npm prefix -g` (branch 3)', () => {
    const fakeCliRoot = '/tmp/fake-install/node_modules/@origintrail-official/dkg';
    hoisted.cliPackageJsonPath = join(fakeCliRoot, 'package.json');
    const branch2Candidate = join(fakeCliRoot, 'skills', 'dkg-node', 'SKILL.md');

    hoisted.existsSync = (p: string) => {
      if (p.endsWith(ADAPTER_PACKAGE_JSON_SUFFIX)) return true;
      return p === branch2Candidate;
    };
    const execSpy = vi.fn(() => {
      throw new Error('branch 3 should not be reached when branch 2 succeeds');
    });
    hoisted.execSync = execSpy as unknown as (cmd: string, opts: unknown) => string;

    expect(resolveCanonicalNodeSkillSourcePath()).toBe(branch2Candidate);
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('falls through to `npm prefix -g` (branch 3) only when branches 1 and 2 both miss', () => {
    // Branch 2 misses because the mocked createRequire returns a path whose
    // derived candidate won't match anything in our existsSync stub.
    hoisted.cliPackageJsonPath = '/tmp/nowhere/node_modules/@origintrail-official/dkg/package.json';
    const globalPrefix = '/usr/local';
    const globalCandidate = join(
      globalPrefix,
      'lib',
      'node_modules',
      '@origintrail-official',
      'dkg',
      'skills',
      'dkg-node',
      'SKILL.md',
    );

    hoisted.existsSync = (p: string) => {
      if (p.endsWith(ADAPTER_PACKAGE_JSON_SUFFIX)) return true;
      return p === globalCandidate;
    };
    const execSpy = vi.fn((cmd: string) => {
      if (cmd === 'npm prefix -g') return `${globalPrefix}\n`;
      throw new Error(`unexpected execSync(${cmd})`);
    });
    hoisted.execSync = execSpy as unknown as (cmd: string, opts: unknown) => string;

    expect(resolveCanonicalNodeSkillSourcePath()).toBe(globalCandidate);
    expect(execSpy).toHaveBeenCalledWith('npm prefix -g', expect.any(Object));
  });

  it('throws a descriptive error when every branch misses', () => {
    // createRequire.resolve throws (simulates no locally-installed CLI),
    // execSync also throws (simulates `npm prefix -g` failure).
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
