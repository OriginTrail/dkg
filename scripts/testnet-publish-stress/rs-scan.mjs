#!/usr/bin/env node
/**
 * Random-sampling observability scan against Base Sepolia.
 *
 * Pulls recent `ChallengeGenerated` (RandomSampling) and
 * `EpochNodeValidProofsCountIncremented` / `NodeEpochScoreAdded` (RandomSamplingStorage)
 * events, then aggregates:
 *
 *   1. How many unique nodes (identityId) ran `createChallenge()` in the window.
 *   2. How many valid proofs landed per node + per epoch.
 *   3. Which KC ids the challenges targeted; flag any that match KCs we
 *      published from Miles in this stress run.
 *   4. Aggregate node-epoch scores so we can spot the score distribution
 *      (a few super-scorers vs. a flat distribution).
 *
 * Read-only. Hits Base Sepolia public RPC (no Miles dependency, but uses
 * Miles' wallets.json to read the chain/contracts config). The window
 * defaults to the last 4 hours of Base Sepolia blocks.
 *
 * Env:
 *   WINDOW_HOURS         scan window in hours (default 4)
 *   RPC_URL              override RPC endpoint (default https://sepolia.base.org)
 *   CHECKPOINT_FILE      optional — path to a publish-stress checkpoint JSON
 *                        for cross-referencing our minted kcIds
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

// pnpm-hoisted ethers v6 is the most reliable way to share the same
// install the rest of the workspace uses. Falls back to bare `ethers`
// if the script gets npm-installed alongside its own package.json.
const require = createRequire(import.meta.url);
let ethers;
try {
  ethers = require('ethers');
} catch {
  try {
    ethers = require(`${process.cwd()}/node_modules/.pnpm/ethers@6.16.0_bufferutil@4.1.0_utf-8-validate@5.0.10/node_modules/ethers`);
  } catch (err) {
    console.error('Could not load ethers from workspace. Tried bare `ethers` and the pnpm-hoisted path.');
    console.error('Workaround: run this script from the workspace root, or install ethers locally:');
    console.error('  cd scripts/testnet-publish-stress && npm i ethers@6');
    throw err;
  }
}

const RPC_URL = process.env.RPC_URL ?? 'https://sepolia.base.org';
const WINDOW_HOURS = parseFloat(process.env.WINDOW_HOURS ?? '4');
const BASE_SEPOLIA_BLOCK_TIME_S = 2;  // observed
const WINDOW_BLOCKS = Math.floor((WINDOW_HOURS * 3600) / BASE_SEPOLIA_BLOCK_TIME_S);
// Codex review on PR #722: derive the default checkpoint filename from the
// same `STRESS_RUN_ID` env var the producer (`publish-loop.mjs`) uses, so a
// vanilla run of `rs-scan.mjs` against a vanilla run of `publish-loop.mjs`
// loads the right KC ids out of the box. Hard-coding `26may2.json` here
// (an artefact of the original Base Sepolia sweep) caused rs-scan to load
// no KC ids and report "none of ours sampled" on fresh runs.
const STRESS_RUN_ID = process.env.STRESS_RUN_ID ?? '26may';
const CHECKPOINT_FILE = process.env.CHECKPOINT_FILE
  ?? `${homedir()}/.dkg-publish-stress/checkpoints/${STRESS_RUN_ID}.json`;

const RS_ADDR = '0x73AefE8AD301f7eac8c45C1B91A60Ed01BF24B1b';
const RS_STORAGE_ADDR = '0xd84640BA70F18527827A3572C8Acf52E10ff5BC5';

// Event signatures (sourced from the V10 ABI files)
const RS_ABI = [
  'event ChallengeGenerated(uint72 indexed identityId, uint256 indexed contextGraphId, uint256 indexed knowledgeAssetId, uint256 chunkId, uint256 epoch, uint256 activeProofPeriodStartBlock)',
];
const RS_STORAGE_ABI = [
  'event EpochNodeValidProofsCountIncremented(uint256 indexed epoch, uint72 indexed identityId, uint256 newCount)',
  'event NodeEpochScoreAdded(uint256 indexed epoch, uint72 indexed identityId, uint256 scoreAdded, uint256 totalScore)',
  'event NodeEpochProofPeriodScoreAdded(uint256 indexed epoch, uint256 indexed proofPeriodStartBlock, uint72 indexed identityId, uint256 scoreAdded, uint256 totalScore)',
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const rs = new ethers.Contract(RS_ADDR, RS_ABI, provider);
const rsStorage = new ethers.Contract(RS_STORAGE_ADDR, RS_STORAGE_ABI, provider);

async function getOurKcIds() {
  try {
    const cp = JSON.parse(await readFile(CHECKPOINT_FILE, 'utf8'));
    return new Set(cp.kas.map((k) => String(k.kaId)));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`(checkpoint read: ${err.message})`);
    return new Set();
  }
}

async function withRetry(fn, label, attempts = 5) {
  // Public RPCs love to rate-limit. Light exponential backoff per call.
  let delay = 500;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      const msg = err?.shortMessage ?? err?.message ?? String(err);
      if (i === attempts - 1) throw err;
      console.error(`  ${label} attempt ${i+1} failed: ${msg.slice(0,120)}; retry in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

// Paginate getLogs in 2000-block chunks so we don't trip RPC limits.
async function getLogsChunked(contract, eventName, fromBlock, toBlock) {
  const CHUNK = 2000;
  const out = [];
  for (let from = fromBlock; from <= toBlock; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, toBlock);
    const logs = await withRetry(
      () => contract.queryFilter(contract.filters[eventName](), from, to),
      `${eventName}[${from}-${to}]`,
    );
    out.push(...logs);
  }
  return out;
}

console.error(`=== RS scan: window=${WINDOW_HOURS}h (${WINDOW_BLOCKS} blocks) on ${RPC_URL} ===`);

const tip = await withRetry(() => provider.getBlockNumber(), 'getBlockNumber');
const fromBlock = Math.max(0, tip - WINDOW_BLOCKS);
console.error(`Block range: [${fromBlock} .. ${tip}]`);

const ourKcIds = await getOurKcIds();
console.error(`Our checkpoint reports ${ourKcIds.size} kcIds minted from Miles.`);

// 1. Challenges generated
console.error('\nFetching ChallengeGenerated events...');
const challenges = await getLogsChunked(rs, 'ChallengeGenerated', fromBlock, tip);
console.error(`  ${challenges.length} ChallengeGenerated events.`);

// 2. Valid-proof markers
console.error('Fetching EpochNodeValidProofsCountIncremented events...');
const validProofs = await getLogsChunked(rsStorage, 'EpochNodeValidProofsCountIncremented', fromBlock, tip);
console.error(`  ${validProofs.length} EpochNodeValidProofsCountIncremented events.`);

// 3. Score-added per proof period
console.error('Fetching NodeEpochProofPeriodScoreAdded events...');
const proofPeriodScores = await getLogsChunked(rsStorage, 'NodeEpochProofPeriodScoreAdded', fromBlock, tip);
console.error(`  ${proofPeriodScores.length} NodeEpochProofPeriodScoreAdded events.`);

console.error('\n=== Report ===\n');

// --- Aggregations ---

// Per-node challenge count
const challengesByNode = new Map();         // identityId(string) -> count
const challengesByEpoch = new Map();         // epoch(string) -> count
const challengesByCG = new Map();            // contextGraphId(string) -> count
const kcsHit = new Set();                    // kaId(string)
const kcsHitOurs = [];                       // {kaId, identityId, epoch, contextGraphId, blockNumber}

for (const ev of challenges) {
  const { identityId, contextGraphId, knowledgeAssetId, chunkId, epoch } = ev.args;
  const idStr = identityId.toString();
  const cgStr = contextGraphId.toString();
  const kcStr = knowledgeAssetId.toString();
  const epStr = epoch.toString();
  challengesByNode.set(idStr, (challengesByNode.get(idStr) ?? 0) + 1);
  challengesByEpoch.set(epStr, (challengesByEpoch.get(epStr) ?? 0) + 1);
  challengesByCG.set(cgStr, (challengesByCG.get(cgStr) ?? 0) + 1);
  kcsHit.add(kcStr);
  if (ourKcIds.has(kcStr)) {
    kcsHitOurs.push({
      kaId: kcStr,
      identityId: idStr,
      epoch: epStr,
      contextGraphId: cgStr,
      blockNumber: ev.blockNumber,
      chunkId: chunkId.toString(),
    });
  }
}

// Per-node valid-proof count + aggregate score
const validProofsByNode = new Map();
for (const ev of validProofs) {
  const id = ev.args.identityId.toString();
  validProofsByNode.set(id, (validProofsByNode.get(id) ?? 0) + 1);
}

const scoreSumByNode = new Map();  // identityId -> BigInt total score added this window
for (const ev of proofPeriodScores) {
  const id = ev.args.identityId.toString();
  const added = BigInt(ev.args.scoreAdded);
  scoreSumByNode.set(id, (scoreSumByNode.get(id) ?? 0n) + added);
}

console.log(`Unique cores that ran createChallenge():  ${challengesByNode.size}`);
console.log(`Unique cores that submitted a valid proof: ${validProofsByNode.size}`);
console.log(`Unique KCs sampled in the window:          ${kcsHit.size}`);
console.log(`Unique epochs in the window:               ${challengesByEpoch.size}`);

const submissionRate = challenges.length > 0
  ? (validProofs.length / challenges.length * 100).toFixed(1) + '%'
  : 'n/a';
console.log(`Challenge→valid-proof rate (window total): ${validProofs.length}/${challenges.length} = ${submissionRate}`);

console.log('');
console.log('Per-core breakdown (sorted by challenge count desc):');
console.log('  identityId  challenges  validProofs  score-this-window');
const ids = new Set([...challengesByNode.keys(), ...validProofsByNode.keys()]);
const rows = Array.from(ids).map((id) => ({
  id,
  challenges: challengesByNode.get(id) ?? 0,
  validProofs: validProofsByNode.get(id) ?? 0,
  score: scoreSumByNode.get(id) ?? 0n,
}));
rows.sort((a, b) => b.challenges - a.challenges);
for (const r of rows) {
  console.log(`  ${r.id.padStart(10)}  ${String(r.challenges).padStart(10)}  ${String(r.validProofs).padStart(11)}  ${String(r.score).padStart(20)}`);
}

console.log('');
console.log('Challenges per context graph:');
for (const [cg, n] of Array.from(challengesByCG.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  cgId=${cg}  ${n} challenge${n === 1 ? '' : 's'}`);
}

console.log('');
if (kcsHitOurs.length > 0) {
  console.log(`Our KCs sampled (${kcsHitOurs.length} hits across ${new Set(kcsHitOurs.map((k) => k.kaId)).size} unique kcIds):`);
  for (const h of kcsHitOurs.slice(0, 20)) {
    console.log(`  kaId=${h.kaId}  challenged by identityId=${h.identityId}  cgId=${h.contextGraphId}  epoch=${h.epoch}  block=${h.blockNumber}`);
  }
  if (kcsHitOurs.length > 20) {
    console.log(`  ... ${kcsHitOurs.length - 20} more`);
  }
} else if (ourKcIds.size > 0) {
  console.log(`None of our ${ourKcIds.size} minted KCs were sampled in this ${WINDOW_HOURS}h window.`);
  console.log('Expected for the first hours after publishing (RS sampling is value-weighted across all CGs, our 11 KCs are a small slice).');
} else {
  console.log('(No checkpoint yet — re-run after publish-loop has minted some KCs.)');
}
