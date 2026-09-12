/** Controlled RTT experiment at the production requester's fetchSyncPages port.
 * Run after building the agent. This measures requester scheduling and offered
 * concurrency; it does not simulate responder CPU, network loss, or bandwidth.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import { syncPublicSnapshotsForMeta } from '../dist/sync/requester/shared-memory-sync.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const positive = (name, fallback) => {
  const value = Number(args.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};
const rows = positive('--rows', 250);
const rttMs = positive('--rtt-ms', 1_000);
const roundMs = positive('--round-ms', 120_000);
const limits = (args.get('--limits') ?? '1,2,4').split(',').map(Number);
const payloads = Array.from({ length: rows }, (_, i) => [{ subject: `urn:benchmark:ka:${i}`, predicate: 'urn:p', object: '"value"', graph: '' }]);
const refs = payloads.map(workspacePublicQuadsDigest);
const byRef = new Map(refs.map((ref, i) => [ref, payloads[i]]));
const metaQuads = refs.flatMap((ref, i) => [['publicSnapshotRef', ref], ['publicQuadsDigest', ref], ['publicQuadsCount', '1']]
  .map(([name, value]) => ({ subject: `urn:op:${i}`, predicate: `http://dkg.io/ontology/${name}`, object: `"${value}"`, graph: '' })));
const moduleHashes = Object.fromEntries(['shared-memory-sync', 'public-snapshot-recovery'].map(name => [
  name, createHash('sha256').update(readFileSync(new URL(`../dist/sync/requester/${name}.js`, import.meta.url))).digest('hex'),
]));
console.log(JSON.stringify({ experiment: 'controlled-requester-rtt', rows, rttMs, roundMs, limits, moduleHashes }));
for (const fetchConcurrency of limits) {
  const snapshots = new Map();
  let active = 0; let peak = 0; let requests = 0;
  const started = performance.now();
  const result = await syncPublicSnapshotsForMeta({
    ctx: createOperationContext('sync'), remotePeerId: 'controlled-latency-peer', contextGraphId: 'paired-pool',
    metaQuads, deadline: Date.now() + roundMs, fetchConcurrency,
    publicSnapshotStore: {
      getSnapshot: async ref => snapshots.get(ref) ?? null,
      putSnapshot: async ({ digest, quads }) => { snapshots.set(digest, quads); return { ref: digest, byteLength: Buffer.byteLength(JSON.stringify(quads)) }; },
    },
    fetchSyncPages: async (_ctx, _peer, _cg, _shared, _phase, _graph, _deadline, options) => {
      active++; requests++; peak = Math.max(peak, active);
      try {
        await delay(rttMs);
        const quads = byRef.get(options.snapshotRef);
        if (!quads) throw new Error('Unexpected snapshot ref');
        return { quads, bytesReceived: Buffer.byteLength(JSON.stringify(quads)), resumedFromOffset: 0,
          responderSessionStartedFresh: true, nextOffset: 1, checkpointKey: options.snapshotRef, completed: true, timedOut: false };
      } finally { active--; }
    },
    deleteCheckpoint: () => {}, setCheckpoint: () => {},
  });
  if (active !== 0 || peak > fetchConcurrency || snapshots.size !== result.readySnapshots) throw new Error('Pool ownership/accounting mismatch');
  console.log(JSON.stringify({ fetchConcurrency, elapsedMs: Math.round(performance.now() - started), requests, peakRequests: peak,
    ready: result.readySnapshots, missing: result.missingCount, completed: result.completed,
    yieldedAtDeadline: result.yieldedAtDeadline, peerTimeouts: result.timedOutPhases }));
}
