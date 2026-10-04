#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateNode26Evidence } from '../lib/ci-results.mjs';

// Use the same interpreter for the runner, Vitest, and its cold-request child.
// Outputs are private to this attempt; a stale report cannot certify a rerun.
const root = fileURLToPath(new URL('../../', import.meta.url));
const chain = path.join(root, 'packages/chain');
const output = path.resolve(process.argv[2] ?? 'chain-rpc-node26-results');
fs.mkdirSync(output, { recursive: true });
const reportPath = path.join(output, 'vitest.json');
fs.rmSync(reportPath, { force: true });
const evidence = {
  version: 1,
  node: process.versions.node,
  undici: process.versions.undici,
  requireUndici8Fetch: process.env.DKG_REQUIRE_UNDICI8_FETCH === '1',
  success: false,
  assertions: [],
};
try {
  if (!evidence.node.startsWith('26.') || !evidence.undici?.startsWith('8.') || !evidence.requireUndici8Fetch) {
    throw new Error('requires Node 26 with bundled undici 8 and DKG_REQUIRE_UNDICI8_FETCH=1');
  }
  const require = createRequire(path.join(chain, 'package.json'));
  const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const result = spawnSync(process.execPath, [
    vitest, 'run', '--config', 'vitest.unit.config.ts',
    'test/rpc-http1-dispatcher.unit.test.ts',
    '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`,
  ], { cwd: chain, env: process.env, stdio: 'inherit', timeout: 120_000 });
  if (result.error) throw result.error;
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  evidence.success = result.status === 0 && report.success === true;
  evidence.assertions = (report.testResults ?? []).flatMap((suite) => (suite.assertionResults ?? []).map((assertion) => ({
    name: assertion.fullName,
    status: assertion.status,
  })));
} catch (error) {
  console.error(`chain-rpc-node26: ${error.message}`);
}
fs.writeFileSync(path.join(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
const errors = validateNode26Evidence(evidence);
if (errors.length) {
  for (const error of errors) console.error(`chain-rpc-node26: ${error}`);
  process.exitCode = 1;
} else {
  const json = JSON.stringify(evidence);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `evidence=${json}\n`);
  console.log(`Verified Node ${evidence.node} / undici ${evidence.undici}: all four required transport assertions passed.`);
}
