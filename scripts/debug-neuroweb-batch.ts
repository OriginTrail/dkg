#!/usr/bin/env npx tsx
import { ethers, JsonRpcProvider, Contract } from 'ethers';

async function main() {
  const provider = new JsonRpcProvider('https://astrosat-parachain-rpc.origin-trail.network/');
  const KCS = '0x8f678eB0E57ee8A109B295710E23076fA3a443fe';
  const kcs = new Contract(KCS, [
    'function getEndEpoch(uint256 id) view returns (uint40)',
    'function getStartEpoch(uint256 id) view returns (uint40)',
    'function getTokenAmount(uint256 id) view returns (uint96)',
    'function getLatestMerkleRootPublisher(uint256 id) view returns (address)',
    'function getLatestKnowledgeCollectionId() view returns (uint256)',
  ], provider);

  const lastId = 6320255;

  // Test different batch sizes for endEpoch only
  for (const batchSize of [1000, 2000, 5000]) {
    const t0 = Date.now();
    const promises = [];
    for (let id = lastId; id > lastId - batchSize; id--) {
      promises.push(kcs.getEndEpoch(id));
    }
    await Promise.all(promises);
    const elapsed = Date.now() - t0;
    console.log(`endEpoch x ${batchSize}: ${elapsed}ms (${(elapsed / batchSize).toFixed(2)}ms/read, ${(batchSize / (elapsed / 1000)).toFixed(0)} reads/sec)`);
  }

  // Test reading all 4 fields at once for 500 KCs
  const t1 = Date.now();
  const all4 = [];
  for (let id = lastId; id > lastId - 500; id--) {
    all4.push(
      Promise.all([
        kcs.getEndEpoch(id),
        kcs.getStartEpoch(id),
        kcs.getTokenAmount(id),
        kcs.getLatestMerkleRootPublisher(id),
      ])
    );
  }
  await Promise.all(all4);
  const e1 = Date.now() - t1;
  console.log(`all-4-fields x 500 (2000 calls): ${e1}ms (${(e1 / 500).toFixed(2)}ms/KC, ${(500 / (e1 / 1000)).toFixed(0)} KCs/sec)`);

  // Test reading all 4 fields for 2000 KCs
  const t2 = Date.now();
  const all4b = [];
  for (let id = lastId; id > lastId - 2000; id--) {
    all4b.push(
      Promise.all([
        kcs.getEndEpoch(id),
        kcs.getStartEpoch(id),
        kcs.getTokenAmount(id),
        kcs.getLatestMerkleRootPublisher(id),
      ])
    );
  }
  await Promise.all(all4b);
  const e2 = Date.now() - t2;
  console.log(`all-4-fields x 2000 (8000 calls): ${e2}ms (${(e2 / 2000).toFixed(2)}ms/KC, ${(2000 / (e2 / 1000)).toFixed(0)} KCs/sec)`);
}

main().catch(console.error);
