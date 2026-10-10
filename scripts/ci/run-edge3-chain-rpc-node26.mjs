#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const chain = path.join(root, 'packages/chain');
const output = path.resolve(process.argv[2] ?? 'chain-rpc-node26-results');
const required = [
  'stay on HTTP/1.1 where a plain fetch negotiates HTTP/2',
  'go through a dispatcher the application installed, with its own TLS trust',
  'go through the proxy of NODE_USE_ENV_PROXY',
  'stay on HTTP/1.1 when a chain RPC call is the first request of a fresh process',
].map(name => `chain RPC fetches against a server that offers HTTP/2 (#2828) ${name}`);

fs.mkdirSync(output, { recursive: true });
const reportPath = path.join(output, 'vitest.json');
fs.rmSync(reportPath, { force: true });
const evidence = {
  node: process.versions.node,
  undici: process.versions.undici,
  requireUndici8Fetch: process.env.DKG_REQUIRE_UNDICI8_FETCH === '1',
  success: false,
  assertions: [],
};
let error;
try {
  if (!/^26\.\d+\.\d+$/.test(evidence.node) || !/^8\.\d+\.\d+$/.test(evidence.undici ?? '')
    || !evidence.requireUndici8Fetch) throw new Error('requires Node 26, bundled undici 8 and DKG_REQUIRE_UNDICI8_FETCH=1');
  const require = createRequire(path.join(chain, 'package.json'));
  const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const result = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.unit.config.ts',
    'test/rpc-http1-dispatcher.unit.test.ts', 'test/rpc-http1-transport-wiring.unit.test.ts',
    '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`],
  { cwd: chain, env: process.env, stdio: 'inherit', timeout: 120_000 });
  if (result.error) throw result.error;
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  evidence.success = result.status === 0 && report.success === true;
  evidence.assertions = (report.testResults ?? []).flatMap(suite =>
    (suite.assertionResults ?? []).map(assertion => ({ name: assertion.fullName, status: assertion.status })));
  if (!evidence.success) throw new Error('Node 26 transport tests failed');
  for (const name of required) {
    const matches = evidence.assertions.filter(assertion => assertion.name === name && assertion.status === 'passed');
    if (matches.length !== 1) throw new Error(`required Node 26 assertion did not pass exactly once: ${name}`);
  }
} catch (cause) {
  error = cause;
}
fs.writeFileSync(path.join(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
if (error) {
  console.error(`chain-rpc-node26: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} else {
  console.log(`Verified Node ${evidence.node} / undici ${evidence.undici}: all four runtime assertions passed.`);
}
