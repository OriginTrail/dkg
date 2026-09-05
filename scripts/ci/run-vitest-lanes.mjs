#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COVERAGE_JOBS } from '../lib/ci-lanes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function runLane(lane) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/ci/run-vitest-junit.mjs', '--lane', lane, '--', '--maxWorkers=2'], { cwd: ROOT, env: process.env, stdio: 'inherit' });
    child.once('error', (error) => { console.error(`${lane}: ${error.message}`); resolve(1); });
    child.once('close', (code) => resolve(code ?? 1));
  });
}

/** Finish every selected lane, retaining each runner's isolated JUnit/coverage receipt. */
export async function runVitestLanes(job, concurrency = 3, { execute = runLane } = {}) {
  const packages = COVERAGE_JOBS[job];
  if (!packages || Object.values(packages).some((count) => count !== 1)) throw new Error(`expected an unsharded coverage job, got ${job}`);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('concurrency must be an integer from 1 to 8');
  const pending = Object.keys(packages);
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

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [, , jobFlag, job, concurrencyFlag, concurrency] = process.argv;
    if (jobFlag !== '--job' || concurrencyFlag !== '--concurrency' || process.argv.length !== 6) throw new Error('usage: run-vitest-lanes.mjs --job JOB --concurrency N');
    process.exitCode = await runVitestLanes(job, Number(concurrency));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
