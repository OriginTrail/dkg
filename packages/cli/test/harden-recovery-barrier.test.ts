// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeHardenMigration } from '../src/daemon/blazegraph-harden.js';
import { daemonRuntimeState } from '../src/daemon/shutdown-wait.js';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';
import { storeHardenLockPath } from '../src/daemon/store-maintenance-gate.js';
import { NAME, BACKUP, NAMESPACE, scriptedDocker, verifierFetch, uncertainInspectionResults } from './_helpers/blazegraph-harden-fixtures.js';

const originalHome = process.env.DKG_HOME;
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dkg-harden-recovery-')); process.env.DKG_HOME = home; });
afterEach(() => { if (originalHome === undefined) delete process.env.DKG_HOME; else process.env.DKG_HOME = originalHome; rmSync(home, { recursive: true, force: true }); });

async function incompleteRollback() {
  let refuseRemove = true;
  const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir: home,
    failOn: args => refuseRemove && args[0] === 'rm' ? { stdout: '', stderr: 'device busy', exitCode: 1 } : null });
  const options = { containerName: NAME, namespace: NAMESPACE, migrationDir: home, dkgHome: home, docker: runner,
    log() {}, freeDiskBytes: async () => 10 ** 12, readyIntervalMs: 1, readyTimeoutMs: 100 };
  await expect(executeHardenMigration({ ...options, fetch: verifierFetch({ askOk: false }).fn })).rejects.toThrow(/rollback is INCOMPLETE/);
  return { options, runner, calls, allowRemove: () => { refuseRemove = false; } };
}
async function expectStartupBlocked() {
  expect(existsSync(storeHardenLockPath(home))).toBe(true);
  await expect(daemonRuntimeState.claim(process.pid, resolveShutdownPolicy('60000'))).rejects.toThrow(/Store hardening marker/);
  expect(await daemonRuntimeState.readPid()).toBeNull();
  expect(await daemonRuntimeState.readPolicy(process.pid)).toBeNull();
}
async function expectStartupAllowed() {
  expect(existsSync(storeHardenLockPath(home))).toBe(false);
  await daemonRuntimeState.claim(process.pid, resolveShutdownPolicy('60000'));
  expect(await daemonRuntimeState.readPid()).toBe(process.pid);
  await daemonRuntimeState.release(process.pid);
}

describe('incomplete harden rollback startup barrier', () => {
  it.each(uncertainInspectionResults(BACKUP))('retains the original startup barrier when recovery backup inspection is uncertain (%s)', async (_, response) => {
    const f = await incompleteRollback(), marker = readFileSync(storeHardenLockPath(home), 'utf8');
    const calls: string[][] = [], verifier = verifierFetch();
    const docker = { run: async (args: readonly string[]) => {
      calls.push([...args]); return args[0] === 'inspect' && args[1] === BACKUP ? response : f.runner.run(args);
    } };
    await expect(executeHardenMigration({ ...f.options, docker, recover: true, fetch: verifier.fn }))
      .rejects.toThrow(/Cannot verify the migration backup state/);
    expect(calls.every(args => args[0] === 'inspect')).toBe(true);
    expect(verifier.calls).toEqual([]);
    expect(readFileSync(storeHardenLockPath(home), 'utf8')).toBe(marker);
    await expectStartupBlocked();
  });
  it('blocks daemon startup until the retained replacement passes explicit recovery verification', async () => {
    const f = await incompleteRollback(); await expectStartupBlocked();
    const recoveryStart = f.calls.length;
    await expect(executeHardenMigration({ ...f.options, recover: true, fetch: verifierFetch().fn })).resolves.toMatchObject({ outcome: 'recovered' });
    expect(f.calls.slice(recoveryStart).every(args => ['inspect', 'exec'].includes(args[0]!))).toBe(true);
    await expectStartupAllowed();
  });
  it('keeps startup blocked after failed recovery and allows a later verified recovery', async () => {
    const f = await incompleteRollback(); await expectStartupBlocked();
    await expect(executeHardenMigration({ ...f.options, recover: true, fetch: verifierFetch({ identityPresent: false }).fn })).rejects.toThrow(/identity-tag/);
    await expectStartupBlocked();
    await executeHardenMigration({ ...f.options, recover: true, fetch: verifierFetch().fn });
    await expectStartupAllowed();
  });
  it.each(['unknown marker', 'invalid JSON', 'changed options', 'missing export', 'held recovery lease', 'changed marker'])('refuses unverifiable recovery: %s', async corruption => {
    const f = await incompleteRollback(); await expectStartupBlocked();
    const path = storeHardenLockPath(home);
    if (corruption === 'unknown marker') writeFileSync(path, '{}');
    if (corruption === 'invalid JSON') writeFileSync(path, '{bad');
    if (corruption === 'missing export') rmSync(join(home, 'bigdata.jnl'));
    if (corruption === 'held recovery lease') writeFileSync(`${path}.recovery`, String(process.pid));
    const verified = verifierFetch().fn;
    const fetch: typeof globalThis.fetch = async (...args) => {
      if (corruption === 'changed marker') writeFileSync(path, JSON.stringify({ activeOwner: 'another migration' }));
      return verified(...args);
    };
    await expect(executeHardenMigration({ ...f.options, recover: true, fetch,
      ...(corruption === 'changed options' ? { namespace: 'different' } : {}) })).rejects.toThrow();
    await expectStartupBlocked();
  });
  it('does not release startup ownership while a recovery identity probe is held', async () => {
    const f = await incompleteRollback(); await expectStartupBlocked();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const verified = verifierFetch().fn;
    const fetch: typeof globalThis.fetch = async (...args) => {
      if (String((args[1] as RequestInit)?.body ?? '').includes('SELECT')) { entered(); await held; }
      return verified(...args);
    };
    const recovery = executeHardenMigration({ ...f.options, recover: true, fetch });
    await started; await expectStartupBlocked();
    expect(JSON.parse(readFileSync(storeHardenLockPath(home), 'utf8')).recoveryRequired).toBe(true);
    release(); await recovery; await expectStartupAllowed();
  });
  it('verifies the manually restored backup before clearing the same barrier', async () => {
    const f = await incompleteRollback(); await expectStartupBlocked(); f.allowRemove();
    for (const args of [['rm', '-f', NAME], ['rename', BACKUP, NAME], ['update', '--restart=unless-stopped', NAME], ['start', NAME]]) await f.runner.run(args);
    await expect(executeHardenMigration({ ...f.options, recover: true, fetch: verifierFetch().fn })).resolves.toMatchObject({ outcome: 'recovered', backupContainerName: null });
    await expectStartupAllowed();
  });
});
