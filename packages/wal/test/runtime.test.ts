import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Server } from 'node:net';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WAL_ADAPTER_VERSION,
  WAL_PROTOCOL_VERSION,
  WAL_RUNTIME_ROOT_DIRECTORY,
  WalRuntime,
  WalRuntimeError,
  createWalRuntime,
  disabledWalRuntimeStatus,
  parseWalSyncMode,
  resolveWalRuntimeConfiguration,
} from '../src/runtime.js';

describe('WAL runtime configuration', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function home(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'dkg-wal-runtime-config-'));
    return root;
  }

  it('defaults to legacy mode and fixed isolated directories', async () => {
    const dkgHome = await home();
    const resolved = resolveWalRuntimeConfiguration({ dkgHome });
    expect(resolved).toEqual({
      mode: 'legacy',
      protocolVersion: WAL_PROTOCOL_VERSION,
      adapterVersion: WAL_ADAPTER_VERSION,
      cutoverId: undefined,
      localAuthoring: undefined,
      paths: {
        root: join(dkgHome, WAL_RUNTIME_ROOT_DIRECTORY),
        objectStore: join(dkgHome, WAL_RUNTIME_ROOT_DIRECTORY, 'objects'),
        rangeStaging: join(dkgHome, WAL_RUNTIME_ROOT_DIRECTORY, 'range-staging'),
        quarantine: join(dkgHome, WAL_RUNTIME_ROOT_DIRECTORY, 'quarantine'),
        shadowRdf: join(dkgHome, WAL_RUNTIME_ROOT_DIRECTORY, 'shadow-rdf'),
        control: join(dkgHome, WAL_RUNTIME_ROOT_DIRECTORY, 'control'),
      },
    });
    expect(createWalRuntime(resolved)).toBeNull();
    expect(existsSync(join(dkgHome, WAL_RUNTIME_ROOT_DIRECTORY))).toBe(false);
  });

  it('accepts every mode and lets an explicit CLI override win', async () => {
    const dkgHome = await home();
    expect(['legacy', 'parallel', 'wal'].map(parseWalSyncMode)).toEqual(['legacy', 'parallel', 'wal']);
    expect(resolveWalRuntimeConfiguration({
      dkgHome,
      sync: { mode: 'legacy' },
      modeOverride: 'parallel',
    }).mode).toBe('parallel');
  });

  it.each([
    [{ sync: null }, 'WAL_INVALID_SYNC_CONFIGURATION'],
    [{ sync: [] }, 'WAL_INVALID_SYNC_CONFIGURATION'],
    [{ sync: { mode: 'future' } }, 'WAL_INVALID_SYNC_MODE'],
    [{ sync: { wal: 'bad' } }, 'WAL_INVALID_RUNTIME_CONFIGURATION'],
    [{ sync: { wal: { paths: [] } } }, 'WAL_INVALID_RUNTIME_CONFIGURATION'],
    [{ sync: { wal: { protocolVersion: 2 } } }, 'WAL_UNSUPPORTED_PROTOCOL_VERSION'],
    [{ sync: { wal: { adapterVersion: '1' } } }, 'WAL_UNSUPPORTED_ADAPTER_VERSION'],
    [{ sync: { wal: { cutoverId: null } } }, 'WAL_INVALID_CUTOVER_ID'],
    [{ sync: { wal: { cutoverId: 'A'.repeat(64) } } }, 'WAL_INVALID_CUTOVER_ID'],
    [{ sync: { wal: { localAuthoring: 'bad' } } }, 'WAL_INVALID_LOCAL_AUTHORING_CONFIGURATION'],
    [{ sync: { wal: { localAuthoring: {} } } }, 'WAL_INVALID_LOCAL_AUTHORING_CONFIGURATION'],
    [{ sync: { wal: { localAuthoring: { bundlePath: '', curatorAuthoritySetId: '01'.repeat(32) } } } }, 'WAL_INVALID_LOCAL_AUTHORING_CONFIGURATION'],
    [{ sync: { wal: { localAuthoring: { bundlePath: 'bundle.json', curatorAuthoritySetId: 'A'.repeat(64) } } } }, 'WAL_INVALID_LOCAL_AUTHORING_CONFIGURATION'],
    [{ sync: { wal: { paths: { objectStore: 1 } } } }, 'WAL_INVALID_PATH'],
    [{ sync: { wal: { paths: { objectStore: '  ' } } } }, 'WAL_INVALID_PATH'],
  ])('rejects malformed configuration %# with a stable reason', async (value, code) => {
    const dkgHome = await home();
    expect(() => resolveWalRuntimeConfiguration({ dkgHome, ...value })).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it('rejects component paths outside or equal to the fixed WAL root', async () => {
    const dkgHome = await home();
    for (const objectStore of ['.', join(dkgHome, 'store.nq')]) {
      expect(() => resolveWalRuntimeConfiguration({
        dkgHome,
        sync: { wal: { paths: { objectStore } } },
      })).toThrow(expect.objectContaining({ code: 'WAL_PATH_OUTSIDE_ROOT' }));
    }
  });

  it('rejects equal, descendant, and ancestor component overlaps', async () => {
    const dkgHome = await home();
    const cases = [
      { objectStore: 'same', quarantine: 'same' },
      { objectStore: 'nested', quarantine: `nested${sep}child` },
      { objectStore: `outer${sep}child`, quarantine: 'outer' },
    ];
    for (const paths of cases) {
      expect(() => resolveWalRuntimeConfiguration({
        dkgHome,
        sync: { wal: { paths } },
      })).toThrow(expect.objectContaining({ code: 'WAL_PATH_OVERLAP' }));
    }
  });

  it('resolves an explicit signed local-authoring evidence bundle below the WAL root', async () => {
    const dkgHome = await home();
    const curatorAuthoritySetId = '01'.repeat(32);
    const resolved = resolveWalRuntimeConfiguration({
      dkgHome,
      sync: {
        mode: 'parallel',
        wal: { localAuthoring: { bundlePath: 'local-authoring.json', curatorAuthoritySetId } },
      },
    });
    expect(resolved.localAuthoring).toEqual({
      bundlePath: join(dkgHome, WAL_RUNTIME_ROOT_DIRECTORY, 'local-authoring.json'),
      curatorAuthoritySetId,
    });
    for (const bundlePath of ['.', '../outside.json', 'objects/bundle.json']) {
      expect(() => resolveWalRuntimeConfiguration({
        dkgHome,
        sync: {
          wal: { localAuthoring: { bundlePath, curatorAuthoritySetId } },
        },
      })).toThrow(expect.objectContaining({
        code: bundlePath === 'objects/bundle.json' ? 'WAL_PATH_OVERLAP' : 'WAL_PATH_OUTSIDE_ROOT',
      }));
    }
  });
});

describe('WAL runtime lifecycle', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function configuration(mode: 'legacy' | 'parallel' | 'wal', cutoverId?: string) {
    const root = await mkdtemp(join(tmpdir(), 'dkg-wal-runtime-lifecycle-'));
    roots.push(root);
    return resolveWalRuntimeConfiguration({
      dkgHome: root,
      sync: { mode, wal: cutoverId ? { cutoverId } : undefined },
    });
  }

  it('reports the disabled legacy contract without paths, protocols, or workers', () => {
    expect(disabledWalRuntimeStatus()).toEqual({
      mode: 'legacy',
      lifecycle: 'disabled',
      ready: true,
      synchronizationAuthority: 'legacy',
      shadowEnabled: false,
      runtimeRegistered: false,
      protocolsRegistered: false,
      workersActive: 0,
      protocolVersion: 1,
      adapterVersion: 1,
      paths: null,
      blockedReason: null,
    });
  });

  it('forbids constructing a legacy runtime', async () => {
    const resolved = await configuration('legacy');
    expect(() => new WalRuntime(resolved)).toThrow(
      expect.objectContaining({ code: 'WAL_LEGACY_RUNTIME_FORBIDDEN' }),
    );
  });

  it('starts, drains, stops, and restarts parallel shadow state without workers or protocols', async () => {
    const listenSpy = vi.spyOn(Server.prototype, 'listen');
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const resolved = await configuration('parallel');
    const runtime = createWalRuntime(resolved)!;
    expect(runtime.status()).toMatchObject({ lifecycle: 'created', ready: false });
    const ready = await runtime.start();
    expect(ready).toMatchObject({
      mode: 'parallel',
      lifecycle: 'ready',
      ready: true,
      synchronizationAuthority: 'legacy',
      shadowEnabled: true,
      runtimeRegistered: true,
      protocolsRegistered: false,
      workersActive: 0,
      blockedReason: null,
    });
    expect(await runtime.start()).toEqual(ready);
    for (const path of Object.values(resolved.paths)) expect(existsSync(path)).toBe(true);
    expect(await runtime.replay()).toEqual({ pending: 0 });
    expect(runtime.localWriter()).toBeDefined();
    expect(runtime.localControlStore()).toBeDefined();
    expect(runtime.localObjectStore()).toBeDefined();
    expect((await runtime.drain()).lifecycle).toBe('draining');
    expect((await runtime.drain()).lifecycle).toBe('draining');
    expect(await runtime.replay()).toEqual({ pending: 0 });
    expect((await runtime.stop()).lifecycle).toBe('stopped');
    expect((await runtime.stop()).lifecycle).toBe('stopped');
    expect(listenSpy).not.toHaveBeenCalled();
    expect(intervalSpy).not.toHaveBeenCalled();
    await expect(runtime.replay()).rejects.toMatchObject({ code: 'WAL_RUNTIME_NOT_READY' });
    expect(() => runtime.localWriter()).toThrow(expect.objectContaining({ code: 'WAL_RUNTIME_NOT_READY' }));
    expect(() => runtime.localControlStore()).toThrow(expect.objectContaining({ code: 'WAL_RUNTIME_NOT_READY' }));
    expect(() => runtime.localObjectStore()).toThrow(expect.objectContaining({ code: 'WAL_RUNTIME_NOT_READY' }));
    await expect(runtime.start()).rejects.toMatchObject({ code: 'WAL_RUNTIME_STOPPED' });

    const persisted = JSON.parse(await readFile(join(resolved.paths.control, 'runtime.json'), 'utf8'));
    expect(persisted).toEqual({ mode: 'parallel', protocolVersion: 1, adapterVersion: 1, lifecycle: 'stopped' });

    const restarted = createWalRuntime(resolved)!;
    expect((await restarted.start()).lifecycle).toBe('ready');
    await restarted.stop();
  });

  it('stops an unstarted controller without creating state and leaves drain idempotent', async () => {
    const resolved = await configuration('parallel');
    const runtime = createWalRuntime(resolved)!;
    expect((await runtime.drain()).lifecycle).toBe('created');
    await expect(runtime.replay()).rejects.toMatchObject({ code: 'WAL_RUNTIME_NOT_READY' });
    expect((await runtime.stop()).lifecycle).toBe('stopped');
    expect(existsSync(resolved.paths.root)).toBe(false);
  });

  it('tracks daemon-owned protocol registration and unregisters it before stop', async () => {
    const resolved = await configuration('parallel');
    const runtime = createWalRuntime(resolved)!;
    expect(() => runtime.registerProtocols(() => {})).toThrowError(expect.objectContaining({
      code: 'WAL_RUNTIME_NOT_READY',
    }));
    await runtime.start();
    expect(() => runtime.registerProtocols(undefined as never)).toThrowError(expect.objectContaining({
      code: 'WAL_INVALID_RUNTIME_CONFIGURATION',
    }));
    const unregister = vi.fn();
    const release = runtime.registerProtocols(unregister);
    expect(runtime.status().protocolsRegistered).toBe(true);
    expect(() => runtime.registerProtocols(() => {})).toThrowError(expect.objectContaining({
      code: 'WAL_RUNTIME_BLOCKED',
    }));
    release();
    release();
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(runtime.status().protocolsRegistered).toBe(false);

    const unregisterAtStop = vi.fn();
    runtime.registerProtocols(unregisterAtStop);
    await runtime.stop();
    expect(unregisterAtStop).toHaveBeenCalledTimes(1);
    expect(runtime.status().protocolsRegistered).toBe(false);
  });

  it('rejects a symlinked WAL root before writing through it', async () => {
    const resolved = await configuration('parallel');
    const outside = await mkdtemp(join(tmpdir(), 'dkg-wal-runtime-outside-'));
    try {
      await symlink(outside, resolved.paths.root);
      const runtime = createWalRuntime(resolved)!;
      await expect(runtime.start()).rejects.toMatchObject({ code: 'WAL_PATH_SYMLINK' });
      expect(runtime.status()).toMatchObject({
        lifecycle: 'blocked',
        blockedReason: { code: 'WAL_PATH_SYMLINK' },
      });
      await expect(runtime.start()).rejects.toMatchObject({ code: 'WAL_RUNTIME_BLOCKED' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('fails wal authority closed without every cutover prerequisite', async () => {
    const missing = createWalRuntime(await configuration('wal'))!;
    expect(missing.status().synchronizationAuthority).toBe('legacy');
    await expect(missing.start()).rejects.toMatchObject({ code: 'WAL_CUTOVER_ID_REQUIRED' });
    expect(missing.status()).toMatchObject({ synchronizationAuthority: 'legacy', lifecycle: 'blocked' });

    const id = 'ab'.repeat(32);
    const unavailable = createWalRuntime(await configuration('wal', id))!;
    await expect(unavailable.start()).rejects.toMatchObject({ code: 'WAL_CUTOVER_VERIFIER_UNAVAILABLE' });

    const rejected = createWalRuntime(await configuration('wal', id), async () => false)!;
    await expect(rejected.start()).rejects.toMatchObject({ code: 'WAL_CUTOVER_VERIFICATION_FAILED' });
  });

  it('can enter wal authority only through an injected successful signed-cutover verifier', async () => {
    const id = 'cd'.repeat(32);
    const resolved = await configuration('wal', id);
    const runtime = createWalRuntime(resolved, async (cutoverId, received) => {
      expect(cutoverId).toBe(id);
      expect(received).toBe(resolved);
      return true;
    })!;
    expect(await runtime.start()).toMatchObject({
      lifecycle: 'ready',
      synchronizationAuthority: 'wal',
      shadowEnabled: false,
    });
    await runtime.stop();
  });

  it('records unexpected verifier failures as stable blocked state', async () => {
    const id = 'ef'.repeat(32);
    const errorRuntime = createWalRuntime(await configuration('wal', id), async () => {
      throw new Error('verifier unavailable');
    })!;
    await expect(errorRuntime.start()).rejects.toMatchObject({ code: 'WAL_RUNTIME_START_FAILED' });
    expect(errorRuntime.status().blockedReason).toEqual({
      code: 'WAL_RUNTIME_START_FAILED',
      message: 'WAL runtime start failed: verifier unavailable',
    });

    const stringRuntime = createWalRuntime(await configuration('wal', id), async () => {
      throw 'opaque verifier failure';
    })!;
    await expect(stringRuntime.start()).rejects.toMatchObject({ code: 'WAL_RUNTIME_START_FAILED' });
    expect(stringRuntime.status().blockedReason).toEqual({
      code: 'WAL_RUNTIME_START_FAILED',
      message: 'WAL runtime start failed: opaque verifier failure',
    });
  });

  it('exposes stable error identity', () => {
    const error = new WalRuntimeError('WAL_INVALID_SYNC_MODE', 'bad mode');
    expect(error.name).toBe('WalRuntimeError');
    expect(error.code).toBe('WAL_INVALID_SYNC_MODE');
  });
});
