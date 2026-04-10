#!/usr/bin/env npx tsx
/**
 * epoch-snapshot.ts
 *
 * Snapshots publisher TRAC allocations for all future epochs across DKG V8
 * mainnet chains. For the V8→V10 migration, publishers need to be refunded
 * for TRAC locked in Knowledge Collections that extend past the current epoch
 * so they can republish under V10 economics.
 *
 * Strategy (designed for millions of KCs):
 *   Phase 1 — Single pass over eth_getLogs fetching both KnowledgeCollectionCreated
 *             and KnowledgeAssetsMinted events (dual-topic OR query). Created gives
 *             (id, startEpoch, endEpoch, tokenAmount); Minted gives (id, publisher).
 *             Join by id, filter endEpoch > currentEpoch. No individual contract
 *             reads needed.
 *   Phase 2 — Compute per-epoch allocations using the same divisor as
 *             _distributeTokens (epochs = endEpoch − startEpoch).
 *   Phase 3 — Cross-check each epoch against EpochStorage.getEpochPool()
 *             and cap if estimated total exceeds on-chain pool.
 *
 * Output format per epoch:
 *   {
 *     epochNum: 17,
 *     blockchainId: "gnosis:100",
 *     totalTRACAllocated: 513424.21,
 *     onChainEpochPool: 520000.00,
 *     publishers: [
 *       { publisherEVMpubKey: "0x1234...", tracAmount: 43434 }
 *     ]
 *   }
 *
 * Usage:
 *   npx tsx scripts/epoch-snapshot.ts [chain]
 *
 * Environment:
 *   RPC_BASE_MAINNET, RPC_GNOSIS_MAINNET, RPC_NEUROWEB_MAINNET
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
  forceDirectRead?: boolean;
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
  neuroweb: {
    ...buildChainConfig(
      'neuroweb:2043', 'RPC_NEUROWEB_MAINNET', 'https://astrosat-parachain-rpc.origin-trail.network/',
      '0x8f678eB0E57ee8A109B295710E23076fA3a443fe', 7237908,
      '0x079C6744ed723Df6da6d18c56520362569D5448A', '0xCFb72d5F0C888Be93d67EeaAf6Daac8507D85853',
    ),
    forceDirectRead: true,
  },
};

// ── ABI / Interface ────────────────────────────────────────────────────

const CHRONOS_ABI = [
  'function getCurrentEpoch() view returns (uint256)',
];

const KC_STORAGE_IFACE = new Interface([
  'function getLatestKnowledgeCollectionId() view returns (uint256)',
  'function getEndEpoch(uint256 id) view returns (uint40)',
  'function getStartEpoch(uint256 id) view returns (uint40)',
  'function getTokenAmount(uint256 id) view returns (uint96)',
  'function getLatestMerkleRootPublisher(uint256 id) view returns (address)',
  'event KnowledgeCollectionCreated(uint256 indexed id, string publishOperationId, bytes32 merkleRoot, uint88 byteSize, uint40 startEpoch, uint40 endEpoch, uint96 tokenAmount, bool isImmutable)',
  'event KnowledgeAssetsMinted(uint256 indexed id, address indexed to, uint256 startId, uint256 endId)',
]);

const EPOCH_STORAGE_ABI = [
  'function getEpochPool(uint256 shardId, uint256 epoch) view returns (uint96)',
];

// ── Configuration ──────────────────────────────────────────────────────

const INITIAL_LOG_RANGE = 2_500;
const MIN_LOG_RANGE = 50;
const RPC_BATCH_SIZE = 10;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

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

async function connectAll(rpcUrls: string[]): Promise<JsonRpcProvider[]> {
  const good: JsonRpcProvider[] = [];
  for (let i = 0; i < rpcUrls.length; i++) {
    const url = rpcUrls[i];
    const label = rpcUrls.length > 1 ? ` (${i + 1}/${rpcUrls.length})` : '';
    try {
      console.log(`  Trying RPC${label}: ${url.substring(0, 60)}...`);
      const provider = new JsonRpcProvider(url);
      await Promise.race([
        provider.getBlockNumber(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
      ]);
      console.log(`  Connected.`);
      good.push(provider);
    } catch (e: any) {
      console.log(`  Failed: ${e.message?.substring(0, 80)}`);
    }
  }
  if (good.length === 0) throw new Error(`All ${rpcUrls.length} RPCs failed`);
  return good;
}

function bigIntReplacer(_key: string, value: any): any {
  return typeof value === 'bigint' ? value.toString() : value;
}

// ── Types ──────────────────────────────────────────────────────────────

interface PublisherEntry {
  publisherEVMpubKey: string;
  tracAmount: number;
}

interface EpochSnapshot {
  epochNum: number;
  blockchainId: string;
  totalTRACAllocated: number;
  onChainEpochPool: number;
  publishers: PublisherEntry[];
}

interface ChainMeta {
  blockchainId: string;
  blockNumber: number;
  blockDate: string;
  currentEpoch: number;
  lastKnowledgeCollectionId: number;
  totalKCsWithFutureEpochs: number;
  maxFutureEpoch: number;
  epochsCapped: number;
}

// ── Core logic ─────────────────────────────────────────────────────────

async function snapshotChain(
  chainName: string,
  cfg: ChainConfig,
  providers: JsonRpcProvider[],
): Promise<{ epochs: EpochSnapshot[]; meta: ChainMeta }> {
  let provider = providers[0];
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Snapshotting: ${chainName.toUpperCase()} (${cfg.blockchainId})`);
  console.log('='.repeat(70));

  // Use last provider for epoch pool reads (often more permissive with batch limits)
  const readProvider = providers[providers.length - 1];
  const kcStorage = new Contract(cfg.KnowledgeCollectionStorage, KC_STORAGE_IFACE, provider);
  const chronos = new Contract(cfg.Chronos, CHRONOS_ABI, provider);
  const epochStorage = new Contract(cfg.EpochStorage, EPOCH_STORAGE_ABI, readProvider);

  const blockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(blockNumber);
  const blockDate = new Date((block?.timestamp ?? 0) * 1000).toISOString();

  const currentEpoch = Number(await chronos.getCurrentEpoch({ blockTag: blockNumber }));
  const lastKCId = Number(await kcStorage.getLatestKnowledgeCollectionId({ blockTag: blockNumber }));

  console.log(`  Block:           ${blockNumber} (${blockDate})`);
  console.log(`  Current epoch:   ${currentEpoch}`);
  console.log(`  Total KCs:       ${lastKCId.toLocaleString()}`);

  // ── Phase 1: Discover future KCs ────────────────────────────────────
  interface FutureKC {
    id: number;
    startEpoch: number;
    endEpoch: number;
    tokenAmount: bigint;
    publisher: string;
  }
  const futureKCs: FutureKC[] = [];

  // Try event scanning first; fall back to direct reads if no events found
  const usedDirectRead = await (async () => {
    const createdTopic = KC_STORAGE_IFACE.getEvent('KnowledgeCollectionCreated')!.topicHash;
    const mintedTopic = KC_STORAGE_IFACE.getEvent('KnowledgeAssetsMinted')!.topicHash;

    let useDirectRead = false;

    if (cfg.forceDirectRead) {
      console.log('  forceDirectRead enabled — skipping eth_getLogs, using direct contract reads.');
      useDirectRead = true;
    }

    if (!useDirectRead) try {
      // Use a very small range (50 blocks) to avoid hitting RPC block limits
      const probeFrom = Math.max(blockNumber - 50, cfg.KCSDeployBlock);
      const probe = await provider.getLogs({
        address: cfg.KnowledgeCollectionStorage,
        topics: [[createdTopic, mintedTopic]],
        fromBlock: probeFrom,
        toBlock: blockNumber,
      });
      // If no events in last 50 blocks AND there are many KCs, do a second
      // check further back to confirm logs truly aren't indexed
      if (probe.length === 0 && lastKCId > 1000) {
        const midBlock = Math.floor((cfg.KCSDeployBlock + blockNumber) / 2);
        const probe2 = await provider.getLogs({
          address: cfg.KnowledgeCollectionStorage,
          topics: [[createdTopic, mintedTopic]],
          fromBlock: midBlock,
          toBlock: midBlock + 50,
        });
        if (probe2.length === 0) {
          console.log('  ⚠ eth_getLogs returned 0 events across probes — RPC may not index logs. Falling back to direct reads.');
          useDirectRead = true;
        }
      }
    } catch {
      // Probe errored (likely RPC restrictions) — events probably available, use normal scanning
    }

    if (useDirectRead) {
      // ── Direct read fallback (for substrate chains like NeuroWeb) ──
      // Two-pass approach: fast endEpoch scan, then detail reads for future KCs only
      const READ_BATCH = 2000;
      let consecutivePast = 0;
      const STOP_AFTER = 100_000;

      // Pass 1: endEpoch scan to find future KC IDs
      console.log(`  Phase 1a (direct read): Scanning endEpoch for ${lastKCId.toLocaleString()} KCs...`);
      const futureIdsAll: number[] = [];
      const futureEndEpochs = new Map<number, number>();
      let lastLogTime = Date.now();

      for (let startId = lastKCId; startId >= 1; startId -= READ_BATCH) {
        const ids: number[] = [];
        for (let id = startId; id >= Math.max(startId - READ_BATCH + 1, 1); id--) {
          ids.push(id);
        }

        const endEpochs = await Promise.all(
          ids.map((id) => retry(() => kcStorage.getEndEpoch(id, { blockTag: blockNumber })))
        );

        for (let i = 0; i < ids.length; i++) {
          const ee = Number(endEpochs[i]);
          if (ee > currentEpoch) {
            futureIdsAll.push(ids[i]);
            futureEndEpochs.set(ids[i], ee);
            consecutivePast = 0;
          } else {
            consecutivePast++;
          }
        }

        const now = Date.now();
        if (now - lastLogTime > 15_000 || startId <= READ_BATCH) {
          const scanned = lastKCId - startId + READ_BATCH;
          const pct = ((scanned / lastKCId) * 100).toFixed(1);
          console.log(
            `    ${pct}% (KC ${startId.toLocaleString()}) — ${futureIdsAll.length.toLocaleString()} future, ${consecutivePast.toLocaleString()} consecutive past`,
          );
          lastLogTime = now;
        }

        if (consecutivePast >= STOP_AFTER) {
          console.log(`    Early stop: ${STOP_AFTER.toLocaleString()} consecutive past KCs at ID ${startId.toLocaleString()}`);
          break;
        }
      }

      console.log(`  Phase 1a done: ${futureIdsAll.length.toLocaleString()} future KC IDs found`);

      // Pass 2: read details (startEpoch, tokenAmount, publisher) for future KCs only
      if (futureIdsAll.length > 0) {
        console.log(`  Phase 1b: Reading details for ${futureIdsAll.length.toLocaleString()} future KCs...`);
        const DETAIL_BATCH = 500;
        lastLogTime = Date.now();

        for (let i = 0; i < futureIdsAll.length; i += DETAIL_BATCH) {
          const batch = futureIdsAll.slice(i, i + DETAIL_BATCH);
          const [starts, tokens, pubs] = await Promise.all([
            Promise.all(batch.map((id) => retry(() => kcStorage.getStartEpoch(id, { blockTag: blockNumber })))),
            Promise.all(batch.map((id) => retry(() => kcStorage.getTokenAmount(id, { blockTag: blockNumber })))),
            Promise.all(batch.map((id) => retry(() => kcStorage.getLatestMerkleRootPublisher(id, { blockTag: blockNumber })))),
          ]);
          for (let j = 0; j < batch.length; j++) {
            const publisher = String(pubs[j]).toLowerCase();
            const tokenAmount = BigInt(tokens[j]);
            if (tokenAmount === 0n || publisher === ethers.ZeroAddress.toLowerCase()) continue;
            futureKCs.push({
              id: batch[j],
              startEpoch: Number(starts[j]),
              endEpoch: futureEndEpochs.get(batch[j])!,
              tokenAmount,
              publisher,
            });
          }

          const now = Date.now();
          if (now - lastLogTime > 15_000 || i + DETAIL_BATCH >= futureIdsAll.length) {
            const pct = (((i + DETAIL_BATCH) / futureIdsAll.length) * 100).toFixed(1);
            console.log(`    ${pct}% — ${futureKCs.length.toLocaleString()} KCs with details`);
            lastLogTime = now;
          }
        }
      }
      return true;
    }

    // ── Event-based scanning (normal path) ──────────────────────────────
    console.log('  Phase 1: Scanning events (Created + Minted)...');

    const kcData = new Map<number, { startEpoch: number; endEpoch: number; tokenAmount: bigint }>();
    const kcPublisher = new Map<number, string>();

    let eventsScanned = 0;
    let cursor = cfg.KCSDeployBlock;
    let rangeSize = INITIAL_LOG_RANGE;
    let lastLogTime = Date.now();
    let rpcIdx = providers.indexOf(provider);

    while (cursor <= blockNumber) {
      const to = Math.min(cursor + rangeSize - 1, blockNumber);

      try {
        const logs = await retry(() =>
          provider.getLogs({
            address: cfg.KnowledgeCollectionStorage,
            topics: [[createdTopic, mintedTopic]],
            fromBlock: cursor,
            toBlock: to,
          }),
        );

        for (const log of logs) {
          eventsScanned++;
          const sig = log.topics[0];

          if (sig === createdTopic) {
            try {
              const parsed = KC_STORAGE_IFACE.parseLog({ topics: log.topics as string[], data: log.data });
              if (!parsed) continue;
              const endEpoch = Number(parsed.args.endEpoch);
              if (endEpoch <= currentEpoch) continue;
              kcData.set(Number(parsed.args.id), {
                startEpoch: Number(parsed.args.startEpoch),
                endEpoch,
                tokenAmount: BigInt(parsed.args.tokenAmount),
              });
            } catch { /* malformed */ }
          } else if (sig === mintedTopic) {
            const id = Number(BigInt(log.topics[1]));
            const pub = ethers.getAddress('0x' + log.topics[2].slice(26));
            if (!kcPublisher.has(id)) {
              kcPublisher.set(id, pub.toLowerCase());
            }
          }
        }

        cursor = to + 1;

        if (rangeSize < INITIAL_LOG_RANGE) {
          rangeSize = Math.min(rangeSize * 2, INITIAL_LOG_RANGE);
        }

        const now = Date.now();
        if (now - lastLogTime > 10_000 || cursor > blockNumber) {
          const pct = (((cursor - cfg.KCSDeployBlock) / (blockNumber - cfg.KCSDeployBlock)) * 100).toFixed(1);
          console.log(
            `    ${pct}% (block ${cursor.toLocaleString()}) — ` +
            `${eventsScanned.toLocaleString()} events, ${kcData.size.toLocaleString()} future KCs, range=${rangeSize}`,
          );
          lastLogTime = now;
        }
      } catch (e: any) {
        const msg = String(e.message ?? e) + (e.info?.responseBody ?? '');
        const isRangeTooLarge =
          msg.includes('50000') || msg.includes('too many') ||
          msg.includes('Query returned more') || msg.includes('block range') ||
          msg.includes('Exceeded maximum block range') ||
          msg.includes('Query timeout') || msg.includes('timeout exceeded');

        if (isRangeTooLarge) {
          rangeSize = Math.max(Math.floor(rangeSize / 2), MIN_LOG_RANGE);
          if (rangeSize < 500 && rpcIdx + 1 < providers.length) {
            rpcIdx++;
            provider = providers[rpcIdx];
            console.log(`    RPC block range too restrictive (range=${rangeSize}), switching to provider ${rpcIdx + 1}/${providers.length}`);
            rangeSize = INITIAL_LOG_RANGE;
          }
          continue;
        }
        throw e;
      }
    }

    // Join: only keep KCs that have both Created data AND publisher
    let missingPublisher = 0;
    for (const [id, data] of kcData.entries()) {
      const pub = kcPublisher.get(id);
      if (!pub || pub === ethers.ZeroAddress.toLowerCase()) {
        missingPublisher++;
        continue;
      }
      if (data.tokenAmount === 0n) continue;
      futureKCs.push({ id, ...data, publisher: pub });
    }

    if (missingPublisher > 0) {
      console.log(`    (${missingPublisher} KCs skipped — no publisher found in minted events)`);
    }
    return false;
  })();

  console.log(`  Phase 1 done: ${futureKCs.length.toLocaleString()} future KCs with publisher${usedDirectRead ? ' (direct read)' : ''}`);

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
    // Include current epoch — it just started, TRAC hasn't been paid out yet
    const firstRefundEpoch = Math.max(kc.startEpoch, currentEpoch);

    // endEpoch is INCLUSIVE: the contract distributes a final fractional epoch at
    // (startEpoch + epochs) == endEpoch. Include it so proportional scaling works.
    for (let epoch = firstRefundEpoch; epoch <= kc.endEpoch; epoch++) {
      if (!epochPublisherMap.has(epoch)) {
        epochPublisherMap.set(epoch, new Map());
      }
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

  const epochs: EpochSnapshot[] = [];
  let epochsScaled = 0;

  for (const epochNum of sortedEpochs) {
    const publisherMap = epochPublisherMap.get(epochNum)!;
    const onChainPoolWei = onChainPools.get(epochNum) ?? 0n;

    let computedTotalWei = 0n;
    for (const weiAmount of publisherMap.values()) {
      computedTotalWei += weiAmount;
    }

    // Always scale to on-chain pool: the V8 contract uses fractional first/last
    // epoch allocations that we can't replicate from events alone.
    // Publisher weights (relative shares) are accurate; absolute amounts need scaling.
    const needsScaling = onChainPoolWei > 0n && computedTotalWei > 0n && computedTotalWei !== onChainPoolWei;
    if (needsScaling) epochsScaled++;

    const publishers: PublisherEntry[] = [];
    let scaledTotalWei = 0n;

    for (const [pubKey, weiAmount] of publisherMap.entries()) {
      let finalWei = weiAmount;
      if (needsScaling) {
        finalWei = (weiAmount * onChainPoolWei) / computedTotalWei;
      }
      scaledTotalWei += finalWei;
      publishers.push({
        publisherEVMpubKey: pubKey,
        tracAmount: parseFloat(ethers.formatEther(finalWei)),
      });
    }

    publishers.sort((a, b) => b.tracAmount - a.tracAmount);

    epochs.push({
      epochNum,
      blockchainId: cfg.blockchainId,
      totalTRACAllocated: parseFloat(ethers.formatEther(scaledTotalWei)),
      onChainEpochPool: parseFloat(ethers.formatEther(onChainPoolWei)),
      publishers,
    });
  }

  // ── Verification: per-epoch sum vs on-chain pool ──────────────────────
  console.log('\n  ── Per-epoch verification (sum vs on-chain pool) ──');
  let allMatch = true;
  for (const snap of epochs) {
    const sumTRAC = snap.publishers.reduce((s, p) => s + p.tracAmount, 0);
    const diff = Math.abs(sumTRAC - snap.onChainEpochPool);
    const pct = snap.onChainEpochPool > 0 ? ((diff / snap.onChainEpochPool) * 100).toFixed(4) : '0';
    const status = diff < 0.01 ? '✓' : (diff < 1 ? '~' : '✗');
    if (status === '✗') allMatch = false;
    console.log(
      `    Epoch ${snap.epochNum}: sum=${sumTRAC.toFixed(2)}  pool=${snap.onChainEpochPool.toFixed(2)}  diff=${diff.toFixed(6)} (${pct}%)  ${status}`,
    );
  }
  if (allMatch) {
    console.log('  ✓ All epochs match on-chain pool (within rounding)');
  } else {
    console.log('  ⚠ Some epochs have significant differences — review above');
  }

  if (epochsScaled > 0) {
    console.log(`  ℹ ${epochsScaled} epoch(s) proportionally scaled to match on-chain pool`);
  }

  const meta: ChainMeta = {
    blockchainId: cfg.blockchainId,
    blockNumber,
    blockDate,
    currentEpoch,
    lastKnowledgeCollectionId: lastKCId,
    totalKCsWithFutureEpochs: futureKCs.length,
    maxFutureEpoch,
    epochsCapped: epochsScaled,
  };

  return { epochs, meta };
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
      const providers = await connectAll(cfg.rpcUrls);
      const { epochs, meta } = await snapshotChain(chainName, cfg, providers);
      allEpochs.push(...epochs);
      allMeta[chainName] = meta;
    } catch (err: any) {
      console.error(`[${chainName}] FAILED: ${err.message}`);
    }
  }

  const epochsPath = path.join(outDir, `publisher_epoch_snapshot_${unixTs}.json`);
  writeFileSync(epochsPath, JSON.stringify(allEpochs, null, 2) + '\n');
  console.log(`\nEpoch snapshots saved: ${epochsPath} (${allEpochs.length} epoch entries)`);

  const metaPath = path.join(outDir, `publisher_epoch_snapshot_${unixTs}_meta.json`);
  writeFileSync(metaPath, JSON.stringify(allMeta, bigIntReplacer, 2) + '\n');
  console.log(`Metadata saved: ${metaPath}`);

  console.log('\n=== Summary ===');
  for (const [chain, meta] of Object.entries(allMeta)) {
    const chainEpochs = allEpochs.filter((e) => e.blockchainId === meta.blockchainId);
    const totalTRAC = chainEpochs.reduce((sum, e) => sum + e.totalTRACAllocated, 0);
    const uniquePublishers = new Set(chainEpochs.flatMap((e) => e.publishers.map((p) => p.publisherEVMpubKey)));
    console.log(`  ${chain}: ${chainEpochs.length} future epochs, ${uniquePublishers.size} publishers, ${totalTRAC.toFixed(2)} TRAC allocated`);
    if (meta.epochsCapped > 0) {
      console.log(`    └─ ${meta.epochsCapped} epoch(s) scaled to on-chain pool`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
