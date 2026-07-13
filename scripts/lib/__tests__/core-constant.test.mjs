import { test } from 'node:test';
import assert from 'node:assert/strict';

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
