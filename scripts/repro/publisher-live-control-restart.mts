/**
 * Real two-wallet runtime + HTTP + persistent Oxigraph + SIGKILL/restart proof.
 * Build publisher/CLI first; run node --experimental-sqlite --import tsx
 * scripts/repro/publisher-live-control-restart.mts. No chain RPC or production writes.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addPublisherWallet } from '../../packages/cli/src/publisher-wallets.js';

const directory = await mkdtemp(join(tmpdir(), 'dkg-live-publisher-campaign-'));
const token = randomUUID();
const children: ReturnType<typeof spawn>[] = [];
async function start() {
  const child = spawn(process.execPath, ['--experimental-sqlite', '--import', 'tsx',
    fileURLToPath(new URL('./publisher-live-control-worker.mts', import.meta.url)), directory, token],
  { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  let output = ''; let sequence = 0;
  const messages: any[] = [];
  child.stdout?.on('data', chunk => { output = (output + chunk).slice(-100_000); });
  child.stderr?.on('data', chunk => { output = (output + chunk).slice(-100_000); });
  child.on('message', message => messages.push(message));
  const wait = async (predicate: (message: any) => boolean) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker exited: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Worker response timed out: ${output}`);
  };
  const ready = await wait(m => m.type === 'ready');
  const command = async (action: string, jobId?: string) => {
    const id = ++sequence; child.send({ id, action, jobId });
    const response = await wait(m => m.id === id);
    assert.equal(response.error, undefined); return response.result;
  };
  const request = async (action: string) => {
    const response = await fetch(`${ready.url}/api/publisher/${action}`, {
      method: action === 'control' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}` },
      ...(action === 'control' ? {} : { body: '{}' }), signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200); return response.json() as Promise<any>;
  };
  return { child, ready, command, request, wait };
}
async function terminate(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill(signal);
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { await exit; } finally { clearTimeout(timer); }
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
  await terminate(first.child, 'SIGKILL');
  assert.equal(first.child.signalCode, 'SIGKILL');
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
  console.log(JSON.stringify({ status: 'PASS', killedPid: first.ready.pid, restartedPid: second.ready.pid,
    wallets: 2, pausedGeneration: 1, resumedGeneration: 2, acceptedEvidencePreserved: true,
    resumedExecution: true, backend: 'Oxigraph', chain: 'NoChainAdapter' }));
} finally {
  for (const child of children) await terminate(child, 'SIGTERM');
  await rm(directory, { recursive: true, force: true });
}
