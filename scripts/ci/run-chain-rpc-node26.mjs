#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateNode26Evidence } from '../lib/ci-results.mjs';

// Use the same interpreter for the runner, Vitest, and its cold-request child.
const root = fileURLToPath(new URL('../../', import.meta.url));
const chain = path.join(root, 'packages/chain');

function spawnVitest(reportPath, env) {
  const require = createRequire(path.join(chain, 'package.json'));
  const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  return spawnSync(process.execPath, [
    vitest, 'run', '--config', 'vitest.unit.config.ts',
    'test/rpc-http1-dispatcher.unit.test.ts',
    '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`,
  ], { cwd: chain, env, stdio: 'inherit', timeout: 120_000 });
}

// Tests supply a controlled child and runtime context at this boundary. Report
// collection, evidence validation and publication always use production code;
// the CLI always supplies the actual interpreter, environment and Vitest child.
export function runChainRpcNode26({
  output = path.resolve(process.argv[2] ?? 'chain-rpc-node26-results'),
  versions = process.versions,
  env = process.env,
  runVitest = (reportPath) => spawnVitest(reportPath, env),
} = {}) {
  // Outputs are private to this attempt; a stale report cannot certify a rerun.
  fs.mkdirSync(output, { recursive: true });
  const reportPath = path.join(output, 'vitest.json');
  fs.rmSync(reportPath, { force: true });
  const evidence = {
    version: 1,
    node: versions.node,
    undici: versions.undici,
    requireUndici8Fetch: env.DKG_REQUIRE_UNDICI8_FETCH === '1',
    success: false,
    assertions: [],
  };
  try {
    if (!evidence.node.startsWith('26.') || !evidence.undici?.startsWith('8.') || !evidence.requireUndici8Fetch) {
      throw new Error('requires Node 26 with bundled undici 8 and DKG_REQUIRE_UNDICI8_FETCH=1');
    }
    const result = runVitest(reportPath);
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
    return 1;
  }
  const json = JSON.stringify(evidence);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `evidence=${json}\n`);
  console.log(`Verified Node ${evidence.node} / undici ${evidence.undici}: all four required transport assertions passed.`);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runChainRpcNode26();
}
