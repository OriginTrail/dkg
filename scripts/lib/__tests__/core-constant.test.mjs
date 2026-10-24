import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  requireStringExport,
  resolveCoreStringConstant,
} from '../core-constant.mjs';

test('requireStringExport reads the module value without depending on source formatting', () => {
  assert.equal(
    requireStringExport({ PROTOCOL_STORAGE_ACK: '/dkg/test/storage-ack' }, 'PROTOCOL_STORAGE_ACK'),
    '/dkg/test/storage-ack',
  );
});

test('resolveCoreStringConstant imports a real module export', async () => {
  const source = `
    // Deliberately unlike the TypeScript source spelling that the old sed parser required.
    export const PROTOCOL_STORAGE_ACK = "/dkg/test/storage-ack";
  `;
  const moduleUrl = new URL(`data:text/javascript,${encodeURIComponent(source)}`);
  await assert.doesNotReject(async () => {
    assert.equal(
      await resolveCoreStringConstant('PROTOCOL_STORAGE_ACK', moduleUrl),
      '/dkg/test/storage-ack',
    );
  });
});

test('default resolver and CLI read the canonical built core export', async () => {
  const expected = '/dkg/10.0.1/storage-ack';
  assert.equal(await resolveCoreStringConstant('PROTOCOL_STORAGE_ACK'), expected);

  const scriptPath = fileURLToPath(new URL('../core-constant.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath, 'PROTOCOL_STORAGE_ACK'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, expected);
});

test('missing and non-string exports fail loudly', () => {
  assert.throws(
    () => requireStringExport({}, 'PROTOCOL_STORAGE_ACK'),
    /Core export PROTOCOL_STORAGE_ACK is unavailable/,
  );
  assert.throws(
    () => requireStringExport({ PROTOCOL_STORAGE_ACK: 42 }, 'PROTOCOL_STORAGE_ACK'),
    /must be a non-empty string/,
  );
});
