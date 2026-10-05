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
async function interruptedReplacement(beforeExport = false) {
  const child = spawn(process.execPath,
    ['--import', fileURLToPath(new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/harden-crash-owner.ts', import.meta.url)), home, beforeExport ? 'before-export' : 'after-replacement'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  let diagnostic = ''; child.stderr?.on('data', bytes => { diagnostic += String(bytes); });
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
  await new Promise<void>((resolve, reject) => {
    child.once('message', message => { expect(message).toEqual({ replacementCreated: !beforeExport, ownerPid: child.pid }); resolve(); });
    child.once('exit', () => reject(new Error(`owner exited before replacement: ${diagnostic}`)));
  });
  child.kill('SIGKILL'); await exited;
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
  it('refuses pre-export or historical unbound orphan markers instead of guessing evidence', async () => {
    const f = await interruptedReplacement(true);
    expect(JSON.parse(f.marker).recovery).toMatchObject({ namespace: CRASH_NAMESPACE, migrationDir: home, hostPort: 9999 });
    expect(JSON.parse(f.marker).recovery.exportBytes).toBeUndefined();
    await expect(executeHardenMigration({ ...f.options, recover: true })).rejects.toThrow(/does not certify/);
    const marker = JSON.parse(f.marker); delete marker.recovery; writeFileSync(storeHardenLockPath(home), JSON.stringify(marker));
    await expect(executeHardenMigration({ ...f.options, recover: true })).rejects.toThrow(/does not certify/);
    await expect(assertStoreMigrationInactive(home)).rejects.toThrow();
  }, 15000);
  it.each(['live owner', 'foreign options', 'foreign attempt', 'foreign mounted volume', 'changed raw marker', 'missing export'])('retains the fence for %s', async refusal => {
    const f = await interruptedReplacement();
    if (refusal === 'live owner') { const value = JSON.parse(f.marker); value.pid = process.pid; writeFileSync(storeHardenLockPath(home), JSON.stringify(value)); }
    if (refusal === 'foreign attempt') { const p = join(home, 'docker-state.json'), state = JSON.parse(readFileSync(p, 'utf8')); state.attempt = 'foreign'; writeFileSync(p, JSON.stringify(state)); }
    if (refusal === 'foreign mounted volume') { const p = join(home, 'docker-state.json'), state = JSON.parse(readFileSync(p, 'utf8')); state.mount = blazegraphVolumeName(CRASH_NAME); writeFileSync(p, JSON.stringify(state)); }
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
