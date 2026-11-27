import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sharedTestInputs } from './test-fixture-inputs.mjs';
import { COVERAGE_SOURCE_ROOTS } from './coverage-scope.mjs';

import { COVERAGE_JOBS } from './ci-lanes.mjs';
export { COVERAGE_JOBS } from './ci-lanes.mjs';

export function sourceFingerprint(root, name) {
  const hash = createHash('sha256');
  function visit(relative) {
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) return;
    if (fs.statSync(full).isDirectory()) {
      for (const item of fs.readdirSync(full).sort()) visit(`${relative}/${item}`);
    } else {
      hash.update(relative); hash.update('\0'); hash.update(fs.readFileSync(full)); hash.update('\0');
    }
  }
  for (const folder of COVERAGE_SOURCE_ROOTS) visit(`packages/${name}/${folder}`);
  for (const file of ['vitest.coverage.ts', 'scripts/lib/coverage-scope.mjs', `packages/${name}/turbo.json`, 'pnpm-lock.yaml']) visit(file);
  for (const file of sharedTestInputs(root, name)) visit(file);
  const packageRoot = path.join(root, 'packages', name);
  for (const file of fs.readdirSync(packageRoot).filter((file) => /^vitest.*\.[cm]?[jt]s$/.test(file)).sort()) visit(`packages/${name}/${file}`);
  return hash.digest('hex');
}

export function coverageReceipt(root, name, shard, execution) {
  if (!Number.isSafeInteger(execution?.executedTests) || execution.executedTests < 1) throw new Error('coverage requires executed tests');
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'packages', name, 'coverage/coverage-final.json'), 'utf8'));
  if (!Object.keys(raw).length) throw new Error('empty coverage artifact');
  const coverage = {};
  for (const [filename, value] of Object.entries(raw)) {
    const relative = path.relative(root, filename).split(path.sep).join('/');
    if (!COVERAGE_SOURCE_ROOTS.some((folder) => relative.startsWith(`packages/${name}/${folder}/`))) throw new Error(`unexpected coverage path ${filename}`);
    coverage[relative] = { ...value, path: relative };
  }
  return {
    version: 2, ...execution, package: name, shard: shard ?? '0',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    fingerprint: sourceFingerprint(root, name), coverage,
  };
}

export function validateReceipts(receipts, needs, { revision, fingerprint, jobs = COVERAGE_JOBS }) {
  const expected = new Map();
  for (const [job, packages] of Object.entries(jobs)) {
    if (!needs[job]) throw new Error(`missing job result ${job}`);
    if (needs[job].result === 'skipped') continue; // The trusted aggregate verifies planner-authorized skips.
    if (needs[job].result !== 'success') throw new Error(`${job} did not succeed`);
    for (const [name, count] of Object.entries(packages)) {
      for (let n = 0; n < count; n++) expected.set(`${name}:${count === 1 ? 0 : n + 1}`, name);
    }
  }
  for (const receipt of receipts) {
    const key = `${receipt.package}:${receipt.shard}`;
    if (!expected.has(key)) throw new Error(`unexpected or duplicate coverage shard ${key}`);
    if (receipt.version !== 2 || receipt.revision !== revision || receipt.fingerprint !== fingerprint(receipt.package)) throw new Error(`stale coverage ${key}`);
    if (!Number.isSafeInteger(receipt.executedTests) || receipt.executedTests < 1) throw new Error(`no executed tests for ${key}`);
    if (!receipt.coverage || !Object.keys(receipt.coverage).length) throw new Error(`empty coverage ${key}`);
    expected.delete(key);
  }
  if (expected.size) throw new Error(`missing coverage shards: ${[...expected.keys()].join(', ')}`);
  return [...new Set(receipts.map((item) => item.package))];
}
