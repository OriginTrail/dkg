import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  existsSync: (_p: string): boolean => false,
  requireResolve: null as null | ((specifier: string) => string),
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

  it('falls back to process.argv[1] when require.resolve cannot find the CLI', () => {
    const argv1 = '/clone/packages/cli/dist/cli.js';
    process.argv[1] = argv1;
    hoisted.requireResolve = null;
    hoisted.existsSync = (p) => p === argv1;

    const result = resolveDkgCli();

    expect(result.cliPath).toBe(argv1);
  });

  it('ignores argv[1] when it does not point at cli.js', () => {
    process.argv[1] = '/some/other/script.js';
    hoisted.requireResolve = null;
    hoisted.existsSync = () => true;

    expect(() => resolveDkgCli()).toThrow(/Could not resolve the DKG CLI entrypoint/);
  });

  it('throws a clear error mentioning DKG_CLI_PATH when nothing resolves', () => {
    process.argv[1] = '/usr/bin/node';
    hoisted.requireResolve = null;
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

  it('falls through to argv[1] when require.resolve returns a stale path', () => {
    const stalePath = '/uninstalled/@origintrail-official/dkg/dist/cli.js';
    const argv1 = '/clone/packages/cli/dist/cli.js';
    process.argv[1] = argv1;
    hoisted.requireResolve = () => stalePath;
    hoisted.existsSync = (p) => p === argv1;

    const result = resolveDkgCli();

    expect(result.cliPath).toBe(argv1);
  });

  it('falls through when require.resolve throws a non-MODULE_NOT_FOUND error', () => {
    const argv1 = '/clone/packages/cli/dist/cli.js';
    process.argv[1] = argv1;
    hoisted.requireResolve = () => {
      throw new Error('unexpected resolver failure');
    };
    hoisted.existsSync = (p) => p === argv1;

    const result = resolveDkgCli();

    expect(result.cliPath).toBe(argv1);
  });

  it('always returns process.execPath as the node field, including on argv[1] fallback', () => {
    const argv1 = '/clone/packages/cli/dist/cli.js';
    process.argv[1] = argv1;
    hoisted.requireResolve = null;
    hoisted.existsSync = (p) => p === argv1;

    const result = resolveDkgCli();

    expect(result.node).toBe(process.execPath);
  });
});
