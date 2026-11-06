import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeHardenMigration } from '../src/daemon/blazegraph-harden.js';
import { blazegraphVolumeName } from '../src/daemon/blazegraph-docker.js';
import { assertStoreMigrationInactive, storeHardenLockPath } from '../src/daemon/store-maintenance-gate.js';
import { crashDocker, crashVerifier, CRASH_BYTES, CRASH_NAME, CRASH_NAMESPACE } from './_helpers/harden-crash-docker.js';
let home: string;
const children: ChildProcess[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'harden-killed-')); });
afterEach(() => { for (const child of children.splice(0)) child.kill('SIGKILL'); rmSync(home, { recursive: true, force: true }); });
async function interruptedReplacement(point: 'before-export' | 'after-rename' | 'after-replacement' = 'after-replacement') {
  const child = spawn(process.execPath,
    ['--import', fileURLToPath(new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/harden-crash-owner.ts', import.meta.url)), home, point], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  let diagnostic = ''; child.stderr?.on('data', bytes => { diagnostic += String(bytes); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  await new Promise<void>((resolve, reject) => {
    child.once('message', message => { expect(message).toEqual({ replacementCreated: point === 'after-replacement', ownerPid: child.pid }); resolve(); });
    child.once('exit', () => reject(new Error(`owner exited before replacement: ${diagnostic}`)));
  });
  expect(child.kill('SIGKILL')).toBe(true);
  expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
  expect(existsSync(join(home, 'docker-state.json'))).toBe(true);
  const marker = readFileSync(storeHardenLockPath(home), 'utf8');
  expect(JSON.parse(marker).recoveryRequired).toBeUndefined();
  await expect(assertStoreMigrationInactive(home)).rejects.toThrow(/Store hardening marker/);
  const f = crashDocker(home);
  return { marker, ...f, options: { containerName: CRASH_NAME, namespace: CRASH_NAMESPACE,
    migrationDir: home, dkgHome: home, docker: f.runner, fetch: crashVerifier, log() {}, readyTimeoutMs: 100, readyIntervalMs: 1 } };
}
describe('explicit reconciliation after actual harden owner SIGKILL', () => {
  it('verifies the replacement and clears the orphan startup fence without mutating Docker', async () => {
    const f = await interruptedReplacement();
    await expect(executeHardenMigration({ ...f.options, recover: true })).resolves.toMatchObject({ outcome: 'recovered', journalBytes: CRASH_BYTES });
    expect(JSON.parse(f.marker).recovery.exportBytes).toBe(CRASH_BYTES);
    expect(f.calls.every(args => ['inspect', 'exec', 'volume'].includes(args[0]!))).toBe(true);
    await expect(assertStoreMigrationInactive(home)).resolves.toBeUndefined();
  }, 15000);
  it('retains exact orphan evidence after failed verification, then permits verified recovery', async () => {
    const f = await interruptedReplacement();
    const fetch: typeof globalThis.fetch = async (...args) => String(args[1]?.body).includes('SELECT')
      ? new Response(JSON.stringify({ results: { bindings: [] } })) : crashVerifier(...args);
    await expect(executeHardenMigration({ ...f.options, recover: true, fetch })).rejects.toThrow(/identity-tag/);
    expect(readFileSync(storeHardenLockPath(home), 'utf8')).toBe(f.marker);
    await expect(assertStoreMigrationInactive(home)).rejects.toThrow();
    await executeHardenMigration({ ...f.options, recover: true });
    await expect(assertStoreMigrationInactive(home)).resolves.toBeUndefined();
  }, 15000);
  it('verifies a manually restored original after the same owner interruption', async () => {
    const f = await interruptedReplacement();
    await f.runner.run(['rm', '-f', CRASH_NAME]);
    await f.runner.run(['rename', `${CRASH_NAME}-backup`, CRASH_NAME]);
    const index = f.calls.length;
    await expect(executeHardenMigration({ ...f.options, recover: true })).resolves.toMatchObject({ outcome: 'recovered', backupContainerName: null });
    expect(f.calls.slice(index).every(args => ['inspect', 'exec'].includes(args[0]!))).toBe(true);
    await expect(assertStoreMigrationInactive(home)).resolves.toBeUndefined();
  }, 15000);
  it('keeps both copies and the fence after a kill right after the rename, until the restored original is verified', async () => {
    const f = await interruptedReplacement('after-rename');
    expect(JSON.parse(f.marker).recovery.exportBytes).toBe(CRASH_BYTES);
    const index = f.calls.length;
    // A plain retry stops at the marker, and recovery needs a store under the original name.
    await expect(executeHardenMigration(f.options)).rejects.toThrow(/--recover/);
    await expect(executeHardenMigration({ ...f.options, recover: true })).rejects.toThrow(/Restore the backup/);
    expect(f.calls.slice(index).every(args => ['inspect', 'volume'].includes(args[0]!) && args[1] !== 'create')).toBe(true);
    expect(readFileSync(join(home, 'bigdata.jnl'))).toHaveLength(CRASH_BYTES);
    expect(readFileSync(storeHardenLockPath(home), 'utf8')).toBe(f.marker);
    await expect(assertStoreMigrationInactive(home)).rejects.toThrow();

    await f.runner.run(['rename', `${CRASH_NAME}-backup`, CRASH_NAME]);
    await f.runner.run(['start', CRASH_NAME]);
    await expect(executeHardenMigration({ ...f.options, recover: true }))
      .resolves.toMatchObject({ outcome: 'recovered', journalBytes: CRASH_BYTES, backupContainerName: null });
    await expect(assertStoreMigrationInactive(home)).resolves.toBeUndefined();
  }, 15000);
  describe('an owner interrupted before its export checkpoint', () => {
    /** Docker state and options as a recovery run sees them after `change`. */
    const recoveryAfter = (f: Awaited<ReturnType<typeof interruptedReplacement>>, change: (state: Record<string, unknown>) => void) => {
      const path = join(home, 'docker-state.json'), state = JSON.parse(readFileSync(path, 'utf8'));
      change(state); writeFileSync(path, JSON.stringify(state));
      const docker = crashDocker(home);
      return { docker, options: { ...f.options, docker: docker.runner, recover: true } };
    };

    it('verifies the untouched original once it runs again, changing nothing in Docker', async () => {
      const f = await interruptedReplacement('before-export');
      expect(JSON.parse(f.marker).recovery).toMatchObject({ namespace: CRASH_NAMESPACE, migrationDir: home, hostPort: 9999 });
      expect(JSON.parse(f.marker).recovery.exportBytes).toBeUndefined();

      const stopped = recoveryAfter(f, state => { state.stopped = true; });
      await expect(executeHardenMigration(stopped.options)).rejects.toThrow(/docker start/);
      expect(readFileSync(storeHardenLockPath(home), 'utf8')).toBe(f.marker);
      await expect(assertStoreMigrationInactive(home)).rejects.toThrow();

      const running = recoveryAfter(f, state => { state.stopped = false; });
      await expect(executeHardenMigration(running.options)).resolves.toMatchObject({
        outcome: 'recovered', exportPath: null, journalBytes: null, backupContainerName: null,
      });
      expect(running.docker.calls.every(args => ['inspect', 'exec'].includes(args[0]!))).toBe(true);
      await expect(assertStoreMigrationInactive(home)).resolves.toBeUndefined();
    }, 15000);

    it('keeps the fence while the original does not answer', async () => {
      const f = await interruptedReplacement('before-export');
      const fetch: typeof globalThis.fetch = async () => new Response('unavailable', { status: 503 });
      await expect(executeHardenMigration({ ...f.options, fetch, recover: true })).rejects.toThrow();
      expect(readFileSync(storeHardenLockPath(home), 'utf8')).toBe(f.marker);
    }, 15000);

    it('keeps the fence for a different container under the original name', async () => {
      const f = await interruptedReplacement('before-export');
      const { options } = recoveryAfter(f, state => { state.sourceId = 'different-container-id'; });
      await expect(executeHardenMigration(options)).rejects.toThrow(/original source/);
      await expect(assertStoreMigrationInactive(home)).rejects.toThrow();
    }, 15000);

    it('keeps the fence when the original was not captured', async () => {
      const f = await interruptedReplacement('before-export');
      const marker = JSON.parse(f.marker); delete marker.recovery.sourceContainerId;
      writeFileSync(storeHardenLockPath(home), JSON.stringify(marker));
      await expect(executeHardenMigration({ ...f.options, recover: true })).rejects.toThrow(/original source/);
      await expect(assertStoreMigrationInactive(home)).rejects.toThrow();
    }, 15000);

    it('keeps the fence while its owner may be alive', async () => {
      const f = await interruptedReplacement('before-export');
      const marker = JSON.parse(f.marker); marker.pid = process.pid;
      writeFileSync(storeHardenLockPath(home), JSON.stringify(marker));
      await expect(executeHardenMigration({ ...f.options, recover: true })).rejects.toThrow(/live or unverifiable/);
      await expect(assertStoreMigrationInactive(home)).rejects.toThrow();
    }, 15000);
  });
  it('refuses a historical orphan marker with no recovery evidence instead of guessing', async () => {
    const f = await interruptedReplacement('before-export');
    const marker = JSON.parse(f.marker); delete marker.recovery; writeFileSync(storeHardenLockPath(home), JSON.stringify(marker));
    await expect(executeHardenMigration({ ...f.options, recover: true })).rejects.toThrow(/does not certify/);
    await expect(assertStoreMigrationInactive(home)).rejects.toThrow();
  }, 15000);
  it('rejects a different legacy container substituted for the captured original', async () => {
    const f = await interruptedReplacement();
    await f.runner.run(['rm', '-f', CRASH_NAME]);
    await f.runner.run(['rename', `${CRASH_NAME}-backup`, CRASH_NAME]);
    const path = join(home, 'docker-state.json'), state = JSON.parse(readFileSync(path, 'utf8'));
    state.sourceId = 'different-container-id'; writeFileSync(path, JSON.stringify(state));
    await expect(executeHardenMigration({ ...f.options, docker: crashDocker(home).runner, recover: true }))
      .rejects.toThrow(/original source/);
    await expect(assertStoreMigrationInactive(home)).rejects.toThrow();
  }, 15000);
  it.each(['foreign attempt', 'foreign mounted volume', 'missing original ID', 'foreign original ID'])('keeps the checkpoint fence after caught incomplete rollback (%s)', async refusal => {
    const f = crashDocker(home);
    const docker = { async run(args: readonly string[]) {
      return args[0] === 'rm' ? { stdout: '', stderr: 'busy', exitCode: 1 } : f.runner.run(args);
    } };
    const options = { containerName: CRASH_NAME, namespace: CRASH_NAMESPACE, migrationDir: home, dkgHome: home,
      docker, log() {}, freeDiskBytes: async () => 1e12, readyTimeoutMs: 100, readyIntervalMs: 1 };
    const failed: typeof globalThis.fetch = async (...args) => String(args[1]?.body).includes('SELECT')
      ? new Response(JSON.stringify({ results: { bindings: [] } })) : crashVerifier(...args);
    await expect(executeHardenMigration({ ...options, fetch: failed })).rejects.toThrow(/rollback is INCOMPLETE/);
    let marker = readFileSync(storeHardenLockPath(home), 'utf8');
    if (refusal === 'missing original ID' || refusal === 'foreign original ID') {
      await f.runner.run(['rm', '-f', CRASH_NAME]); await f.runner.run(['rename', `${CRASH_NAME}-backup`, CRASH_NAME]);
    }
    if (refusal === 'missing original ID') { const value = JSON.parse(marker); delete value.sourceContainerId; writeFileSync(storeHardenLockPath(home), JSON.stringify(value)); marker = readFileSync(storeHardenLockPath(home), 'utf8'); }
    const path = join(home, 'docker-state.json'), state = JSON.parse(readFileSync(path, 'utf8'));
    if (refusal === 'foreign attempt') state.attempt = 'foreign';
    if (refusal === 'foreign mounted volume') state.mount = blazegraphVolumeName(CRASH_NAME);
    if (refusal === 'foreign original ID') state.sourceId = 'different-container-id';
    writeFileSync(path, JSON.stringify(state));
    await expect(executeHardenMigration({ ...options, docker: crashDocker(home).runner, fetch: crashVerifier, recover: true })).rejects.toThrow();
    expect(readFileSync(storeHardenLockPath(home), 'utf8')).toBe(marker);
    await expect(assertStoreMigrationInactive(home)).rejects.toThrow();
  });
  it.each(['live owner', 'foreign options', 'foreign attempt', 'foreign mounted volume', 'missing original ID', 'changed raw marker', 'missing export'])('retains the fence for %s', async refusal => {
    const f = await interruptedReplacement();
    if (refusal === 'live owner') { const value = JSON.parse(f.marker); value.pid = process.pid; writeFileSync(storeHardenLockPath(home), JSON.stringify(value)); }
    if (refusal === 'foreign attempt') { const p = join(home, 'docker-state.json'), state = JSON.parse(readFileSync(p, 'utf8')); state.attempt = 'foreign'; writeFileSync(p, JSON.stringify(state)); }
    if (refusal === 'foreign mounted volume') { const p = join(home, 'docker-state.json'), state = JSON.parse(readFileSync(p, 'utf8')); state.mount = blazegraphVolumeName(CRASH_NAME); writeFileSync(p, JSON.stringify(state)); }
    if (refusal === 'missing original ID') {
      await f.runner.run(['rm', '-f', CRASH_NAME]); await f.runner.run(['rename', `${CRASH_NAME}-backup`, CRASH_NAME]);
      const marker = JSON.parse(f.marker); delete marker.recovery.sourceContainerId; writeFileSync(storeHardenLockPath(home), JSON.stringify(marker));
    }
    if (refusal === 'missing export') rmSync(join(home, 'bigdata.jnl'));
    const replacement = crashDocker(home);
    const fetch: typeof globalThis.fetch = async (...args) => {
      if (refusal === 'changed raw marker') writeFileSync(storeHardenLockPath(home), '{"pid":1}');
      return crashVerifier(...args);
    };
    await expect(executeHardenMigration({ ...f.options, docker: replacement.runner, fetch, recover: true,
      ...(refusal === 'foreign options' ? { namespace: 'different' } : {}) })).rejects.toThrow();
    await expect(assertStoreMigrationInactive(home)).rejects.toThrow();
  }, 15000);
});
