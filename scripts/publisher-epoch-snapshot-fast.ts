#!/usr/bin/env npx tsx
/**
 * publisher-epoch-snapshot-fast.ts
 *
 * Optimized version of publisher-epoch-snapshot.ts that uses raw JSON-RPC
 * batching via fetch() instead of individual ethers.js calls.
 * ~10x faster for direct-read chains like NeuroWeb.
 *
 * Phase 2 & 3 logic is identical to the original script.
 */
import { ethers, JsonRpcProvider, Contract, Interface } from 'ethers';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ── Load .env ───────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv();

// ── Chain configuration ────────────────────────────────────────────────

interface ChainConfig {
  blockchainId: string;
  rpcUrls: string[];
  rpcEnvKey: string;
  KnowledgeCollectionStorage: string;
  KCSDeployBlock: number;
  EpochStorage: string;
  Chronos: string;
}

function buildChainConfig(
  blockchainId: string,
  rpcEnvKey: string,
  fallbackRpc: string,
  kcs: string,
  deployBlock: number,
  epochStorage: string,
  chronos: string,
): ChainConfig {
  const envVal = process.env[rpcEnvKey] ?? '';
  const rpcUrls = envVal
    ? envVal.split(',').map((u) => u.trim()).filter(Boolean)
    : [fallbackRpc];
  return { blockchainId, rpcUrls, rpcEnvKey, KnowledgeCollectionStorage: kcs, KCSDeployBlock: deployBlock, EpochStorage: epochStorage, Chronos: chronos };
}

const CHAINS: Record<string, ChainConfig> = {
  base: buildChainConfig(
    'base:8453', 'RPC_BASE_MAINNET', 'https://mainnet.base.org',
    '0xc28F310A87f7621A087A603E2ce41C22523F11d7', 24189873,
    '0x271Dd66348844bbe1d8bf838a4DAE5b4B7f558A1', '0x07B1442717bbeD003ab2B2165B1b020F3F6B924B',
  ),
  gnosis: buildChainConfig(
    'gnosis:100', 'RPC_GNOSIS_MAINNET', 'https://rpc.gnosischain.com',
    '0x3Cb124E1cDcEECF6E464BB185325608dbe635f5D', 37713054,
    '0x054f356265E7E43f3E1641D00cDF51E762e8Cd58', '0x0913cBBbF760D53A88915a0CFF57ED8A3409b4fe',
  ),
  neuroweb: buildChainConfig(
    'neuroweb:2043', 'RPC_NEUROWEB_MAINNET', 'https://astrosat-parachain-rpc.origin-trail.network/',
    '0x8f678eB0E57ee8A109B295710E23076fA3a443fe', 7237908,
    '0x079C6744ed723Df6da6d18c56520362569D5448A', '0xCFb72d5F0C888Be93d67EeaAf6Daac8507D85853',
  ),
};

// ── ABI / Interface ────────────────────────────────────────────────────

const CHRONOS_ABI = ['function getCurrentEpoch() view returns (uint256)'];

const KC_STORAGE_IFACE = new Interface([
  'function getLatestKnowledgeCollectionId() view returns (uint256)',
  'function getEndEpoch(uint256 id) view returns (uint40)',
  'function getStartEpoch(uint256 id) view returns (uint40)',
  'function getTokenAmount(uint256 id) view returns (uint96)',
  'function getLatestMerkleRootPublisher(uint256 id) view returns (address)',
]);

const EPOCH_STORAGE_ABI = [
  'function getEpochPool(uint256 shardId, uint256 epoch) view returns (uint96)',
];

// ── Configuration ──────────────────────────────────────────────────────

const PARALLEL_BATCHES = 4;
const PHASE1A_BATCH = 2000;    // KCs per batch for endEpoch scan
const PHASE1B_BATCH = 500;     // KCs per batch for detail reads (3 calls each)
const STOP_AFTER = 100_000;    // consecutive past KCs to trigger early stop
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const RPC_BATCH_SIZE = 5;

// ── JSON-RPC batching via fetch ────────────────────────────────────────

async function rpcBatch(
  url: string,
  calls: { to: string; data: string }[],
  maxRetries = MAX_RETRIES,
): Promise<string[]> {
  const body = calls.map((c, i) => ({
    jsonrpc: '2.0',
    id: i + 1,
    method: 'eth_call',
    params: [{ to: c.to, data: c.data }, 'latest'],
  }));

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json() as any[];
      if (!Array.isArray(json)) throw new Error('Expected array response');

      const byId = new Map<number, string>();
      for (const r of json) {
        if (r.error) throw new Error(`RPC error id=${r.id}: ${r.error.message}`);
        byId.set(r.id, r.result);
      }
      return calls.map((_, i) => byId.get(i + 1)!);
    } catch (e: any) {
      if (attempt === maxRetries) throw e;
      console.log(`    Retry ${attempt}/${maxRetries}: ${String(e.message).substring(0, 100)}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
  throw new Error('unreachable');
}

// Fire N batches in parallel against the primary (fastest) RPC
async function parallelRpcBatch(
  rpcUrls: string[],
  batchGroups: { to: string; data: string }[][],
): Promise<string[][]> {
  const url = rpcUrls[0];
  return Promise.all(batchGroups.map((calls) => rpcBatch(url, calls)));
}

// ── Helpers ────────────────────────────────────────────────────────────

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      if (attempt === MAX_RETRIES) throw e;
      console.log(`    Retry ${attempt}/${MAX_RETRIES}: ${e.message?.substring(0, 120)}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
  throw new Error('unreachable');
}

async function batchCall<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}

function bigIntReplacer(_key: string, value: any): any {
  return typeof value === 'bigint' ? value.toString() : value;
}

// ── Types ──────────────────────────────────────────────────────────────

interface PublisherEntry { publisherEVMpubKey: string; tracAmount: number; }
interface EpochSnapshot {
  epochNum: number; blockchainId: string;
  totalTRACAllocated: number; onChainEpochPool: number;
  publishers: PublisherEntry[];
}
interface ChainMeta {
  blockchainId: string; blockNumber: number; blockDate: string;
  currentEpoch: number; lastKnowledgeCollectionId: number;
  totalKCsWithFutureEpochs: number; maxFutureEpoch: number; epochsCapped: number;
}

// ── Core logic ─────────────────────────────────────────────────────────

async function snapshotChain(
  chainName: string,
  cfg: ChainConfig,
): Promise<{ epochs: EpochSnapshot[]; meta: ChainMeta }> {
  const rpcUrls = cfg.rpcUrls;
  const primaryRpc = rpcUrls[0];
  const provider = new JsonRpcProvider(primaryRpc);
  const kcsAddr = cfg.KnowledgeCollectionStorage;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`Snapshotting: ${chainName.toUpperCase()} (${cfg.blockchainId})`);
  console.log(`${'='.repeat(70)}`);
  console.log(`  RPCs: ${rpcUrls.length} endpoints`);

  const chronos = new Contract(cfg.Chronos, CHRONOS_ABI, provider);
  const epochStorageProvider = new JsonRpcProvider(rpcUrls[0]);
  const epochStorage = new Contract(cfg.EpochStorage, EPOCH_STORAGE_ABI, epochStorageProvider);

  const blockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(blockNumber);
  const blockDate = new Date((block?.timestamp ?? 0) * 1000).toISOString();
  const currentEpoch = Number(await chronos.getCurrentEpoch({ blockTag: blockNumber }));

  const kcStorage = new Contract(kcsAddr, KC_STORAGE_IFACE, provider);
  const lastKCId = Number(await kcStorage.getLatestKnowledgeCollectionId({ blockTag: blockNumber }));

  console.log(`  Block:           ${blockNumber} (${blockDate})`);
  console.log(`  Current epoch:   ${currentEpoch}`);
  console.log(`  Total KCs:       ${lastKCId.toLocaleString()}`);

  // ── Phase 1: Check for cached results ──────────────────────────────
  interface FutureKC {
    id: number; startEpoch: number; endEpoch: number;
    tokenAmount: bigint; publisher: string;
  }
  const futureKCs: FutureKC[] = [];
  const cacheDir = path.join(__dirname, '..', 'snapshots');
  const cachePath = path.join(cacheDir, `_cache_phase1_${chainName}_epoch${currentEpoch}.json`);

  if (existsSync(cachePath)) {
    console.log(`  Loading Phase 1 cache: ${cachePath}`);
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    for (const kc of cached) {
      futureKCs.push({ ...kc, tokenAmount: BigInt(kc.tokenAmount) });
    }
    console.log(`  Phase 1 loaded from cache: ${futureKCs.length.toLocaleString()} future KCs`);
  } else {

  // ── Phase 1a: endEpoch scan with JSON-RPC batching ───────────────────
  console.log(`  Phase 1a: Scanning endEpoch for ${lastKCId.toLocaleString()} KCs (batched)...`);

  const futureIds: number[] = [];
  const futureEndEpochs = new Map<number, number>();
  let consecutivePast = 0;
  let lastLogTime = Date.now();
  const totalPerRound = PARALLEL_BATCHES * PHASE1A_BATCH;

  for (let cursor = lastKCId; cursor >= 1 && consecutivePast < STOP_AFTER; cursor -= totalPerRound) {
    // Build PARALLEL_BATCHES groups, each with PHASE1A_BATCH KCs
    const groups: { to: string; data: string }[][] = [];
    const idGroups: number[][] = [];

    for (let b = 0; b < PARALLEL_BATCHES; b++) {
      const startId = cursor - b * PHASE1A_BATCH;
      if (startId < 1) break;
      const ids: number[] = [];
      const calls: { to: string; data: string }[] = [];
      for (let id = startId; id >= Math.max(startId - PHASE1A_BATCH + 1, 1); id--) {
        ids.push(id);
        calls.push({ to: kcsAddr, data: KC_STORAGE_IFACE.encodeFunctionData('getEndEpoch', [id]) });
      }
      groups.push(calls);
      idGroups.push(ids);
    }

    const results = await parallelRpcBatch(rpcUrls, groups);

    for (let b = 0; b < results.length; b++) {
      const ids = idGroups[b];
      const hexResults = results[b];
      for (let i = 0; i < ids.length; i++) {
        const ee = Number(BigInt(hexResults[i]));
        if (ee > currentEpoch) {
          futureIds.push(ids[i]);
          futureEndEpochs.set(ids[i], ee);
          consecutivePast = 0;
        } else {
          consecutivePast++;
        }
      }
    }

    const now = Date.now();
    if (now - lastLogTime > 10_000 || cursor <= totalPerRound || consecutivePast >= STOP_AFTER) {
      const scanned = lastKCId - cursor + totalPerRound;
      const pct = ((scanned / lastKCId) * 100).toFixed(1);
      console.log(
        `    ${pct}% (KC ${Math.max(cursor - totalPerRound + 1, 1).toLocaleString()}) — ` +
        `${futureIds.length.toLocaleString()} future, ${consecutivePast.toLocaleString()} consecutive past`,
      );
      lastLogTime = now;
    }
  }

  if (consecutivePast >= STOP_AFTER) {
    console.log(`    Early stop: ${STOP_AFTER.toLocaleString()} consecutive past KCs`);
  }
  console.log(`  Phase 1a done: ${futureIds.length.toLocaleString()} future KC IDs found`);

  // ── Phase 1b: detail reads with JSON-RPC batching ────────────────────
  if (futureIds.length > 0) {
    console.log(`  Phase 1b: Reading details for ${futureIds.length.toLocaleString()} future KCs (batched)...`);
    lastLogTime = Date.now();
    const detailPerRound = PARALLEL_BATCHES * PHASE1B_BATCH;

    for (let i = 0; i < futureIds.length; i += detailPerRound) {
      const groups: { to: string; data: string }[][] = [];
      const idGroups: number[][] = [];

      for (let b = 0; b < PARALLEL_BATCHES; b++) {
        const sliceStart = i + b * PHASE1B_BATCH;
        if (sliceStart >= futureIds.length) break;
        const ids = futureIds.slice(sliceStart, Math.min(sliceStart + PHASE1B_BATCH, futureIds.length));
        const calls: { to: string; data: string }[] = [];
        for (const id of ids) {
          calls.push({ to: kcsAddr, data: KC_STORAGE_IFACE.encodeFunctionData('getStartEpoch', [id]) });
          calls.push({ to: kcsAddr, data: KC_STORAGE_IFACE.encodeFunctionData('getTokenAmount', [id]) });
          calls.push({ to: kcsAddr, data: KC_STORAGE_IFACE.encodeFunctionData('getLatestMerkleRootPublisher', [id]) });
        }
        groups.push(calls);
        idGroups.push(ids);
      }

      const results = await parallelRpcBatch(rpcUrls, groups);

      for (let b = 0; b < results.length; b++) {
        const ids = idGroups[b];
        const hexResults = results[b];
        for (let j = 0; j < ids.length; j++) {
          const startEpoch = Number(BigInt(hexResults[j * 3]));
          const tokenAmount = BigInt(hexResults[j * 3 + 1]);
          const pubRaw = hexResults[j * 3 + 2];
          const publisher = ethers.getAddress('0x' + pubRaw.slice(26)).toLowerCase();

          if (tokenAmount === 0n || publisher === ethers.ZeroAddress.toLowerCase()) continue;
          futureKCs.push({
            id: ids[j],
            startEpoch,
            endEpoch: futureEndEpochs.get(ids[j])!,
            tokenAmount,
            publisher,
          });
        }
      }

      const now = Date.now();
      if (now - lastLogTime > 10_000 || i + detailPerRound >= futureIds.length) {
        const done = Math.min(i + detailPerRound, futureIds.length);
        const pct = ((done / futureIds.length) * 100).toFixed(1);
        console.log(`    ${pct}% — ${futureKCs.length.toLocaleString()} KCs with details`);
        lastLogTime = now;
      }
    }
  }

  // Save cache for Phase 1 results
  if (!existsSync(cachePath)) {
    const cacheData = futureKCs.map(kc => ({ ...kc, tokenAmount: kc.tokenAmount.toString() }));
    writeFileSync(cachePath, JSON.stringify(cacheData) + '\n');
    console.log(`  Phase 1 cache saved: ${cachePath}`);
  }

  } // end of else (cache miss)

  console.log(`  Phase 1 done: ${futureKCs.length.toLocaleString()} future KCs with publisher`);

  if (futureKCs.length === 0) {
    return {
      epochs: [],
      meta: {
        blockchainId: cfg.blockchainId, blockNumber, blockDate, currentEpoch,
        lastKnowledgeCollectionId: lastKCId, totalKCsWithFutureEpochs: 0,
        maxFutureEpoch: currentEpoch, epochsCapped: 0,
      },
    };
  }

  // ── Phase 2: Compute per-epoch allocations ───────────────────────────
  console.log('  Phase 2: Computing per-epoch publisher allocations...');

  const epochPublisherMap = new Map<number, Map<string, bigint>>();
  let maxFutureEpoch = currentEpoch;

  for (const kc of futureKCs) {
    const epochs = kc.endEpoch - kc.startEpoch;
    if (epochs <= 0) continue;

    const perFullEpochWei = kc.tokenAmount / BigInt(epochs);
    const firstRefundEpoch = Math.max(kc.startEpoch, currentEpoch);

    for (let epoch = firstRefundEpoch; epoch <= kc.endEpoch; epoch++) {
      if (!epochPublisherMap.has(epoch)) epochPublisherMap.set(epoch, new Map());
      const publisherMap = epochPublisherMap.get(epoch)!;
      publisherMap.set(kc.publisher, (publisherMap.get(kc.publisher) ?? 0n) + perFullEpochWei);
      if (epoch > maxFutureEpoch) maxFutureEpoch = epoch;
    }
  }

  console.log(`  Epochs covered (current + future): ${currentEpoch} → ${maxFutureEpoch}`);

  // ── Phase 3: Cross-check against on-chain epoch pools ────────────────
  const sortedEpochs = [...epochPublisherMap.keys()].sort((a, b) => a - b);
  console.log(`  Phase 3: Fetching on-chain epoch pools for ${sortedEpochs.length} epochs...`);

  const onChainPools = new Map<number, bigint>();
  await batchCall(sortedEpochs, RPC_BATCH_SIZE, async (epochNum) => {
    const pool: bigint = await retry(() =>
      epochStorage.getEpochPool(1, epochNum, { blockTag: blockNumber }),
    );
    onChainPools.set(epochNum, pool);
  });

  const epochSnapshots: EpochSnapshot[] = [];
  let epochsScaled = 0;

  for (const epochNum of sortedEpochs) {
    const publisherMap = epochPublisherMap.get(epochNum)!;
    const onChainPoolWei = onChainPools.get(epochNum) ?? 0n;

    let computedTotalWei = 0n;
    for (const weiAmount of publisherMap.values()) computedTotalWei += weiAmount;

    const needsScaling = onChainPoolWei > 0n && computedTotalWei > 0n && computedTotalWei !== onChainPoolWei;
    if (needsScaling) epochsScaled++;

    const publishers: PublisherEntry[] = [];
    let scaledTotalWei = 0n;

    for (const [pubKey, weiAmount] of publisherMap.entries()) {
      let finalWei = weiAmount;
      if (needsScaling) finalWei = (weiAmount * onChainPoolWei) / computedTotalWei;
      scaledTotalWei += finalWei;
      publishers.push({
        publisherEVMpubKey: pubKey,
        tracAmount: parseFloat(ethers.formatEther(finalWei)),
      });
    }

    publishers.sort((a, b) => b.tracAmount - a.tracAmount);

    epochSnapshots.push({
      epochNum,
      blockchainId: cfg.blockchainId,
      totalTRACAllocated: parseFloat(ethers.formatEther(scaledTotalWei)),
      onChainEpochPool: parseFloat(ethers.formatEther(onChainPoolWei)),
      publishers,
    });
  }

  // ── Verification ──────────────────────────────────────────────────────
  console.log('\n  ── Per-epoch verification (sum vs on-chain pool) ──');
  let allMatch = true;
  for (const snap of epochSnapshots) {
    const sumTRAC = snap.publishers.reduce((s, p) => s + p.tracAmount, 0);
    const diff = Math.abs(sumTRAC - snap.onChainEpochPool);
    const pct = snap.onChainEpochPool > 0 ? ((diff / snap.onChainEpochPool) * 100).toFixed(4) : '0';
    const status = diff < 0.01 ? '✓' : (diff < 1 ? '~' : '✗');
    if (status === '✗') allMatch = false;
    console.log(
      `    Epoch ${snap.epochNum}: sum=${sumTRAC.toFixed(2)}  pool=${snap.onChainEpochPool.toFixed(2)}  diff=${diff.toFixed(6)} (${pct}%)  ${status}`,
    );
  }
  if (allMatch) console.log('  ✓ All epochs match on-chain pool (within rounding)');
  else console.log('  ⚠ Some epochs have significant differences — review above');

  if (epochsScaled > 0) console.log(`  ℹ ${epochsScaled} epoch(s) proportionally scaled to match on-chain pool`);

  return {
    epochs: epochSnapshots,
    meta: {
      blockchainId: cfg.blockchainId, blockNumber, blockDate, currentEpoch,
      lastKnowledgeCollectionId: lastKCId, totalKCsWithFutureEpochs: futureKCs.length,
      maxFutureEpoch, epochsCapped: epochsScaled,
    },
  };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const chainFilter = process.argv[2];

  if (chainFilter && !CHAINS[chainFilter]) {
    console.error(`Unknown chain: "${chainFilter}". Must be one of: ${Object.keys(CHAINS).join(', ')}`);
    process.exit(1);
  }

  const outDir = path.join(__dirname, '..', 'snapshots');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const unixTs = Math.floor(Date.now() / 1000);
  const chainsToProcess = chainFilter
    ? [[chainFilter, CHAINS[chainFilter]] as const]
    : (Object.entries(CHAINS) as [string, ChainConfig][]);

  console.log(`Chains: ${chainsToProcess.map(([n]) => n).join(', ')}`);

  const allEpochs: EpochSnapshot[] = [];
  const allMeta: Record<string, ChainMeta> = {};

  for (const [chainName, cfg] of chainsToProcess) {
    try {
      const { epochs, meta } = await snapshotChain(chainName, cfg);
      allEpochs.push(...epochs);
      allMeta[chainName] = meta;
    } catch (err: any) {
      console.error(`[${chainName}] FAILED: ${err.message}`);
    }
  }

  const epochsPath = path.join(outDir, `neuroweb_publisher_snapshot_epoch${allMeta[chainsToProcess[0][0]]?.currentEpoch ?? 'X'}.json`);
  writeFileSync(epochsPath, JSON.stringify(allEpochs, null, 2) + '\n');
  console.log(`\nEpoch snapshots saved: ${epochsPath} (${allEpochs.length} epoch entries)`);

  const metaPath = path.join(outDir, `neuroweb_publisher_snapshot_epoch${allMeta[chainsToProcess[0][0]]?.currentEpoch ?? 'X'}_meta.json`);
  writeFileSync(metaPath, JSON.stringify(allMeta, bigIntReplacer, 2) + '\n');
  console.log(`Metadata saved: ${metaPath}`);

  console.log('\n=== Summary ===');
  for (const [chain, meta] of Object.entries(allMeta)) {
    const chainEpochs = allEpochs.filter((e) => e.blockchainId === meta.blockchainId);
    const totalTRAC = chainEpochs.reduce((sum, e) => sum + e.totalTRACAllocated, 0);
    const uniquePublishers = new Set(chainEpochs.flatMap((e) => e.publishers.map((p) => p.publisherEVMpubKey)));
    console.log(`  ${chain}: ${chainEpochs.length} future epochs, ${uniquePublishers.size} publishers, ${totalTRAC.toFixed(2)} TRAC allocated`);
    if (meta.epochsCapped > 0) console.log(`    └─ ${meta.epochsCapped} epoch(s) scaled to on-chain pool`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
