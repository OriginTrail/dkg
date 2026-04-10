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

  const lastId = Number(await kcs.getLatestKnowledgeCollectionId());
  console.log('Last KC ID:', lastId);

  // Test batch read speed: 100 KCs at once
  const batchSize = 100;
  const startId = lastId - batchSize + 1;

  console.log(`\nBatch reading endEpoch for ${batchSize} KCs (${startId} → ${lastId})...`);
  const t0 = Date.now();
  const promises = [];
  for (let id = startId; id <= lastId; id++) {
    promises.push(kcs.getEndEpoch(id));
  }
  const results = await Promise.all(promises);
  const elapsed = Date.now() - t0;
  console.log(`  ${elapsed}ms for ${batchSize} reads (${(elapsed / batchSize).toFixed(1)}ms/read)`);
  
  const futureCount = results.filter(e => Number(e) > 16).length;
  console.log(`  Future KCs in latest ${batchSize}: ${futureCount}/${batchSize}`);

  // Test 500 at once
  console.log(`\nBatch reading endEpoch for 500 KCs (${lastId - 499} → ${lastId})...`);
  const t1 = Date.now();
  const promises2 = [];
  for (let id = lastId - 499; id <= lastId; id++) {
    promises2.push(kcs.getEndEpoch(id));
  }
  const results2 = await Promise.all(promises2);
  const elapsed2 = Date.now() - t1;
  console.log(`  ${elapsed2}ms for 500 reads (${(elapsed2 / 500).toFixed(1)}ms/read)`);
  
  const futureCount2 = results2.filter(e => Number(e) > 16).length;
  console.log(`  Future KCs in latest 500: ${futureCount2}/500`);

  // Check a sample of endEpochs to get a feel for distribution
  console.log('\nSample endEpochs from latest KCs:');
  for (let i = 0; i < 10; i++) {
    const id = lastId - i;
    const endEpoch = Number(results[batchSize - 1 - i]);
    const startEpoch = Number(await kcs.getStartEpoch(id));
    const tokenAmount = await kcs.getTokenAmount(id);
    const publisher = await kcs.getLatestMerkleRootPublisher(id);
    console.log(`  KC ${id}: start=${startEpoch} end=${endEpoch} tokens=${ethers.formatEther(tokenAmount)} publisher=${publisher.substring(0,10)}...`);
  }
}

main().catch(console.error);
