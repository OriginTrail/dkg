import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url));
const { JsonRpcProvider, Contract, getAddress, ZeroAddress } = require('ethers');
const [arm] = process.argv.slice(2), dir = `.tmp/2963/evidence/${arm}`;
const target = `${dir}/chain-deployment.json`;
if (fs.existsSync(target)) throw Error('Refusing to replace captured chain deployment');
const configured = JSON.parse(fs.readFileSync('.tmp/2963/evidence/baseline-balances-nonces.json'));
const receipts = JSON.parse(fs.readFileSync(`${dir}/reconciliation.json`)).receipts;
const provider = new JsonRpcProvider('https://sepolia.base.org');
try {
  const chainId = String((await provider.getNetwork()).chainId);
  if (chainId !== String(configured.chainId)) throw Error('RPC chain differs from campaign configuration');
  const hubAddress = getAddress(configured.hub);
  const hub = new Contract(hubAddress, ['function getAssetStorageAddress(string) view returns(address)'], provider);
  const blocks = [];
  for (const blockNumber of [...new Set(receipts.map(r => r.blockNumber))].sort((a, b) => a - b)) {
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) throw Error('Invalid receipt block');
    await new Promise(resolve => setTimeout(resolve, 400));
    const block = await provider.getBlock(blockNumber);
    if (!block?.hash) throw Error('Historical block unavailable');
    const knowledgeAssets = getAddress(await hub.getAssetStorageAddress('DKGKnowledgeAssets', { blockTag: blockNumber }));
    if (knowledgeAssets === ZeroAddress) throw Error('No DKGKnowledgeAssets binding at receipt block');
    blocks.push({ blockNumber, blockHash: block.hash, knowledgeAssets });
  }
  fs.writeFileSync(target, JSON.stringify({ arm, chainId, hub: hubAddress,
    provenance: 'historical-hub-read-at-receipt-block', capturedAt: new Date().toISOString(), blocks }, null, 2) + '\n', { flag: 'wx' });
  console.log({ arm, historicalBlocks: blocks.length, contracts: [...new Set(blocks.map(b => b.knowledgeAssets))] });
} finally { provider.destroy(); }
