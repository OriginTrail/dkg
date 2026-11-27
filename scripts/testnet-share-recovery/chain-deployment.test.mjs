import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureDeployment } from './capture-chain-deployment.mjs';

const configured = { chainId: '84532', hub: '0x' + '11'.repeat(20) };
const receipt = { status: 1, hash: '0x' + '22'.repeat(32), blockNumber: 123, blockHash: '0x' + '33'.repeat(32), logs: [] };
const storage = '0x' + '44'.repeat(20);
function fixture() {
  const calls = [];
  return { calls, provider: {
    getNetwork: async () => ({ chainId: 84532n }),
    getBlock: async hash => { assert.equal(hash, receipt.blockHash); return { number: 123, hash }; },
    send: async (method, params) => { calls.push({ method, params }); return '0x' + '0'.repeat(24) + storage.slice(2); },
  } };
}

test('historical Hub state is read at the exact canonical receipt hash, deduplicated across receipts', async () => {
  const { provider, calls } = fixture();
  const result = await captureDeployment('fixture', configured, [receipt, receipt], provider);
  assert.deepEqual(result.blocks, [{ blockNumber: 123, blockHash: receipt.blockHash, knowledgeAssets: storage }]);
  assert.equal(result.provenance, 'historical-hub-read-at-canonical-receipt-hash');
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'eth_call');
  assert.equal(calls[0].params[0].to, configured.hub);
  assert.deepEqual(calls[0].params[1], { blockHash: receipt.blockHash, requireCanonical: true });
});

test('historical collector fails closed on reorgs, malformed receipts, wrong chain and unsupported hash calls', async () => {
  for (const mutate of [
    f => { f.receipts[0].blockHash = undefined; },
    f => { f.receipts[0].blockHash = '0x123'; },
    f => { f.receipts.push({ ...receipt, blockHash: '0x' + '55'.repeat(32) }); },
    f => { f.provider.getBlock = async () => ({ number: 123, hash: '0x' + '55'.repeat(32) }); },
    f => { f.provider.getBlock = async () => ({ number: 124, hash: receipt.blockHash }); },
    f => { f.provider.getNetwork = async () => ({ chainId: 1n }); },
    f => { f.provider.send = async (...args) => { f.calls.push(args); throw Error('Unsupported EIP-1898'); }; },
  ]) {
    const f = { ...fixture(), receipts: [structuredClone(receipt)] }; mutate(f);
    await assert.rejects(captureDeployment('fixture', configured, f.receipts, f.provider));
    assert.ok(f.calls.length <= 1, 'must not fall back to a numbered/latest read');
  }
});
