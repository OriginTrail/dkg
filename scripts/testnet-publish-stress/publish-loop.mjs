#!/usr/bin/env node
/**
 * Publish-stress loop against a real DKG node (Miles, edge mode, Base
 * Sepolia 84532). Reads Wikidata music partitions from the JSONL file
 * produced by fetch-wikidata-music.mjs and publishes each as one VM-bound
 * KC via the daemon's HTTP API.
 *
 * Lifecycle per partition (2 HTTP calls + an unknown wait for chain confirm):
 *   1. POST /api/knowledge-assets        { name, contextGraphId, quads,
 *                                          finalize: true, promote: true }
 *      Combined create+write+finalize+promote (one round-trip, agent does
 *      the work in-process).
 *   2. POST /api/knowledge-assets/:name/vm/publish   { contextGraphId }
 *      SWM → VM. This is where the chain TX happens.
 *
 * Calibration mode (`PHASE=calibrate`): publishes 10 partitions, measures
 * actual TRAC delta per publish, prints a summary, then exits. Lets us
 * decide between 3000/5000/topup without committing the full budget.
 *
 * Main mode (`PHASE=main`): publishes all remaining partitions until the
 * target count is reached. Checkpoints every PUBLISH_CHECKPOINT_EVERY
 * partitions (default 50) into a JSON file so the loop is resumable across
 * crashes / network blips.
 *
 * Env:
 *   DKG_HOST                 default http://127.0.0.1:9200
 *   DKG_TOKEN_FILE           default ~/.dkg/auth.token
 *   CG_ID                    short id of the context graph (required)
 *   STRESS_RUN_ID            stable id for this stress run (default 26may)
 *   TARGET_PARTITIONS        max partition idx to publish (default 5000)
 *   PUBLISH_SLEEP_MS         pause between publishes (default 10000)
 *   PUBLISH_CHECKPOINT_EVERY checkpoint cadence (default 50)
 *   PHASE                    "calibrate" or "main" (default "calibrate")
 *   CALIBRATE_COUNT          # publishes in calibrate phase (default 10)
 *   PARTITIONS_FILE          default ~/.dkg-publish-stress/data/music-partitions.jsonl
 *   CHECKPOINT_FILE          default ~/.dkg-publish-stress/checkpoints/${STRESS_RUN_ID}.json
 */

import { readFile, writeFile, mkdir, appendFile, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { homedir } from 'node:os';

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const CFG = {
  host: process.env.DKG_HOST ?? 'http://127.0.0.1:9200',
  tokenFile: process.env.DKG_TOKEN_FILE ?? `${homedir()}/.dkg/auth.token`,
  cgId: process.env.CG_ID,
  stressRunId: process.env.STRESS_RUN_ID ?? '26may',
  targetPartitions: parseInt(process.env.TARGET_PARTITIONS ?? '5000', 10),
  publishSleepMs: parseInt(process.env.PUBLISH_SLEEP_MS ?? '10000', 10),
  checkpointEvery: parseInt(process.env.PUBLISH_CHECKPOINT_EVERY ?? '50', 10),
  phase: process.env.PHASE ?? 'calibrate',
  calibrateCount: parseInt(process.env.CALIBRATE_COUNT ?? '10', 10),
  partitionsFile: process.env.PARTITIONS_FILE ?? `${homedir()}/.dkg-publish-stress/data/music-partitions.jsonl`,
  checkpointFile: process.env.CHECKPOINT_FILE
    ?? `${homedir()}/.dkg-publish-stress/checkpoints/${process.env.STRESS_RUN_ID ?? '26may'}.json`,
  logFile: `${homedir()}/.dkg-publish-stress/logs/publish-${process.env.STRESS_RUN_ID ?? '26may'}-${process.env.PHASE ?? 'calibrate'}.log`,
};

if (!CFG.cgId) {
  console.error('ERROR: CG_ID env var is required.');
  console.error('Run pre-flight first (--preflight) to create the CG, then re-run with CG_ID set.');
  process.exit(2);
}

const TOKEN = (await readFile(CFG.tokenFile, 'utf8'))
  .split('\n')
  .find((l) => l.trim() && !l.startsWith('#'))
  .trim();

// -----------------------------------------------------------------------------
// HTTP helper (with token + JSON + 429-aware retry)
// -----------------------------------------------------------------------------

async function apiCall(method, path, body, { timeoutMs = 120_000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${CFG.host}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try { json = text.length > 0 ? JSON.parse(text) : {}; }
    catch { json = { _raw: text }; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${method} ${path}: ${json.error ?? text.slice(0, 300)}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

// -----------------------------------------------------------------------------
// Logging
// -----------------------------------------------------------------------------

async function log(msg) {
  const stamped = `${new Date().toISOString()} ${msg}`;
  console.error(stamped);
  try {
    await appendFile(CFG.logFile, stamped + '\n', 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      await mkdir(dirname(CFG.logFile), { recursive: true });
      await appendFile(CFG.logFile, stamped + '\n', 'utf8');
    } else {
      throw err;
    }
  }
}

// -----------------------------------------------------------------------------
// Wallet snapshot + cost accounting
// -----------------------------------------------------------------------------

async function getWalletSnapshot() {
  const r = await apiCall('GET', '/api/wallets/balances');
  const ethTotal = r.balances.reduce((s, b) => s + parseFloat(b.eth), 0);
  const tracTotal = r.balances.reduce((s, b) => s + parseFloat(b.trac), 0);
  return { eth: ethTotal, trac: tracTotal, perWallet: r.balances };
}

// -----------------------------------------------------------------------------
// Partition reader (lazy line-by-line)
// -----------------------------------------------------------------------------

async function readPartitionAtIndex(targetIdx) {
  // Lazy linear scan. Each iteration reads ~one line at a time and stops
  // when we hit the target index. Acceptable because the loop only seeks
  // forward from the checkpoint, and N <= 5000.
  if (!existsSync(CFG.partitionsFile)) {
    throw new Error(`Partitions file missing: ${CFG.partitionsFile}`);
  }
  const rl = createInterface({
    input: createReadStream(CFG.partitionsFile, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let idx = 0;
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    if (idx === targetIdx) {
      rl.close();
      return JSON.parse(line);
    }
    idx++;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Quad building — wrap each fetched N-Triple in <graph> + add anchor triples
// -----------------------------------------------------------------------------

// Compact, deterministic blank-node label from a Wikidata URI.
// `http://www.wikidata.org/entity/Q66212` → `_:wd_Q66212`.
// Anything not Wikidata stays as a URI (rdf:type etc.).
function urlToBnodeLabel(uri) {
  const m = uri.match(/^https?:\/\/(?:www\.)?wikidata\.org\/entity\/([A-Z][0-9]+)$/);
  if (m) return `_:wd_${m[1]}`;
  return null;
}

function buildPartitionQuads(partition, cgId, stressRunId, partitionIdx) {
  // Anchor subject is the ONE non-blank root entity per partition.
  // `autoPartition` will skolemize every blank-node subject under this
  // anchor's namespace, so every Wikidata entity in this partition lives
  // inside this KA and doesn't pollute the CG-wide root-entity space
  // (which would trigger "Rule 4: rootEntity already exists" on overlap
  // with prior partitions).
  //
  // Anchor URI also encodes the partition idx so two partitions referencing
  // the same Wikidata entity skolemize them under different namespaces and
  // never collide on the KA-shaped path either.
  const idxStr = String(partitionIdx).padStart(6, '0');
  const anchor = `urn:dkg:stress:${stressRunId}:partition:${idxStr}`;
  const stressRun = `urn:dkg:stress:${stressRunId}`;
  const graph = `did:dkg:context-graph:${cgId}`;
  const quads = [];
  const isoTs = new Date().toISOString();

  // Anchor metadata (3 quads)
  quads.push({
    subject: anchor,
    predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    object: '<https://ontology.dkg.io/stress#PublishStressPartition>',
    graph,
  });
  quads.push({
    subject: anchor,
    predicate: 'https://ontology.dkg.io/stress#belongsTo',
    object: `<${stressRun}>`,
    graph,
  });
  quads.push({
    subject: anchor,
    predicate: 'http://purl.org/dc/terms/created',
    object: `"${isoTs}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`,
    graph,
  });

  // Track which Wikidata entities have been seen as a subject so we can
  // link each one directly to the anchor via `stress:contains`. Without
  // an anchor → blank-node-object edge, the skolemizer won't know which
  // root the blank node belongs to (see auto-partition.ts).
  const seenAsSubject = new Set();

  // Wikidata triples — convert URI subjects/objects to blank nodes scoped
  // to this partition. Predicates and non-Wikidata objects are preserved.
  for (const t of partition.triples) {
    const m = t.match(/^<([^>]+)>\s+<([^>]+)>\s+(.+)$/);
    if (!m) continue;
    const [, subjectUri, predicate, objectRaw] = m;
    const subjectBnode = urlToBnodeLabel(subjectUri);
    if (subjectBnode == null) continue;  // unexpected — skip silently

    // Anchor → contains → blank node (one edge per unique subject).
    if (!seenAsSubject.has(subjectBnode)) {
      seenAsSubject.add(subjectBnode);
      quads.push({
        subject: anchor,
        predicate: 'https://ontology.dkg.io/stress#contains',
        object: subjectBnode,
        graph,
      });
    }

    // Convert the object: if it's a Wikidata URI, swap to a blank node so
    // the skolemizer pulls it into the same KA; otherwise keep verbatim
    // (literal or non-Wikidata URI such as `<...wikidata.org/entity/Q5>`
    // is also Wikidata so it gets bnoded too).
    let objToken = objectRaw.trim();
    const angleMatch = objToken.match(/^<([^>]+)>$/);
    if (angleMatch) {
      const objBnode = urlToBnodeLabel(angleMatch[1]);
      if (objBnode != null) objToken = objBnode;
    }
    quads.push({
      subject: subjectBnode,
      predicate,
      object: objToken,
      graph,
    });
  }

  return { anchor, quads };
}

// -----------------------------------------------------------------------------
// Per-partition publish (returns { kaId, txHash, status, ms, error? })
// -----------------------------------------------------------------------------

async function publishOnePartition(partition, partitionIdx, attempt = 0) {
  const startedAt = Date.now();
  // Assertion name — short, deterministic, URI-safe. Suffix with attempt
  // counter so retries after a successful create + failed publish don't
  // 409 on the next create call. The assertion-create endpoint rejects
  // duplicate names; retries need their own fresh name.
  const attemptSuffix = attempt > 0 ? `-r${attempt}` : '';
  const name = `stress-${CFG.stressRunId}-${String(partitionIdx).padStart(6, '0')}${attemptSuffix}`;
  const { anchor, quads } = buildPartitionQuads(partition, CFG.cgId, CFG.stressRunId, partitionIdx);

  // 1. Combined create + write + finalize + promote. The route requires
  //    `finalize: true` to allow `promote: true`, and `quads` to be present
  //    to allow `finalize: true` — exactly the bundle we want.
  const createRes = await apiCall('POST', '/api/knowledge-assets', {
    name,
    contextGraphId: CFG.cgId,
    quads,
    finalize: true,
    promote: true,
  }, { timeoutMs: 60_000 });
  const merkleRoot = createRes.seal?.merkleRoot ?? createRes.merkleRoot;

  // Brief pause so the promote's SWM gossip can reach peers before publish
  // asks them for storage ACKs. Empirically observed `MERKLE_MISMATCH_IN_SWM`
  // / `NO_DATA_IN_SWM` errors at quorum check when this is skipped on
  // 100+ quad payloads. 3 seconds covers the gossip round-trip on Base
  // Sepolia + libp2p with 5 connected cores.
  await sleep(3000);

  // 2. publish — SWM → VM. Returns kaId + txHash on success.
  const publishRes = await apiCall('POST', `/api/knowledge-assets/${encodeURIComponent(name)}/vm/publish`, {
    contextGraphId: CFG.cgId,
  }, { timeoutMs: 180_000 });

  return {
    partitionIdx,
    name,
    anchor,
    merkleRoot,
    kaId: publishRes.kaId,
    txHash: publishRes.txHash,
    blockNumber: publishRes.blockNumber,
    status: publishRes.status,
    ms: Date.now() - startedAt,
  };
}

// -----------------------------------------------------------------------------
// Checkpoint I/O
// -----------------------------------------------------------------------------

async function loadCheckpoint() {
  try {
    const txt = await readFile(CFG.checkpointFile, 'utf8');
    const cp = JSON.parse(txt);
    return cp;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return {
      version: 1,
      stressRunId: CFG.stressRunId,
      cgId: CFG.cgId,
      startedAt: new Date().toISOString(),
      lastPublishedIdx: -1,
      tracSpent: 0,
      ethSpent: 0,
      successes: 0,
      failures: 0,
      kas: [],   // [{partitionIdx, kaId, txHash, ms}]
      errors: [], // [{partitionIdx, error, attempt}]
    };
  }
}

async function saveCheckpoint(cp) {
  await mkdir(dirname(CFG.checkpointFile), { recursive: true });
  await writeFile(CFG.checkpointFile, JSON.stringify(cp, null, 2), 'utf8');
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  await log(`=== publish-loop start phase=${CFG.phase} runId=${CFG.stressRunId} cg=${CFG.cgId} ===`);
  await log(`config: ${JSON.stringify({ ...CFG, tokenFile: '(redacted)' })}`);

  const checkpoint = await loadCheckpoint();
  await log(`checkpoint: lastPublishedIdx=${checkpoint.lastPublishedIdx} successes=${checkpoint.successes} failures=${checkpoint.failures}`);

  const startSnap = await getWalletSnapshot();
  await log(`wallets at start: ETH=${startSnap.eth.toFixed(6)} TRAC=${startSnap.trac.toFixed(4)}`);

  let target = CFG.targetPartitions;
  if (CFG.phase === 'calibrate') {
    target = Math.min(checkpoint.lastPublishedIdx + 1 + CFG.calibrateCount, CFG.targetPartitions);
    await log(`[calibrate] target=${target} (${CFG.calibrateCount} new publishes)`);
  }

  let i = checkpoint.lastPublishedIdx + 1;
  while (i < target) {
    let partition;
    try {
      partition = await readPartitionAtIndex(i);
    } catch (err) {
      await log(`[fatal] cannot read partition ${i}: ${err.message}`);
      throw err;
    }
    if (partition == null) {
      await log(`[wait] partition ${i} not yet in JSONL — fetch lagging. Sleeping 30s.`);
      await sleep(30_000);
      continue;
    }

    let result = null;
    let attempt = 0;
    const MAX_ATTEMPTS = 3;
    while (attempt < MAX_ATTEMPTS && result == null) {
      try {
        result = await publishOnePartition(partition, i, attempt);
      } catch (err) {
        const errMsg = `${err.message ?? String(err)}`.slice(0, 400);
        await log(`[error] partition=${i} attempt=${attempt + 1}/${MAX_ATTEMPTS}: ${errMsg}`);
        checkpoint.errors.push({
          partitionIdx: i,
          attempt: attempt + 1,
          error: errMsg,
          ts: new Date().toISOString(),
        });
        attempt++;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(5000 * attempt);  // 5s, 10s backoff
        }
      }
    }

    if (result != null) {
      checkpoint.successes++;
      checkpoint.kas.push({
        partitionIdx: i,
        kaId: result.kaId,
        txHash: result.txHash,
        blockNumber: result.blockNumber,
        ms: result.ms,
      });
      await log(`[ok] partition=${i} kaId=${result.kaId} tx=${result.txHash} ms=${result.ms}`);
    } else {
      checkpoint.failures++;
      await log(`[fail] partition=${i} ${MAX_ATTEMPTS} attempts exhausted; skipping`);
    }
    checkpoint.lastPublishedIdx = i;

    // Codex review on PR #722: persist `lastPublishedIdx` after EVERY
    // successful publish so a crash between the costly periodic snapshot
    // boundaries can't replay an already-published partition on restart
    // (which would hit Rule 4 / root-entity conflicts because each
    // partition's anchor URI is deterministic). The expensive wallet-
    // snapshot path below still runs only every `CFG.checkpointEvery`,
    // but the cheap partition-bookkeeping write is now eager.
    await saveCheckpoint(checkpoint);

    // Periodic snapshot for cost tracking (expensive: N getWalletSnapshot
    // RPC calls). Kept on the original cadence — only `lastPublishedIdx`
    // needed the every-success treatment above.
    if ((i + 1) % CFG.checkpointEvery === 0 || i + 1 === target) {
      const snap = await getWalletSnapshot();
      checkpoint.tracSpent = startSnap.trac - snap.trac;
      checkpoint.ethSpent = startSnap.eth - snap.eth;
      await saveCheckpoint(checkpoint);
      const successesSoFar = checkpoint.successes - (checkpoint.kas.length - checkpoint.successes);  // belt + braces
      await log(`[checkpoint] i=${i + 1}/${target} ok=${checkpoint.successes} fail=${checkpoint.failures} TRAC-spent=${checkpoint.tracSpent.toFixed(4)} ETH-spent=${checkpoint.ethSpent.toFixed(6)} TRAC-remaining=${snap.trac.toFixed(4)}`);
      // Safety: stop if any single wallet has < 50 TRAC remaining (so we never push it negative on next call).
      const min = Math.min(...snap.perWallet.map((w) => parseFloat(w.trac)));
      if (min < 50) {
        await log(`[stop] minimum wallet TRAC ${min.toFixed(2)} below 50 — halting to keep reserve.`);
        await saveCheckpoint(checkpoint);
        process.exit(3);
      }
    }

    i++;
    if (i < target) {
      await sleep(CFG.publishSleepMs);
    }
  }

  // Final wallet snapshot + summary
  const endSnap = await getWalletSnapshot();
  checkpoint.tracSpent = startSnap.trac - endSnap.trac;
  checkpoint.ethSpent = startSnap.eth - endSnap.eth;
  await saveCheckpoint(checkpoint);

  const successCount = checkpoint.successes;
  const tracPerPublish = successCount > 0 ? checkpoint.tracSpent / successCount : 0;
  const ethPerPublish = successCount > 0 ? checkpoint.ethSpent / successCount : 0;

  await log(`=== summary phase=${CFG.phase} ===`);
  await log(`  publishes total/ok/fail = ${i}/${checkpoint.successes}/${checkpoint.failures}`);
  await log(`  TRAC spent total = ${checkpoint.tracSpent.toFixed(4)}  (~${tracPerPublish.toFixed(4)} TRAC/publish)`);
  await log(`  ETH spent total  = ${checkpoint.ethSpent.toFixed(6)}   (~${ethPerPublish.toFixed(6)} ETH/publish)`);
  await log(`  TRAC remaining   = ${endSnap.trac.toFixed(4)} across ${endSnap.perWallet.length} wallets (min=${Math.min(...endSnap.perWallet.map((w) => parseFloat(w.trac))).toFixed(4)})`);

  if (CFG.phase === 'calibrate') {
    const proj = tracPerPublish * (CFG.targetPartitions - i);
    await log(`  PROJECTION: ${CFG.targetPartitions - i} more publishes would cost ~${proj.toFixed(2)} TRAC at this rate.`);
    await log(`              Remaining budget: ${endSnap.trac.toFixed(2)} TRAC  →  affordable ~${Math.floor(endSnap.trac / Math.max(tracPerPublish, 0.0001))} more publishes`);
  }
}

main().catch(async (err) => {
  await log(`[fatal] ${err.stack ?? err.message ?? err}`);
  process.exit(1);
});
