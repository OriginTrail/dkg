import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url));
const { Interface, Transaction } = require('ethers');
const abi = JSON.parse(fs.readFileSync(new URL('../../packages/chain/abi/KnowledgeAssetsLifecycle.json', import.meta.url)));
const lifecycle = new Interface(abi.abi ?? abi);
const equalHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Bind decoded publication input to the successful receipt, not an untrusted job request. */
export function verifyPublicationTransaction(receipt, configured, campaign, graph, seal, event) {
  if (typeof receipt.signedTransaction !== 'string') throw Error('Missing signed publication transaction');
  const tx = Transaction.from(receipt.signedTransaction);
  if (!tx.isSigned() || !equalHex(tx.hash, receipt.hash) || !equalHex(tx.from, receipt.from)
    || tx.nonce !== receipt.nonce || String(tx.chainId) !== String(configured.chainId)
    || String(tx.chainId) !== seal.assertedAtChainId || !equalHex(tx.to, seal.assertedAtKav10Address)) {
    throw Error('Signed publication transaction identity mismatch');
  }
  const expectedGraph = graph?.value?.onChainId;
  if (graph?.status !== 200 || graph?.value?.registered !== true
    || graph.value.uri !== `did:dkg:context-graph:${campaign.contextGraphId}`
    || typeof expectedGraph !== 'string' || !/^[1-9][0-9]*$/.test(expectedGraph)) {
    throw Error('Missing or mismatched registered campaign graph');
  }
  const decoded = lifecycle.parseTransaction({ data: tx.data, value: tx.value });
  if (decoded?.name !== 'publish' || tx.value !== 0n) throw Error('Unsupported publication transaction');
  const p = decoded.args.p;
  const contextGraphId = p.contextGraphId.toString();
  const contextGraphMatches = contextGraphId === expectedGraph;
  const assetMatches = p.reservedKaId.toString() === seal.reservedKaId
    && equalHex(p.authorAddress, seal.authorAddress) && equalHex(p.merkleRoot, seal.assertionMerkleRoot)
    && !!event && p.publishOperationId === event.operationId;
  return { transactionHash: tx.hash, destination: tx.to, contextGraphId, expectedContextGraphId: expectedGraph,
    contextGraphMatches, assetMatches };
}
