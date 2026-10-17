import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isHash, requireReceiptBlockIdentity } from './chain-block-identity.mjs';
const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url));
const { JsonRpcProvider, Interface, getAddress, ZeroAddress } = require('ethers');
const hubInterface = new Interface(['function getAssetStorageAddress(string) view returns(address)']);

export async function captureDeployment(arm, configured, receipts, provider) {
  const chainId = String((await provider.getNetwork()).chainId);
  if (chainId !== String(configured.chainId)) throw Error('RPC chain differs from campaign configuration');
  const hub = getAddress(configured.hub), identities = new Map();
  for (const receipt of receipts) {
    const identity = requireReceiptBlockIdentity(receipt), prior = identities.get(identity.blockNumber);
    if (prior && prior.blockHash.toLowerCase() !== identity.blockHash.toLowerCase()) throw Error('Conflicting receipt block identities');
    identities.set(identity.blockNumber, identity);
  }
  const blocks = [];
  for (const { blockNumber, blockHash } of [...identities.values()].sort((a, b) => a.blockNumber - b.blockNumber)) {
    await new Promise(resolve => setTimeout(resolve, 400));
    const block = await provider.getBlock(blockHash);
    if (!isHash(block?.hash) || block.hash.toLowerCase() !== blockHash.toLowerCase() || block.number !== blockNumber) {
      throw Error('Historical receipt block unavailable or mismatched');
    }
    // EIP-1898 pins state and canonicality to the receipt hash. Never fall back to a numbered/latest read.
    const result = await provider.send('eth_call', [{ to: hub,
      data: hubInterface.encodeFunctionData('getAssetStorageAddress', ['DKGKnowledgeAssets']) }, { blockHash, requireCanonical: true }]);
    const knowledgeAssets = getAddress(hubInterface.decodeFunctionResult('getAssetStorageAddress', result)[0]);
    if (knowledgeAssets === ZeroAddress) throw Error('No DKGKnowledgeAssets binding at receipt block');
    blocks.push({ blockNumber, blockHash, knowledgeAssets });
  }
  return { arm, chainId, hub, provenance: 'historical-hub-read-at-canonical-receipt-hash', capturedAt: new Date().toISOString(), blocks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [arm] = process.argv.slice(2), dir = `.tmp/2963/evidence/${arm}`, target = `${dir}/chain-deployment.json`;
  if (fs.existsSync(target)) throw Error('Refusing to replace captured chain deployment');
  const configured = JSON.parse(fs.readFileSync('.tmp/2963/evidence/baseline-balances-nonces.json'));
  const receipts = JSON.parse(fs.readFileSync(`${dir}/reconciliation.json`)).receipts;
  const provider = new JsonRpcProvider('https://sepolia.base.org');
  try {
    const deployment = await captureDeployment(arm, configured, receipts, provider);
    fs.writeFileSync(target, JSON.stringify(deployment, null, 2) + '\n', { flag: 'wx' });
    console.log({ arm, historicalBlocks: deployment.blocks.length, contracts: [...new Set(deployment.blocks.map(b => b.knowledgeAssets))] });
  } finally { provider.destroy(); }
}
