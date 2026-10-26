// Deterministic retained share-job history for the contention benchmark: the generator, the N-Quads seed file with its
// manifest, and the loaders. A seed FILE is the history both arms of an A/B load: a base and a head worktree can carry
// different serializers, a file is byte-identical for both.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { gitInfo } from './backend.mjs';
import { AGENT, CG_ID } from './fixture.mjs';

const HOUR_MS = 3_600_000;

/** '10k' -> 10000, '50000' -> 50000. */
export function parseCount(v) {
  const m = /^(\d+)(k?)$/i.exec(String(v ?? '0'));
  if (!m) throw new Error(`not a count: ${v} (use 0, 10k, 50k or a number)`);
  return Number(m[1]) * (m[2] ? 1000 : 1);
}

/**
 * The j-th terminal (succeeded) share job, at least an hour old, about targetBytes of payload. Pure: the same (j,
 * baseTime) is the same job.
 */
export function historyJob(j, { baseTime, formatVersion, targetBytes = 750 }) {
  const t = baseTime - HOUR_MS - j * 1000;
  const job = {
    // every uniqueness key is distinct, so the duplicate-check cost matches the measured one
    jobId: `hist-${j.toString(36)}-${(j * 7919).toString(16)}`,
    request: { contextGraphId: CG_ID, assertionName: `hist-asset-${j}`, entities: 'all', agentAddress: AGENT },
    state: 'succeeded',
    enqueuedAt: t,
    updatedAt: t + 5000,
    attempt: { count: 1, maxRetries: 5 },
    result: { promotedCount: 128, succeededAt: t + 5000 },
    commitMarker: {
      promoteStarted: true,
      swmInserted: true,
      wmCleaned: false,
      lifecycleStamped: false,
      gossiped: false,
    },
    formatVersion,
  };
  const len = JSON.stringify(job).length;
  if (len < targetBytes) job.reason = 'x'.repeat(targetBytes - len - 12);
  return job;
}

/** Yields Quad[] of batchJobs jobs each (8 quads per job: the product serializer, the product control graph). */
export function* historyBatches(deps, n, { baseTime, batchJobs = 2500 }) {
  const { serializeJobRecord, DEFAULT_PROMOTE_CONTROL_GRAPH_URI: graph } = deps.utils;
  const formatVersion = deps.pub.ASYNC_PROMOTE_QUEUE_FORMAT_VERSION;
  for (let from = 0; from < n; from += batchJobs) {
    const quads = [];
    for (let j = from; j < Math.min(n, from + batchJobs); j++)
      quads.push(...serializeJobRecord(historyJob(j, { baseTime, formatVersion }), graph).jobQuads);
    yield quads;
  }
}

/**
 * Streams the N-Quads (gzip if path ends in .gz), hashes the uncompressed bytes and writes <path>.json. Returns the
 * manifest.
 */
export async function writeSeedFile(deps, { jobs, baseTime, path }) {
  const hash = createHash('sha256');
  let quads = 0;
  let bytes = 0;
  async function* text() {
    for (const batch of historyBatches(deps, jobs, { baseTime })) {
      const chunk = `${deps.storage.quadsToNQuads(batch)}\n`; // ASCII only, as Blazegraph's bulk endpoint reads it
      hash.update(chunk);
      quads += batch.length;
      bytes += Buffer.byteLength(chunk);
      yield chunk;
    }
  }
  await pipeline(text, ...(path.endsWith('.gz') ? [createGzip()] : []), createWriteStream(path));
  const manifest = {
    schema: 1,
    kind: 'share',
    jobs,
    quads,
    bytes,
    sha256: hash.digest('hex'),
    baseTime,
    formatVersion: deps.pub.ASYNC_PROMOTE_QUEUE_FORMAT_VERSION,
    graph: deps.utils.DEFAULT_PROMOTE_CONTROL_GRAPH_URI,
    git: gitInfo(),
  };
  writeFileSync(`${path}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * POSTs a seed file to a namespace SPARQL endpoint in line-aligned chunks of at most chunkBytes (no scheduler
 * involved). Returns { chunks, quads, sha256 }: sha256 is over the uncompressed bytes actually loaded, to compare with
 * the manifest's (what the run really had).
 */
export async function loadSeedFile(sparqlUrl, path, { chunkBytes = 4 << 20 } = {}) {
  const source = createReadStream(path);
  const stream = path.endsWith('.gz') ? source.pipe(createGunzip()) : source;
  stream.setEncoding('utf8');
  const hash = createHash('sha256');
  let pending = '';
  let tail = '';
  let chunks = 0;
  let quads = 0;
  const post = async () => {
    const res = await fetch(sparqlUrl, { method: 'POST', headers: { 'content-type': 'text/x-nquads' }, body: pending });
    if (!res.ok) throw new Error(`seed load failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    chunks++;
    quads += pending.split('\n').length - 1;
    pending = '';
  };
  for await (const piece of stream) {
    hash.update(piece);
    const data = tail + piece;
    const cut = data.lastIndexOf('\n') + 1;
    tail = data.slice(cut);
    if (pending && pending.length + cut > chunkBytes) await post();
    pending += data.slice(0, cut);
  }
  pending += tail;
  if (pending.trim()) await post();
  return { chunks, quads, sha256: hash.digest('hex') };
}

/**
 * Generates and inserts the history through the (unscheduled) seed store, two batches in flight. A failed insert is
 * recorded when it settles, not when the loop next looks at the in-flight set, so it cannot be lost to a sibling that
 * settled first: no further batch starts after it, the insert still in flight settles, and the first failure is thrown.
 */
export async function loadGenerated(seedStore, deps, { jobs, baseTime }) {
  const t0 = performance.now();
  const inFlight = new Set();
  const failures = [];
  for (const batch of historyBatches(deps, jobs, { baseTime })) {
    if (failures.length) break;
    const tracked = (async () => seedStore.insert(batch, { source: 'bench.seedHistory' }))()
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
