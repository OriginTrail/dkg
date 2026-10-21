/**
 * Real two-wallet runtime + HTTP + persistent Oxigraph + SIGKILL/restart proof.
 * Build publisher/CLI first; run node --experimental-sqlite --import tsx
 * scripts/repro/publisher-live-control-restart.mts. No chain RPC or production writes.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownProcess, type OwnedProcess } from '../testing/owned-process.mjs';
import { addPublisherWallet } from '../../packages/cli/src/publisher-wallets.js';

const directory = await mkdtemp(join(tmpdir(), 'dkg-live-publisher-campaign-'));
const token = randomUUID();
const children: OwnedProcess[] = [];
async function start(startPaused = false, probe = 'startup-pause') {
  const child = spawn(process.execPath, ['--experimental-sqlite', '--import', 'tsx',
    fileURLToPath(new URL('./publisher-live-control-worker.mts', import.meta.url)), directory, token, ...(startPaused ? [probe] : [])],
  { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, DKG_PUBLISHER_START_PAUSED: startPaused ? '1' : '0' } });
  const owner = ownProcess(child, { label: 'Publisher control campaign worker' });
  children.push(owner);
  let sequence = 0;
  const messages: any[] = [];
  child.on('message', message => messages.push(message));
  const wait = (predicate: (message: any) => boolean) => owner.ready(() => {
    const index = messages.findIndex(predicate);
    return index >= 0 ? messages.splice(index, 1)[0] : undefined;
  }, { timeoutMs: 20_000, intervalMs: 10 });
  const ready = await wait(m => m.type === 'ready');
  const command = async (action: string, jobId?: string) => {
    const id = ++sequence; child.send({ id, action, jobId });
    const response = await wait(m => m.id === id);
    assert.equal(response.error, undefined); return response.result;
  };
  const request = async (action: string, expectedStatus = 200) => {
    const response = await fetch(`${ready.url}/api/publisher/${action}`, {
      method: action === 'control' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}` },
      ...(action === 'control' ? {} : { body: '{}' }), signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, expectedStatus); return response.json() as Promise<any>;
  };
  return { child, owner, ready, command, request, wait };
}
try {
  await addPublisherWallet(directory, `0x${'11'.repeat(32)}`);
  await addPublisherWallet(directory, `0x${'22'.repeat(32)}`);
  const first = await start();
  const paused = await first.request('pause');
  assert.equal(paused.desiredState, 'paused'); assert.equal(paused.generation, 1);
  assert.equal(paused.wallets.length, 2);
  assert.ok(paused.wallets.every((wallet: any) => wallet.paused && wallet.generation === 1));
  const accepted = await first.command('enqueue');
  assert.equal(accepted.job.status, 'accepted');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(await first.command('status', accepted.jobId), accepted.job);
  first.child.kill('SIGKILL');
  assert.equal((await first.owner.closed).signal, 'SIGKILL');
  const second = await start();
  const restored = await second.request('control');
  assert.equal(restored.desiredState, 'paused'); assert.equal(restored.effectiveState, 'paused');
  assert.equal(restored.acknowledgedGeneration, 1);
  assert.ok(restored.wallets.every((wallet: any) => wallet.paused && wallet.generation === 1));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(await second.command('status', accepted.jobId), accepted.job);
  const resumed = await second.request('resume');
  assert.equal(resumed.generation, 2); assert.equal(resumed.effectiveState, 'running');
  assert.ok(resumed.wallets.every((wallet: any) => !wallet.paused && wallet.generation === 2));
  const execution = await second.wait(m => m.type === 'executing');
  assert.ok(resumed.wallets.some((wallet: any) => wallet.walletId === execution.walletId));
  await second.owner.stop();
  // Real daemon construction reads the environment override before starting its wallet loops.
  const maintenance = await start(true);
  const overridden = await maintenance.request('control');
  assert.equal(overridden.desiredState, 'paused'); assert.equal(overridden.generation, 3);
  assert.equal(overridden.acknowledgedGeneration, 3); assert.equal(overridden.effectiveState, 'paused');
  const startupAccepted = maintenance.ready.startupAccepted;
  assert.equal(startupAccepted.job.status, 'accepted');
  assert.deepEqual(await maintenance.command('status', startupAccepted.jobId), startupAccepted.job);
  assert.equal((await maintenance.request('resume')).generation, 4);
  await maintenance.wait(m => m.type === 'executing');
  await maintenance.owner.stop();
  const retiring = await start(true, 'shutdown-pause');
  const shutdownAccepted = retiring.ready.startupAccepted;
  assert.equal((await retiring.request('control')).generation, 5);
  await retiring.command('hold-resume-fsync');
  const deniedResume = retiring.request('resume', 503);
  await retiring.wait(m => m.type === 'control-fsync-held');
  retiring.child.kill('SIGTERM');
  assert.equal((await retiring.wait(m => m.type === 'shutdown-fenced')).effectiveState, 'unavailable');
  await retiring.command('release-resume-fsync');
  assert.equal((await deniedResume).code, 'PUBLISHER_CONTROL_UNAVAILABLE');
  await retiring.owner.waitForExit(20_000);
  const retired = JSON.parse(await readFile(join(directory, 'shutdown-result.json'), 'utf8'));
  assert.equal(retired.executions, 0);
  assert.deepEqual(retired.job, shutdownAccepted.job);
  const saved = JSON.parse(await readFile(join(directory, 'publisher-control.json'), 'utf8'));
  assert.equal(saved.desiredState, 'running'); assert.equal(saved.generation, 6);
  const afterShutdown = await start();
  assert.equal((await afterShutdown.request('control')).generation, 6);
  await afterShutdown.wait(m => m.type === 'executing');
  console.log(JSON.stringify({ status: 'PASS', killedPid: first.ready.pid, restartedPid: second.ready.pid,
    wallets: 2, pausedGeneration: 1, resumedGeneration: 2, acceptedEvidencePreserved: true,
    startupOverride: { environment: true, pausedGeneration: 3, resumedGeneration: 4, acceptedEvidencePreserved: true },
    shutdownFence: { signal: 'SIGTERM', resumeStatus: 503, acceptedEvidencePreserved: true, restartRunningGeneration: 6 },
    resumedExecution: true, backend: 'Oxigraph', chain: 'NoChainAdapter' }));
} finally {
  for (const owner of children) await owner.stop();
  await rm(directory, { recursive: true, force: true });
}
