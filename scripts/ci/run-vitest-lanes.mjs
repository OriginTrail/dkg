#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COVERAGE_JOBS, ciJobRow } from '../lib/ci-lanes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function runLane(lane, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/ci/run-vitest-junit.mjs', '--lane', lane, ...args], { cwd: ROOT, env: process.env, stdio: 'inherit' });
    child.once('error', (error) => { console.error(`${lane}: ${error.message}`); resolve(1); });
    child.once('close', (code) => resolve(code ?? 1));
  });
}

async function runBounded(packages, concurrency, execute) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('concurrency must be an integer from 1 to 8');
  const pending = [...packages];
  const results = {};
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (pending.length) {
      const lane = pending.shift();
      try { results[lane] = await execute(lane); }
      catch (error) { console.error(`${lane}: ${error.message}`); results[lane] = 1; }
    }
  }));
  for (const [lane, code] of Object.entries(results)) console.log(`${lane}: ${code === 0 ? 'passed' : `failed (${code})`}`);
  return Object.values(results).every((code) => code === 0) ? 0 : 1;
}

/** Compatibility entry point for local bounded package batches. */
export async function runVitestLanes(job, concurrency = 3, { execute = runLane } = {}) {
  const packages = COVERAGE_JOBS[job];
  if (!packages || Object.values(packages).some((count) => count !== 1)) throw new Error(`expected an unsharded coverage job, got ${job}`);
  return runBounded(Object.keys(packages), concurrency, execute);
}

export async function vitestRowArguments(row, { root = ROOT } = {}) {
  const args = row.shard ? ['--shard', String(row.shard)] : [];
  let tests = row.maxWorkers ? [`--maxWorkers=${row.maxWorkers}`] : [];
  if (row.runner === 'vitest') tests.push(`--shard=${row.shard}/${row.shards}`);
  if (row.runner === 'weighted') {
    const { planPackageShards } = await import('./plan-vitest-shard.mjs');
    const shards = planPackageShards(row.packages[0], root);
    if (shards.length !== row.shards) throw new Error('weighted plan disagrees with CI matrix');
    tests.push(...shards[row.shard - 1].files);
  }
  if (row.runner === 'agent') {
    const { planAgentShards } = await import('./plan-agent-shards.mjs');
    const shards = planAgentShards(root);
    if (shards.length !== row.shards) throw new Error('agent plan disagrees with CI matrix');
    const plan = shards[row.shard - 1];
    if (!plan.files.length) throw new Error('empty agent shard');
    tests.push('--config', plan.config, ...plan.files);
  }
  return [...args, ...(tests.length ? ['--', ...tests] : [])];
}

/** Every workflow invocation resolves packages, shard denominators and concurrency here. */
export async function runVitestRow(job, index = 0, { execute = runLane, argumentsFor = vitestRowArguments, topology } = {}) {
  const row = ciJobRow(job, index, topology);
  const args = await argumentsFor(row);
  return runBounded(row.packages, row.concurrency ?? 1, (lane) => execute(lane, args));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [jobFlag, job, option, value, ...extra] = process.argv.slice(2);
    if (jobFlag !== '--job' || !job || extra.length || (option !== undefined && !['--row', '--concurrency'].includes(option)) || (option && value === undefined)) throw new Error('usage: run-vitest-lanes.mjs --job JOB [--row N | --concurrency N]');
    process.exitCode = option === '--concurrency' ? await runVitestLanes(job, Number(value)) : await runVitestRow(job, option ? Number(value) : 0);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
