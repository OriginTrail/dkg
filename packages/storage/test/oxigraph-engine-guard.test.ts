import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyEngineGuard } from '../src/adapters/oxigraph-engine-guard.js';

const FLAG = '--no-turbo-inline-js-wasm-calls';
// Node.js 24 has the engine's own fix, so there the store changes nothing and nothing stops.
const AFFECTED = Number.parseInt(process.versions.node, 10) < 24;
const CHILD = fileURLToPath(new URL('./fixtures/engine-guard-child.mjs', import.meta.url));
const BUILT_PACKAGE = fileURLToPath(new URL('../dist/index.js', import.meta.url));

type ChildOptions = {
  call: 'externref' | 'i32' | 'quad-getter';
  store: 'none' | 'loaded' | 'before-optimizing' | 'after-optimizing' | 'store-thread';
  thread?: boolean;
  inliningOff?: boolean;
};

function runChild(options: ChildOptions, { frozenFlags = false } = {}) {
  const env = { ...process.env };
  // Coverage and preloads change what the compiler does; this is about what it does by itself.
  delete env.NODE_OPTIONS;
  delete env.NODE_V8_COVERAGE;
  const childCommand = frozenFlags
    ? ['--freeze-flags-after-init', '--allow-natives-syntax', '--no-maglev', '--no-lazy-feedback-allocation', CHILD, JSON.stringify(options)]
    : ['--allow-natives-syntax', '--no-maglev', '--no-lazy-feedback-allocation', CHILD, JSON.stringify(options)];
  const run = spawnSync(process.execPath, childCommand, { encoding: 'utf8', timeout: 60_000, env });
  const report = run.stdout.split('\n').find((line) => line.startsWith('{'));
  return { run, report: report ? JSON.parse(report) as { optimized: boolean; deoptimized: boolean; value: number; logged: string[] } : null };
}

function expectStopped({ run, report }: ReturnType<typeof runChild>) {
  expect(report).toBeNull();
  expect(run.status).toBeNull();
  expect(run.stderr).toContain('# unreachable code');
}

/** It ran on with the right result, and on an affected engine it did so through the path this is about. */
function expectRanOn({ run, report }: ReturnType<typeof runChild>, value: number) {
  expect(run.stderr).not.toContain('# unreachable code');
  expect(report, run.stderr).not.toBeNull();
  expect(report!.value).toBe(value);
  if (AFFECTED) expect(report).toMatchObject({ optimized: true, deoptimized: true });
}

function expectStoppedIfAffected(child: ReturnType<typeof runChild>, value: number) {
  if (AFFECTED) expectStopped(child);
  else expectRanOn(child, value);
}

const turnedOff = expect.stringContaining('[oxigraph] Turned off');

describe('the engine error this guards against', () => {
  it('a reference returned by an inlined call into WebAssembly stops a process when the optimized code is invalidated during the call', () => {
    expectStoppedIfAffected(runChild({ call: 'externref', store: 'none' }), 2);
  });

  it('a number returned by the same call does not', () => {
    expectRanOn(runChild({ call: 'i32', store: 'none' }), 9);
  });

  it("Oxigraph's own Quad getter is such a call, also on a worker thread", () => {
    expectStoppedIfAffected(runChild({ call: 'quad-getter', store: 'none' }), 2);
    expectStoppedIfAffected(runChild({ call: 'quad-getter', store: 'none', thread: true }), 2);
  });

  it('turning the inlining off avoids it: the code still deoptimizes, and the result is right', () => {
    expectRanOn(runChild({ call: 'externref', store: 'none', inliningOff: true }), 2);
    expectRanOn(runChild({ call: 'quad-getter', store: 'none', inliningOff: true }), 2);
  });
});

describe('an embedded store avoids it for its whole process', () => {
  beforeAll(() => {
    if (!existsSync(BUILT_PACKAGE)) {
      throw new Error('These run the built package: run `pnpm --filter @origintrail-official/dkg-storage build` first.');
    }
  });

  function expectLoggedOnceIfAffected(report: { logged: string[] } | null) {
    expect(report!.logged).toEqual(AFFECTED ? [turnedOff] : []);
  }

  it('a store opened on this thread covers code optimized after it', () => {
    for (const call of ['externref', 'quad-getter'] as const) {
      const child = runChild({ call, store: 'before-optimizing' });
      expectRanOn(child, 2);
      expectLoggedOnceIfAffected(child.report);
    }
  });

  it('a store opened on a worker thread covers that thread, where a daemon reads its quads', () => {
    for (const call of ['externref', 'quad-getter'] as const) {
      const child = runChild({ call, store: 'before-optimizing', thread: true });
      expectRanOn(child, 2);
      expectLoggedOnceIfAffected(child.report);
    }
  });

  it("a daemon's store thread covers the other threads too, and its line reaches a log kept by wrapping stderr", () => {
    const child = runChild({ call: 'externref', store: 'store-thread' });
    expectRanOn(child, 2);
    expectLoggedOnceIfAffected(child.report);
  });

  it('code optimized before the store opened is not covered, which is why the store does this before it opens', () => {
    const child = runChild({ call: 'externref', store: 'after-optimizing' });
    expectStoppedIfAffected(child, 2);
    if (AFFECTED) expect(child.run.stderr).toContain('[oxigraph] Turned off');
  });

  it('flags frozen on the command line leave a working store and a warning, on any thread: setting one then would stop the process', () => {
    for (const child of [
      runChild({ call: 'i32', store: 'before-optimizing' }, { frozenFlags: true }),
      runChild({ call: 'i32', store: 'store-thread' }, { frozenFlags: true }),
    ]) {
      expectRanOn(child, 9);
      expect(child.report!.logged).toEqual(AFFECTED ? [expect.stringContaining('[oxigraph] WARNING: could not turn off')] : []);
      if (AFFECTED) expect(child.report!.logged[0]).toContain('--freeze-flags-after-init');
    }
  });

  it('loading this package with no embedded store open changes nothing, as on any other backend', () => {
    const child = runChild({ call: 'externref', store: 'loaded' });
    expectStoppedIfAffected(child, 2);
    expect(child.run.stderr).not.toContain('[oxigraph]');
  });
});

describe('applyEngineGuard', () => {
  function apply(nodeVersion: string, setEngineFlag: (flag: string) => void = () => {}, execArgv: string[] = []) {
    const flags: string[] = [];
    const lines: string[] = [];
    const outcome = applyEngineGuard({
      nodeVersion,
      execArgv,
      setEngineFlag: (flag) => {
        flags.push(flag);
        setEngineFlag(flag);
      },
      say: (line) => lines.push(line),
    });
    return { outcome, flags, lines };
  }

  it.each(['20.18.1', '22.23.4', '23.5.0'])('turns the inlining off on Node.js %s and says so in one line', (version) => {
    const { outcome, flags, lines } = apply(version);
    expect(outcome).toBe('applied');
    expect(flags).toEqual([FLAG]);
    expect(lines).toEqual([expect.stringContaining(`[oxigraph] Turned off V8's inlining of calls into WebAssembly (${FLAG})`)]);
    expect(lines[0]).toContain(`Node.js ${version}`);
  });

  it.each(['24.0.0', '24.5.0', '26.7.0', 'not a version'])('touches nothing on %s', (version) => {
    expect(apply(version)).toEqual({ outcome: 'not-needed', flags: [], lines: [] });
  });

  it('a flag that cannot be set is a warning, not a failure', () => {
    const { outcome, lines } = apply('22.23.4', () => {
      throw new Error('flags are frozen');
    });
    expect(outcome).toBe('failed');
    expect(lines).toEqual([expect.stringContaining('[oxigraph] WARNING: could not turn off')]);
    expect(lines[0]).toContain('flags are frozen');
    expect(lines[0]).toContain('The embedded store still runs');
  });

  it.each([
    [['--freeze-flags-after-init']],
    [['--freeze_flags_after_init']],
    [['--no-freeze-flags-after-init', '--freeze-flags-after-init']],
    [['--expose-gc', '--freeze-flags-after-init', '--max-old-space-size=4096']],
  ])('does not try to set a flag when %j froze them', (execArgv) => {
    const { outcome, flags, lines } = apply('22.23.4', () => {}, execArgv);
    expect(outcome).toBe('failed');
    expect(flags).toEqual([]);
    expect(lines).toEqual([expect.stringContaining('[oxigraph] WARNING: could not turn off')]);
    expect(lines[0]).toContain('--freeze-flags-after-init');
    expect(lines[0]).toContain('unless the process starts with that flag');
  });

  it.each([
    [['--no-freeze-flags-after-init']],
    [['--nofreeze_flags_after_init']],
    [['--freeze-flags-after-init', '--no-freeze-flags-after-init']],
    [['--freeze-flags-after-init-not-this-one']],
  ])('sets it when %j did not', (execArgv) => {
    expect(apply('22.23.4', () => {}, execArgv)).toMatchObject({ outcome: 'applied', flags: [FLAG] });
  });

  it('frozen flags are not its concern on a fixed Node.js', () => {
    expect(apply('24.5.0', () => {}, ['--freeze-flags-after-init'])).toEqual({ outcome: 'not-needed', flags: [], lines: [] });
  });

  it('says what was thrown, whatever it was', () => {
    const { lines } = apply('22.23.4', () => {
      throw 'not an Error';
    });
    expect(lines[0]).toContain('not an Error');
  });
});

describe('OxigraphStore and the guard', () => {
  afterEach(() => {
    vi.doUnmock('node:v8');
    vi.doUnmock('oxigraph');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  /** The adapter, loaded afresh, with what it does to the engine and to Oxigraph recorded in order; `stderr` is what it wrote. */
  async function loadAdapter(setFlag: () => void = () => {}) {
    const order: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    vi.resetModules();
    vi.doMock('node:v8', async () => {
      const actual = await vi.importActual<typeof import('node:v8')>('node:v8');
      return {
        ...actual,
        default: {
          ...actual.default,
          setFlagsFromString: (flag: string) => {
            order.push(`flag ${flag}`);
            setFlag();
          },
        },
      };
    });
    vi.doMock('oxigraph', async () => {
      const actual = await vi.importActual<{ default: { Store: new (...args: unknown[]) => object } }>('oxigraph');
      class Store extends actual.default.Store {
        constructor(...args: unknown[]) {
          order.push('store');
          super(...args);
        }
      }
      return { ...actual, default: { ...actual.default, Store } };
    });
    const { OxigraphStore } = await import('../src/adapters/oxigraph.js');
    return { OxigraphStore, order, stderr };
  }

  it('does nothing when the adapter only loads', async () => {
    const { order, stderr } = await loadAdapter();
    expect(order).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it('sets the flag before the first store opens, and once', async () => {
    const { OxigraphStore, order, stderr } = await loadAdapter();
    new OxigraphStore();
    new OxigraphStore();
    expect(order).toEqual(AFFECTED ? [`flag ${FLAG}`, 'store', 'store'] : ['store', 'store']);
    expect(stderr.filter((line) => line.includes('[oxigraph]'))).toEqual(AFFECTED ? [turnedOff] : []);
  });

  it("reads the process's real arguments, so flags frozen there are never tried", async () => {
    const { OxigraphStore, order, stderr } = await loadAdapter();
    const execArgv = process.execArgv;
    process.execArgv = [...execArgv, '--freeze-flags-after-init'];
    try {
      new OxigraphStore();
    } finally {
      process.execArgv = execArgv;
    }
    expect(order).toEqual(['store']);
    expect(stderr.filter((line) => line.includes('[oxigraph]')))
      .toEqual(AFFECTED ? [expect.stringContaining('this process started with --freeze-flags-after-init')] : []);
  });

  it('a flag that cannot be set leaves a working store, and a warning', async () => {
    const { OxigraphStore, stderr } = await loadAdapter(() => {
      throw new Error('flags are frozen');
    });
    const store = new OxigraphStore();
    const quad = { subject: 'urn:s', predicate: 'urn:p', object: '"o"', graph: 'urn:g' };
    await store.insert([quad]);
    const answer = await store.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <urn:g> { ?s ?p ?o } }');
    expect(answer).toMatchObject({ type: 'quads', quads: [{ subject: 'urn:s', predicate: 'urn:p', object: '"o"' }] });
    await store.close();
    expect(stderr.filter((line) => line.includes('[oxigraph]')))
      .toEqual(AFFECTED ? [expect.stringContaining('[oxigraph] WARNING: could not turn off')] : []);
  });
});
