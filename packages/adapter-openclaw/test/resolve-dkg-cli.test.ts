import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

const hoisted = vi.hoisted(() => ({
  existsSync: (_p: string): boolean => false,
  requireResolve: null as null | ((specifier: string) => string),
  requireResolveError: null as null | (Error & { code?: string }),
  resolveCliPackageDir: (): string | null => null,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (p: string) => hoisted.existsSync(p),
  };
});

vi.mock('node:module', async () => {
  const actual = await vi.importActual<typeof import('node:module')>('node:module');
  return {
    ...actual,
    createRequire: () => ({
      resolve: (specifier: string) => {
        if (hoisted.requireResolveError) throw hoisted.requireResolveError;
        if (hoisted.requireResolve == null) {
          const err = new Error(`Cannot find module '${specifier}'`) as Error & { code?: string };
          err.code = 'MODULE_NOT_FOUND';
          throw err;
        }
        return hoisted.requireResolve(specifier);
      },
    }),
  };
});

// Fully replace ../src/setup.js so the resolver can depend on
// `resolveCliPackageDir` without pulling setup.ts's transitive imports into
// this test. setup.ts itself imports from resolve-dkg-cli.ts, so mocking the
// whole module also avoids the import cycle that full evaluation would hit.
vi.mock('../src/setup.js', () => ({
  resolveCliPackageDir: () => hoisted.resolveCliPackageDir(),
}));

const { resolveDkgCli } = await import('../src/resolve-dkg-cli.js');

describe('resolveDkgCli', () => {
  let origEnv: string | undefined;
  let origArgv1: string | undefined;

  beforeEach(() => {
    origEnv = process.env.DKG_CLI_PATH;
    origArgv1 = process.argv[1];
    delete process.env.DKG_CLI_PATH;
    hoisted.existsSync = () => false;
    hoisted.requireResolve = null;
    hoisted.requireResolveError = null;
    hoisted.resolveCliPackageDir = () => null;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.DKG_CLI_PATH;
    else process.env.DKG_CLI_PATH = origEnv;
    process.argv[1] = origArgv1 as string;
  });

  it('honors DKG_CLI_PATH when the file exists', () => {
    const override = '/custom/path/to/cli.js';
    process.env.DKG_CLI_PATH = override;
    hoisted.existsSync = (p) => p === override;

    const resolved = resolveDkgCli();

    expect(resolved.node).toBe(process.execPath);
    expect(resolved.cliPath).toBe(override);
  });

  it('throws when DKG_CLI_PATH points at a missing file', () => {
    process.env.DKG_CLI_PATH = '/does/not/exist.js';
    hoisted.existsSync = () => false;

    expect(() => resolveDkgCli()).toThrow(/DKG_CLI_PATH/);
  });

  it('falls back to require.resolve when the override is unset', () => {
    const resolved = '/global/node_modules/@origintrail-official/dkg/dist/cli.js';
    hoisted.requireResolve = (spec) => {
      if (spec === '@origintrail-official/dkg') return resolved;
      throw new Error(`unexpected specifier ${spec}`);
    };
    hoisted.existsSync = (p) => p === resolved;

    const result = resolveDkgCli();

    expect(result.node).toBe(process.execPath);
    expect(result.cliPath).toBe(resolved);
  });

  it('falls back to process.argv[1] when no earlier arm resolves', () => {
    const argv1 = '/clone/packages/cli/dist/cli.js';
    process.argv[1] = argv1;
    hoisted.requireResolve = null;
    hoisted.resolveCliPackageDir = () => null;
    hoisted.existsSync = (p) => p === argv1;

    const result = resolveDkgCli();

    expect(result.cliPath).toBe(argv1);
  });

  it('ignores argv[1] when it does not point at cli.js', () => {
    process.argv[1] = '/some/other/script.js';
    hoisted.requireResolve = null;
    hoisted.resolveCliPackageDir = () => null;
    hoisted.existsSync = () => true;

    expect(() => resolveDkgCli()).toThrow(/Could not resolve the DKG CLI entrypoint/);
  });

  it('throws a clear error mentioning DKG_CLI_PATH when nothing resolves', () => {
    process.argv[1] = '/usr/bin/node';
    hoisted.requireResolve = null;
    hoisted.resolveCliPackageDir = () => null;
    hoisted.existsSync = () => false;

    expect(() => resolveDkgCli()).toThrow(/DKG_CLI_PATH/);
  });

  it('treats an empty or whitespace-only DKG_CLI_PATH as unset', () => {
    process.env.DKG_CLI_PATH = '   ';
    const argv1 = '/clone/packages/cli/dist/cli.js';
    process.argv[1] = argv1;
    hoisted.existsSync = (p) => p === argv1;

    const result = resolveDkgCli();

    expect(result.cliPath).toBe(argv1);
  });

  it('falls through to resolveCliPackageDir when require.resolve returns a stale path', () => {
    const stalePath = '/uninstalled/@origintrail-official/dkg/dist/cli.js';
    const cliPkgDir = '/global/lib/node_modules/@origintrail-official/dkg';
    const cliEntry = join(cliPkgDir, 'dist', 'cli.js');
    hoisted.requireResolve = () => stalePath;
    hoisted.resolveCliPackageDir = () => cliPkgDir;
    hoisted.existsSync = (p) => p === cliEntry;

    const result = resolveDkgCli();

    expect(result.cliPath).toBe(cliEntry);
  });

  it('always returns process.execPath as the node field, including on argv[1] fallback', () => {
    const argv1 = '/clone/packages/cli/dist/cli.js';
    process.argv[1] = argv1;
    hoisted.requireResolve = null;
    hoisted.resolveCliPackageDir = () => null;
    hoisted.existsSync = (p) => p === argv1;

    const result = resolveDkgCli();

    expect(result.node).toBe(process.execPath);
  });

  // ---------------------------------------------------------------------------
  // Arm 3 — resolveCliPackageDir() + dist/cli.js
  // Added during PR #260 review round 1 (Codex comment on resolve-dkg-cli.ts).
  // ---------------------------------------------------------------------------

  it('arm 3: returns resolveCliPackageDir() + dist/cli.js when env and require.resolve fail', () => {
    const cliPkgDir = '/usr/lib/node_modules/@origintrail-official/dkg';
    const cliEntry = join(cliPkgDir, 'dist', 'cli.js');
    hoisted.requireResolve = null;
    hoisted.resolveCliPackageDir = () => cliPkgDir;
    hoisted.existsSync = (p) => p === cliEntry;

    const result = resolveDkgCli();

    expect(result.node).toBe(process.execPath);
    expect(result.cliPath).toBe(cliEntry);
  });

  it('arm 3 miss: falls through to argv[1] when dist/cli.js is missing under the package dir', () => {
    const cliPkgDir = '/usr/lib/node_modules/@origintrail-official/dkg';
    const argv1 = '/clone/packages/cli/dist/cli.js';
    process.argv[1] = argv1;
    hoisted.requireResolve = null;
    hoisted.resolveCliPackageDir = () => cliPkgDir;
    // Everything under cliPkgDir returns false; only argv1 exists.
    hoisted.existsSync = (p) => p === argv1;

    const result = resolveDkgCli();

    expect(result.cliPath).toBe(argv1);
  });

  it('arm 3 null: falls through to argv[1] when resolveCliPackageDir returns null', () => {
    const argv1 = '/clone/packages/cli/dist/cli.js';
    process.argv[1] = argv1;
    hoisted.requireResolve = null;
    hoisted.resolveCliPackageDir = () => null;
    hoisted.existsSync = (p) => p === argv1;

    const result = resolveDkgCli();

    expect(result.cliPath).toBe(argv1);
  });

  // ---------------------------------------------------------------------------
  // Narrowed require.resolve catch — only swallow MODULE_NOT_FOUND /
  // ERR_MODULE_NOT_FOUND; surface everything else (corrupted install,
  // filesystem perms, etc.) rather than hiding it behind the fallback arms.
  // ---------------------------------------------------------------------------

  it('narrowed catch: MODULE_NOT_FOUND falls through cleanly', () => {
    const cliPkgDir = '/usr/lib/node_modules/@origintrail-official/dkg';
    const cliEntry = join(cliPkgDir, 'dist', 'cli.js');
    const err = new Error("Cannot find module '@origintrail-official/dkg'") as Error & { code?: string };
    err.code = 'MODULE_NOT_FOUND';
    hoisted.requireResolveError = err;
    hoisted.resolveCliPackageDir = () => cliPkgDir;
    hoisted.existsSync = (p) => p === cliEntry;

    const result = resolveDkgCli();

    expect(result.cliPath).toBe(cliEntry);
  });

  it('narrowed catch: ERR_MODULE_NOT_FOUND also falls through cleanly', () => {
    const cliPkgDir = '/usr/lib/node_modules/@origintrail-official/dkg';
    const cliEntry = join(cliPkgDir, 'dist', 'cli.js');
    const err = new Error('Cannot find package …') as Error & { code?: string };
    err.code = 'ERR_MODULE_NOT_FOUND';
    hoisted.requireResolveError = err;
    hoisted.resolveCliPackageDir = () => cliPkgDir;
    hoisted.existsSync = (p) => p === cliEntry;

    const result = resolveDkgCli();

    expect(result.cliPath).toBe(cliEntry);
  });

  it('narrowed catch: EACCES rethrows instead of silently falling through', () => {
    const err = new Error('permission denied') as Error & { code?: string };
    err.code = 'EACCES';
    hoisted.requireResolveError = err;
    // Set up downstream arms as if they would succeed — to prove the catch
    // did not swallow the real error and quietly continue.
    const cliPkgDir = '/usr/lib/node_modules/@origintrail-official/dkg';
    const cliEntry = join(cliPkgDir, 'dist', 'cli.js');
    hoisted.resolveCliPackageDir = () => cliPkgDir;
    hoisted.existsSync = (p) => p === cliEntry;

    expect(() => resolveDkgCli()).toThrow(/permission denied|EACCES/);
  });

  it('narrowed catch: a plain Error (no code) rethrows', () => {
    hoisted.requireResolveError = new Error('unexpected resolver failure') as Error & { code?: string };
    // Downstream arms would otherwise succeed — proves rethrow.
    const cliPkgDir = '/usr/lib/node_modules/@origintrail-official/dkg';
    const cliEntry = join(cliPkgDir, 'dist', 'cli.js');
    hoisted.resolveCliPackageDir = () => cliPkgDir;
    hoisted.existsSync = (p) => p === cliEntry;

    expect(() => resolveDkgCli()).toThrow(/unexpected resolver failure/);
  });
});
