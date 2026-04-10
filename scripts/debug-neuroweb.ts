#!/usr/bin/env npx tsx
import { ethers, JsonRpcProvider, Interface } from 'ethers';

const RPC = process.argv[2] || 'https://pulsar.neuroweb.ai/';

async function main() {
  console.log(`Testing RPC: ${RPC}\n`);
  const provider = new JsonRpcProvider(RPC);
  const KCS = '0x8f678eB0E57ee8A109B295710E23076fA3a443fe';
  const iface = new Interface([
    'event KnowledgeCollectionCreated(uint256 indexed id, string publishOperationId, bytes32 merkleRoot, uint88 byteSize, uint40 startEpoch, uint40 endEpoch, uint96 tokenAmount, bool isImmutable)',
    'event KnowledgeAssetsMinted(uint256 indexed id, address indexed to, uint256 startId, uint256 endId)',
  ]);
  const createdTopic = iface.getEvent('KnowledgeCollectionCreated')!.topicHash;
  const mintedTopic = iface.getEvent('KnowledgeAssetsMinted')!.topicHash;

  const bn = await provider.getBlockNumber();
  console.log('Current block:', bn);
  console.log('Created topic:', createdTopic);
  console.log('Minted topic:', mintedTopic);

  // Try last 5000 blocks with address + both topics
  const logs = await provider.getLogs({
    address: KCS,
    topics: [[createdTopic, mintedTopic]],
    fromBlock: bn - 5000,
    toBlock: bn,
  });
  console.log('Logs with dual-topic OR (last 5000 blocks):', logs.length);

  // Try with single topic (Created only)
  const logs2 = await provider.getLogs({
    address: KCS,
    topics: [createdTopic],
    fromBlock: bn - 5000,
    toBlock: bn,
  });
  console.log('Created events only (last 5000 blocks):', logs2.length);

  // Try without topic filter, just address
  const logs3 = await provider.getLogs({
    address: KCS,
    fromBlock: bn - 100,
    toBlock: bn,
  });
  console.log('Any events from KCS (last 100 blocks):', logs3.length);
  if (logs3.length > 0) {
    console.log('Sample log topics:', logs3[0].topics);
  }

  // Try getting ALL logs in a single recent block (no filters)
  const logs4 = await provider.getLogs({
    fromBlock: bn - 1,
    toBlock: bn,
  });
  console.log('ALL events in last 2 blocks (no filter):', logs4.length);
  if (logs4.length > 0) {
    console.log('Sample:', logs4[0].address, logs4[0].topics[0]);
  }

  // ── Test 1: Basic contract reads ──
  const kcs = new ethers.Contract(KCS, [
    'function getEndEpoch(uint256 id) view returns (uint40)',
    'function getLatestKnowledgeCollectionId() view returns (uint256)',
  ], provider);
  const chronos = new ethers.Contract('0xCFb72d5F0C888Be93d67EeaAf6Daac8507D85853', [
    'function getCurrentEpoch() view returns (uint256)',
  ], provider);

  const currentEpoch = Number(await chronos.getCurrentEpoch());
  const lastId = Number(await kcs.getLatestKnowledgeCollectionId());
  console.log('Current epoch:', currentEpoch);
  console.log('Total KCs:', lastId.toLocaleString());

  // ── Test 2: eth_getLogs with different range sizes ──
  console.log('\n--- eth_getLogs tests ---');

  for (const range of [50, 500, 2500, 10000]) {
    const from = bn - range;
    try {
      const t0 = Date.now();
      const logs = await provider.getLogs({
        address: KCS,
        topics: [[createdTopic, mintedTopic]],
        fromBlock: from,
        toBlock: bn,
      });
      console.log(`  Range ${range} blocks (recent): ${logs.length} events in ${Date.now() - t0}ms`);
    } catch (e: any) {
      console.log(`  Range ${range} blocks (recent): ERROR — ${e.message?.substring(0, 100)}`);
    }
  }

  // Try a range in the middle of the chain where KCs were being published
  const midBlock = Math.floor((7_237_908 + bn) / 2);
  for (const range of [50, 500, 2500]) {
    try {
      const t0 = Date.now();
      const logs = await provider.getLogs({
        address: KCS,
        topics: [[createdTopic, mintedTopic]],
        fromBlock: midBlock,
        toBlock: midBlock + range,
      });
      console.log(`  Range ${range} blocks (mid-chain ~${midBlock}): ${logs.length} events in ${Date.now() - t0}ms`);
    } catch (e: any) {
      console.log(`  Range ${range} blocks (mid-chain): ERROR — ${e.message?.substring(0, 100)}`);
    }
  }

  // ── Test 3: Direct read performance ──
  console.log('\n--- Direct read performance ---');
  for (const batchSize of [200, 500, 1000, 2000]) {
    const t0 = Date.now();
    const promises = [];
    for (let id = lastId; id > lastId - batchSize; id--) {
      promises.push(kcs.getEndEpoch(id));
    }
    try {
      await Promise.all(promises);
      const elapsed = Date.now() - t0;
      console.log(`  getEndEpoch x ${batchSize}: ${elapsed}ms (${(batchSize / (elapsed / 1000)).toFixed(0)} reads/sec)`);
    } catch (e: any) {
      console.log(`  getEndEpoch x ${batchSize}: FAILED — ${e.message?.substring(0, 100)}`);
    }
  }

  console.log('\n--- Summary ---');
  console.log('If eth_getLogs returned events: use event scanning (fast, ~90 min)');
  console.log('If only direct reads work: use direct reads (slower, hours)');
}

main().catch(console.error);
