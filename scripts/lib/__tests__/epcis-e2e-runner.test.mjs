import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('the explicit EPCIS e2e command fails closed when the node is unreachable', {
  timeout: 35_000,
}, () => {
  const result = spawnSync(
    'pnpm',
    ['--filter', '@origintrail-official/dkg-epcis', 'run', 'test:e2e'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DKG_API_PORT: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(output, /EPCIS live-node prerequisites are required/);
});
