import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { verifyPublicationTransaction } from './publication-transaction.mjs';
const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url));
const { Interface, Wallet, Transaction } = require('ethers');
const abi = JSON.parse(fs.readFileSync(new URL('../../packages/chain/abi/KnowledgeAssetsLifecycle.json', import.meta.url)));
const lifecycle = new Interface(abi.abi ?? abi);

async function fixture(override = {}, transactionOverride = {}) {
  const publisher = Wallet.createRandom(), destination = '0x' + '22'.repeat(20), zero = '0x' + '00'.repeat(32);
  const params = { publishOperationId: 'original', contextGraphId: 7n, merkleRoot: '0x' + '33'.repeat(32),
    knowledgeAssetsAmount: 1, byteSize: 1, epochs: 1, tokenAmount: 1, isImmutable: false, merkleLeafCount: 1,
    catalogRoot: zero, catalogLeafCount: 0, publisherNodeIdentityId: 1, authorAddress: '0x' + '44'.repeat(20),
    authorR: zero, authorVS: zero, authorSchemeVersion: 1, reservedKaId: 8, identityIds: [], r: [], vs: [] };
  const seal = { reservedKaId: '8', authorAddress: params.authorAddress, assertionMerkleRoot: params.merkleRoot,
    assertedAtChainId: '84532', assertedAtKav10Address: destination };
  const signedTransaction = await publisher.signTransaction({ type: 2, chainId: 84532, nonce: 5, to: destination,
    data: lifecycle.encodeFunctionData('publish', [{ ...params, ...override }]), gasLimit: 1000000,
    maxFeePerGas: 1, maxPriorityFeePerGas: 1, ...transactionOverride });
  const tx = Transaction.from(signedTransaction);
  return { receipt: { signedTransaction, hash: tx.hash, from: publisher.address, nonce: 5 },
    configured: { chainId: 84532 }, campaign: { contextGraphId: 'owner/campaign' },
    graph: { status: 200, value: { registered: true, uri: 'did:dkg:context-graph:owner/campaign', onChainId: '7' } },
    seal, event: { operationId: 'original' } };
}
const verify = f => verifyPublicationTransaction(f.receipt, f.configured, f.campaign, f.graph, f.seal, f.event);

test('signed publication binds graph, asset and operation independently of requests and event graph omissions', async () => {
  const good = await fixture();
  assert.equal(verify(good).contextGraphMatches, true); assert.equal(verify(good).assetMatches, true);
  assert.equal(verify(await fixture({ contextGraphId: 9n })).contextGraphMatches, false);
  for (const override of [{ reservedKaId: 9 }, { authorAddress: '0x' + '55'.repeat(20) },
    { merkleRoot: '0x' + '66'.repeat(32) }, { publishOperationId: 'replacement' }]) {
    assert.equal(verify(await fixture(override)).assetMatches, false);
  }
  // Preserve the signed bytes when normalizing through ethers' transaction representation.
  assert.equal(Transaction.from(Transaction.from(good.receipt.signedTransaction)).serialized, good.receipt.signedTransaction);
});

test('missing, tampered or misbound transaction/graph inputs cannot certify publication', async () => {
  const good = await fixture();
  for (const mutate of [
    f => { delete f.receipt.signedTransaction; }, f => { f.receipt.signedTransaction = '0x1234'; },
    f => { f.receipt.hash = '0x' + '77'.repeat(32); }, f => { f.receipt.from = '0x' + '77'.repeat(20); },
    f => { f.receipt.nonce++; }, f => { f.configured.chainId = 1; }, f => { f.seal.assertedAtChainId = '1'; },
    f => { f.seal.assertedAtKav10Address = '0x' + '77'.repeat(20); },
    f => { f.graph.status = 503; }, f => { f.graph.value.registered = false; },
    f => { f.graph.value.uri += '/other'; }, f => { delete f.graph.value.onChainId; },
    f => { f.graph.value.onChainId = '0'; }, f => { f.graph.value.onChainId = '07'; },
  ]) { const f = structuredClone(good); mutate(f); assert.throws(() => verify(f)); }
  for (const override of [{ chainId: 1 }, { to: '0x' + '77'.repeat(20) }, { data: '0xdeadbeef' }, { value: 1 }]) {
    const f = await fixture({}, override); assert.throws(() => verify(f));
  }
});
