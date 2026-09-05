import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { hardhatTestEnvironment } from '../hardhat-test-env.mjs';

test('two runs requesting the same port cannot overwrite or remove each other\'s context', (t) => {
  const a = hardhatTestEnvironment(9548);
  const b = hardhatTestEnvironment(9548);
  t.after(() => { for (const env of [a, b]) fs.rmSync(env.DKG_HARDHAT_CONTEXT_FILE, { force: true }); });
  assert.notEqual(a.DKG_HARDHAT_CONTEXT_FILE, b.DKG_HARDHAT_CONTEXT_FILE);
  fs.writeFileSync(a.DKG_HARDHAT_CONTEXT_FILE, 'chain-a');
  fs.writeFileSync(b.DKG_HARDHAT_CONTEXT_FILE, 'chain-b');
  fs.unlinkSync(a.DKG_HARDHAT_CONTEXT_FILE);
  assert.equal(fs.readFileSync(b.DKG_HARDHAT_CONTEXT_FILE, 'utf8'), 'chain-b');
});
