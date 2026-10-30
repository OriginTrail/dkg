// Deterministic retained publisher-job history for the contention benchmark (OT-RFC-73 P2b, ported from harness 0.6
// liftseed.mjs): the generator, the N-Quads seed file with its manifest, and the loader (history.mjs loadSeedFile loads
// any N-Quads file). A seed FILE is the history both arms of an A/B load, byte-identical for a base and a head worktree.
//
// What a retained terminal publication leaves behind in the node's RDF store:
//   * the job graph urn:dkg:publisher:control-plane: the job subject (status, payload, timestamps, lifecycle key, ...,
//     34 quads for a finalized job) and the immutable request subject (3 quads);
//   * the audit journal urn:dkg:publisher:journal: ONE entry per canonical write (journalWrites is on in the daemon), 7
//     entries for a finalized job (accepted, claimed, validated, broadcast, rpc-accepted, included, finalized), 7-11
//     quads each, append-only;
//   * the wallet-lock graph: NOTHING. A released lock is deleted, so that graph is O(wallets), not O(history); seeding
//     locks for terminal jobs would be unfaithful.
// The records are CLONED FROM A REAL LIFECYCLE: one finalized and one terminally failed job are produced by running the
// real TripleStoreAsyncLiftPublisher (admission, claim, validate, broadcast, included, finalized with a synthetic
// handler; a staging mismatch gives the canonicalization_failed failure) on a throwaway in-memory store, re-timed to
// fixed offsets (the real run's own millisecond gaps would make two builds of the same file differ), then re-keyed per
// job (job id, KA name, share operation id, UAL, intent key, tx hash, wallet, timestamps) and serialized with the
// product's own serializers. Nothing about the record SHAPE is invented here.
import { createHash } from 'node:crypto';
import { createWriteStream, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { gitInfo } from './backend.mjs';
import { AGENT, CG_ID } from './fixture.mjs';
import { AUTHOR, makeVmRequest, walletIdsOf } from './publisher.mjs';

const HOUR_MS = 3_600_000;
const STEP_MS = 1000;
// the product's default claim lease (5 min) from the claim: the real run's own value drifts by the milliseconds its
// renewals took, and a retained terminal job's lease is never read again
const CLAIM_LEASE_MS = 300_000;
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
/** The harness's deterministic UUID-shaped job id (the product uses crypto.randomUUID()). */
export const jobIdOf = (j) => {
  const h = sha(`lift-hist-job-${j}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
/** Whether history job j is a terminal failure, for a fraction in [0, 1]: a fixed pseudo-random subset. */
export const isFailedHistoryJob = (j, fraction) =>
  fraction > 0 && (Math.imul(j + 1, 2654435761) >>> 0) % 100_000 < fraction * 100_000;

/** The lifecycle order of the job's timestamps; every present one is moved to acceptedAt + its rank seconds. */
const TIMESTAMP_ORDER = [
  'acceptedAt',
  'claimedAt',
  'validatedAt',
  'broadcastAt',
  'rpcAcceptedAt',
  'receiptObservedAt',
  'finalityObservedAt',
  'includedAt',
  'finalizedAt',
  'failedAt',
  'updatedAt',
];

/** A template job and its journal with every time at a fixed offset (0, 1 s, 2 s, ...) from acceptedAt = 0. */
export function normalizeTemplate(tpl) {
  const job = JSON.parse(JSON.stringify(tpl.job));
  const present = TIMESTAMP_ORDER.filter((k) => typeof job.timestamps?.[k] === 'number');
  present.forEach((k, rank) => {
    job.timestamps[k] = rank * STEP_MS;
  });
  for (const k of Object.keys(job.timestamps))
    if (!present.includes(k) && typeof job.timestamps[k] === 'number') delete job.timestamps[k];
  if (job.claim?.claimLeaseExpiresAt !== undefined)
    job.claim.claimLeaseExpiresAt = job.timestamps.claimedAt + CLAIM_LEASE_MS;
  const journal = tpl.journal.map((e) => ({ ...e, at: e.seq * STEP_MS }));
  return { ...tpl, job, journal };
}

/**
 * Runs the real publisher once on a throwaway in-memory store: one finalized job, one terminally failed job.
 * Returns { finalized, failed }, each { job, journal, request }, normalized.
 */
export async function buildLiftTemplates(deps) {
  const { storage, core, pub, liftControl: CP } = deps;
  const raw = new storage.OxigraphStore();
  const journalInserts = [];
  const store = new Proxy(raw, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (prop === 'insert' && args[0]?.[0]?.graph === CP.DEFAULT_JOURNAL_GRAPH_URI) journalInserts.push(args[0]);
        return value.apply(target, args);
      };
    },
  });
  const graphManager = new storage.GraphManager(raw);
  const handler = {
    async preflight() {
      return { action: 'execute' };
    },
    async execute(input) {
      const txHash = `0x${'ab'.repeat(32)}`;
      await input.publishOptions.onBeforeBroadcast?.({ txHash, nonce: 1 });
      await input.publishOptions.onBroadcastAccepted?.({ txHash, nonce: 1 });
      input.publishOptions.onPublishConfirmed?.({ txHash });
      const kaId = 1000n;
      return {
        kaId,
        ual: input.request.kaUal,
        merkleRoot: new Uint8Array(32),
        kaManifest: [],
        status: 'confirmed',
        onChainResult: {
          batchId: kaId,
          startKAId: kaId,
          endKAId: kaId,
          txHash,
          blockNumber: 1000,
          blockTimestamp: 1_700_000_000,
          publisherAddress: AUTHOR,
        },
      };
    },
  };
  const admission = new pub.TripleStoreAsyncLiftPublisher(store, {
    journalWrites: true,
  });
  const runtime = new pub.TripleStoreAsyncLiftPublisher(store, {
    journalWrites: true,
    knowledgeAssetVmPublishHandler: handler,
  });
  const stage = async (n, quads) => {
    const request = makeVmRequest(n, 'tpl', core);
    await pub.storeKnowledgeAssetOperationPublicQuads({
      store: raw,
      graphManager,
      contextGraphId: CG_ID,
      shareOperationId: request.shareOperationId,
      kaUal: request.kaUal,
      assertionVersion: '1',
      publisherPeerId: 'aqc-peer',
      quads,
    });
    return request;
  };
  const two = [
    {
      subject: 'urn:aqc:tpl:a',
      predicate: 'http://schema.org/name',
      object: '"One"',
      graph: '',
    },
    {
      subject: 'urn:aqc:tpl:b',
      predicate: 'http://schema.org/name',
      object: '"Two"',
      graph: '',
    },
  ];
  const out = {};
  // the failed one stages a single triple against a request that declares two: canonicalization_failed
  for (const [kind, n, quads] of [
    ['finalized', 0, two],
    ['failed', 1, two.slice(0, 1)],
  ]) {
    const request = await stage(n, quads);
    const mark = journalInserts.length;
    await admission.enqueueKnowledgeAssetVmPublish(request, {
      admittedByAgentAddress: AGENT,
    });
    if (!(await runtime.processNext('aqc-tpl-wallet')))
      throw new Error(`lift template: processNext returned no job for ${kind}`);
    const job = (await admission.list()).find((j) => j.request.knowledgeAssetVmPublish.name === request.name);
    if (!job || job.status !== kind) throw new Error(`lift template: expected a ${kind} job, got ${job?.status}`);
    const journal = journalInserts
      .slice(mark)
      .map((quadsOf) => {
        const row = {};
        for (const quad of quadsOf) row[quad.predicate] = quad.object;
        const entry = CP.parseJournalEntry(row);
        if (!entry) throw new Error('lift template: cannot parse a captured journal entry');
        return entry;
      })
      .sort((a, b) => a.seq - b.seq);
    out[kind] = normalizeTemplate({
      job: JSON.parse(JSON.stringify(job)),
      journal,
      request,
    });
  }
  await runtime.drainDetachedExecutions?.();
  return out;
}

/** The j-th retained job and its journal, cloned from a template and keyed uniquely (own lifecycle key per job). */
export function cloneHistoryJob(tpl, j, { liftControl: CP }, { baseTime, wallets = 6 }) {
  const id = jobIdOf(j);
  const name = `hist-ka-${j}`;
  const shareOperationId = `so-hist-${j}`;
  const ualNumber = 5_000_000 + j;
  const wallet = walletIdsOf(wallets)[j % wallets];
  const job = JSON.parse(JSON.stringify(tpl.job));
  const payload = job.request.knowledgeAssetVmPublish;
  const root = `0x${sha(`root-hist-${j}`)}`;
  const tx = `0x${sha(`tx-hist-${j}`)}`;
  job.jobId = id;
  payload.name = name;
  payload.shareOperationId = shareOperationId;
  payload.kaNumber = String(ualNumber);
  payload.kaUal = payload.reservedUal = `did:dkg:31337/${AUTHOR}/${ualNumber}`;
  payload.intentKey = `sha256:${sha(`intent-hist-${j}`)}`;
  payload.sealMerkleRoot = payload.seal.merkleRoot = root;
  payload.wmCurrentAssertion = payload.swmCurrentAssertion = root.slice(2);
  payload.seal.reservedKaId = ((BigInt(AUTHOR) << 96n) | BigInt(ualNumber)).toString();
  job.jobSlug = CP.createJobSlug(job.request);
  job.controlPlane = {
    jobRef: CP.jobSubject(id),
    walletLockRef: CP.walletLockSubject(wallet),
  };
  if (job.claim)
    job.claim = {
      ...job.claim,
      walletId: wallet,
      claimToken: `${wallet}:${id}:${sha(`claim-${j}`).slice(0, 36)}`,
    };
  if (job.validation)
    job.validation.authorityProofRef = `urn:dkg:knowledge-assets:${CG_ID}:${name}:${shareOperationId}:vm-publish`;
  if (job.broadcast) {
    job.broadcast.txHash = tx;
    job.broadcast.walletId = wallet;
  }
  if (job.inclusion) job.inclusion.txHash = tx;
  if (job.finalization) {
    job.finalization.txHash = tx;
    job.finalization.ual = payload.kaUal;
    job.finalization.batchId = job.finalization.startKAId = job.finalization.endKAId = String(ualNumber);
  }
  if (job.failure) job.failure.errorPayloadRef = `urn:dkg:publisher:error:${id}`; // the product keys it by job id
  const shift = baseTime - HOUR_MS - j * 1000; // the job is accepted at least an hour before baseTime
  for (const k of Object.keys(job.timestamps)) if (typeof job.timestamps[k] === 'number') job.timestamps[k] += shift;
  if (job.claim?.claimLeaseExpiresAt) job.claim.claimLeaseExpiresAt += shift;
  const lineageKey = CP.knowledgeAssetVmPublishLifecycleKey({
    contextGraphId: CG_ID,
    name,
  });
  const journal = tpl.journal.map((e) => {
    const entry = { ...e, jobId: id, lineageKey, at: e.at + shift };
    if (e.intentKey !== undefined) entry.intentKey = payload.intentKey;
    if (e.txHash !== undefined) entry.txHash = tx;
    if (e.ual !== undefined) entry.ual = payload.kaUal;
    if (e.merkleRoot !== undefined) entry.merkleRoot = job.broadcast?.merkleRoot ?? e.merkleRoot;
    return entry;
  });
  return { job, journal };
}

/** Quads of history job j (job record, request subject and journal entries), serialized by the product. */
export function historyJobQuads(templates, j, deps, { baseTime, failedFraction = 0.05, wallets = 6 }) {
  const { liftControl: CP } = deps;
  const tpl = isFailedHistoryJob(j, failedFraction) ? templates.failed : templates.finalized;
  const { job, journal } = cloneHistoryJob(tpl, j, deps, { baseTime, wallets });
  const record = CP.serializeJobRecord(job, CP.DEFAULT_CONTROL_GRAPH_URI);
  return {
    status: job.status,
    jobQuads: [...record.jobQuads, ...record.requestQuads],
    journalQuads: journal.flatMap((e) => CP.serializeJournalEntry(e, CP.DEFAULT_JOURNAL_GRAPH_URI)),
  };
}

/** Yields Quad[] of batchJobs jobs each, with the counts of what they hold. */
export function* liftHistoryBatches(deps, templates, n, { baseTime, failedFraction, wallets, batchJobs = 400 }) {
  for (let from = 0; from < n; from += batchJobs) {
    const counts = { jobs: 0, failed: 0, jobQuads: 0, journalQuads: 0 };
    const quads = [];
    for (let j = from; j < Math.min(n, from + batchJobs); j++) {
      const r = historyJobQuads(templates, j, deps, {
        baseTime,
        failedFraction,
        wallets,
      });
      counts.jobs++;
      if (r.status === 'failed') counts.failed++;
      counts.jobQuads += r.jobQuads.length;
      counts.journalQuads += r.journalQuads.length;
      quads.push(...r.jobQuads, ...r.journalQuads);
    }
    yield { quads, counts };
  }
}

/**
 * Streams the N-Quads (gzip if path ends in .gz), hashes the uncompressed bytes and writes <path>.json. Returns the
 * manifest.
 */
export async function writeLiftSeedFile(deps, { jobs, baseTime, failedFraction = 0.05, wallets = 6, path }) {
  const templates = await buildLiftTemplates(deps);
  const hash = createHash('sha256');
  const totals = {
    quads: 0,
    bytes: 0,
    failed: 0,
    jobQuads: 0,
    journalQuads: 0,
  };
  async function* text() {
    for (const { quads, counts } of liftHistoryBatches(deps, templates, jobs, {
      baseTime,
      failedFraction,
      wallets,
    })) {
      const chunk = `${deps.storage.quadsToNQuads(quads)}\n`; // ASCII only, as Blazegraph's bulk endpoint reads it
      hash.update(chunk);
      totals.quads += quads.length;
      totals.bytes += Buffer.byteLength(chunk);
      totals.failed += counts.failed;
      totals.jobQuads += counts.jobQuads;
      totals.journalQuads += counts.journalQuads;
      yield chunk;
    }
  }
  await pipeline(text, ...(path.endsWith('.gz') ? [createGzip()] : []), createWriteStream(path));
  const manifest = {
    schema: 1,
    kind: 'lift',
    jobs,
    quads: totals.quads,
    bytes: totals.bytes,
    sha256: hash.digest('hex'),
    baseTime,
    failedJobs: totals.failed,
    failedFraction,
    jobQuads: totals.jobQuads,
    journalQuads: totals.journalQuads,
    graphs: [deps.liftControl.DEFAULT_CONTROL_GRAPH_URI, deps.liftControl.DEFAULT_JOURNAL_GRAPH_URI],
    git: gitInfo(),
  };
  writeFileSync(`${path}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Generates and inserts the history through the (unscheduled) seed store, two batches in flight (as loadGenerated). */
export async function loadGeneratedLift(seedStore, deps, { jobs, baseTime, failedFraction = 0.05, wallets = 6 }) {
  const t0 = performance.now();
  const templates = await buildLiftTemplates(deps);
  const inFlight = new Set();
  const failures = [];
  for (const { quads } of liftHistoryBatches(deps, templates, jobs, {
    baseTime,
    failedFraction,
    wallets,
  })) {
    if (failures.length) break;
    const tracked = (async () => seedStore.insert(quads, { source: 'bench.seedLiftHistory' }))()
      .catch((err) => {
        failures.push(err);
      })
      .finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
    if (inFlight.size >= 2) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);
  if (failures.length) throw failures[0];
  return { jobs, ms: Math.round(performance.now() - t0) };
}
