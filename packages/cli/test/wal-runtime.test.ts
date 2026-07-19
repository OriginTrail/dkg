import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { registerLifecycleCommands } from '../src/commands/lifecycle.js';
import {
  WAL_SYNC_MODE_ENV,
  applyWalSyncModeOverride,
  daemonWalRuntimeStatus,
  resolveDaemonWalRuntimeConfiguration,
  startDaemonWalRuntime,
} from '../src/wal-runtime.js';

describe('daemon WAL runtime wiring', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function home(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'dkg-cli-wal-runtime-'));
    roots.push(path);
    return path;
  }

  it('registers the explicit run-only sync mode CLI option', () => {
    const program = new Command();
    registerLifecycleCommands(program);
    const start = program.commands.find(command => command.name() === 'start');
    expect(start?.options.some(option => option.long === '--sync-mode')).toBe(true);
  });

  it('applies and clears the run-only CLI mode override', () => {
    const env: NodeJS.ProcessEnv = { [WAL_SYNC_MODE_ENV]: 'parallel' };
    expect(applyWalSyncModeOverride(env, 'legacy')).toBe('legacy');
    expect(env[WAL_SYNC_MODE_ENV]).toBe('legacy');
    expect(applyWalSyncModeOverride(env, undefined)).toBeNull();
    expect(env[WAL_SYNC_MODE_ENV]).toBeUndefined();
    expect(applyWalSyncModeOverride(env, null)).toBeNull();
    expect(applyWalSyncModeOverride(env, '')).toBeNull();
    expect(() => applyWalSyncModeOverride(env, 'invalid')).toThrow(
      expect.objectContaining({ code: 'WAL_INVALID_SYNC_MODE' }),
    );
  });

  it('resolves persisted sync.mode and gives a nonblank environment override precedence', async () => {
    const dkgHome = await home();
    expect(resolveDaemonWalRuntimeConfiguration({ sync: { mode: 'parallel' } }, dkgHome, {}).mode).toBe('parallel');
    expect(resolveDaemonWalRuntimeConfiguration(
      { sync: { mode: 'parallel' } },
      dkgHome,
      { [WAL_SYNC_MODE_ENV]: ' legacy ' },
    ).mode).toBe('legacy');
    expect(resolveDaemonWalRuntimeConfiguration(
      { sync: { mode: 'parallel' } },
      dkgHome,
      { [WAL_SYNC_MODE_ENV]: ' ' },
    ).mode).toBe('parallel');
  });

  it('registers nothing and writes nothing when mode is omitted', async () => {
    const dkgHome = await home();
    const runtime = await startDaemonWalRuntime({}, dkgHome, {});
    expect(runtime).toBeNull();
    expect(daemonWalRuntimeStatus(runtime)).toMatchObject({
      mode: 'legacy',
      lifecycle: 'disabled',
      runtimeRegistered: false,
      protocolsRegistered: false,
      workersActive: 0,
    });
    expect(existsSync(join(dkgHome, 'wal-v1'))).toBe(false);
  });

  it('starts only isolated shadow state in parallel mode', async () => {
    const dkgHome = await home();
    const runtime = await startDaemonWalRuntime({ sync: { mode: 'parallel' } }, dkgHome, {});
    expect(daemonWalRuntimeStatus(runtime)).toMatchObject({
      mode: 'parallel',
      lifecycle: 'ready',
      productionAuthority: 'legacy',
      shadowEnabled: true,
      protocolsRegistered: false,
      workersActive: 0,
    });
    expect(existsSync(join(dkgHome, 'wal-v1', 'objects'))).toBe(true);
    expect(existsSync(join(dkgHome, 'store.nq'))).toBe(false);
    await runtime?.drain();
    await runtime?.stop();
  });

  it('refuses wal mode even when text configuration supplies a CutoverId', async () => {
    const dkgHome = await home();
    await expect(startDaemonWalRuntime({
      sync: { mode: 'wal', wal: { cutoverId: '01'.repeat(32) } },
    }, dkgHome, {})).rejects.toMatchObject({ code: 'WAL_CUTOVER_VERIFIER_UNAVAILABLE' });
    expect(existsSync(join(dkgHome, 'wal-v1'))).toBe(false);
  });
});
