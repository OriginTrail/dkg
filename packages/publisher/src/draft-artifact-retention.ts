// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { createGraphKnowledgeAssetScope, sparqlString } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { CONTROL_HAS_REQUEST, CONTROL_JOB_TYPE, CONTROL_PAYLOAD, CONTROL_REQUEST_TYPE, RDF_TYPE_PREDICATE } from './async-lift-control-plane.js';
import { decodeLiftJobPayload } from './lift-job-payload-codec.js';
import type { KnowledgeAssetVmPublishRequest } from './lift-job.js';
import { withKeyedLocks } from './keyed-lock.js';
interface DraftArtifactFence {
  operations: number;
  collecting: boolean;
  operationWaiters: Array<() => void>;
  collectorWaiters: Array<() => void>;
}
const fences = new WeakMap<TripleStore, DraftArtifactFence>();
const queueFences = new WeakMap<TripleStore, Map<string, Promise<void>>>();

/** Coherent queue-record I/O only; released before collection takes KA ownership. */
export function withDraftArtifactQueueState<T>(store: TripleStore, fn: () => Promise<T>): Promise<T> {
  let locks = queueFences.get(store);
  if (!locks) { locks = new Map(); queueFences.set(store, locks); }
  return withKeyedLocks(locks, ['queue-records'], fn);
}

const RETIREMENTS = 'urn:dkg:publisher:draft-artifact-retirements';
const RETIRED_AT = 'urn:dkg:publisher:draftArtifactRetiredAt';
const JOB_LIMIT = 256;

function fenceFor(store: TripleStore): DraftArtifactFence {
  let fence = fences.get(store);
  if (!fence) {
    fence = { operations: 0, collecting: false, operationWaiters: [], collectorWaiters: [] };
    fences.set(store, fence);
  }
  return fence;
}

function startWaitingCollector(fence: DraftArtifactFence): void {
  if (fence.collecting || fence.operations !== 0) return;
  const resume = fence.collectorWaiters.shift();
  if (resume) { fence.collecting = true; resume(); }
}

/** Shared operation/admission lease; per-KA and claim locks retain write ownership. */
export async function withDraftArtifactReferences<T>(store: TripleStore, fn: () => Promise<T>): Promise<T> {
  const fence = fenceFor(store);
  if (fence.collecting) await new Promise<void>(resolve => fence.operationWaiters.push(resolve));
  else fence.operations += 1;
  // A waiting collector must not couple independent operations to a paused
  // signer. New operations can join an active lease; the last release starts
  // collection synchronously, before another operation can enter.
  try { return await fn(); }
  finally { fence.operations -= 1; startWaitingCollector(fence); }
}

/** Exclusive reference snapshot and retirement; excludes every operation lease. */
export async function withDraftArtifactCollection<T>(store: TripleStore, fn: () => Promise<T>): Promise<T> {
  const fence = fenceFor(store);
  if (fence.collecting || fence.operations !== 0) {
    await new Promise<void>(resolve => fence.collectorWaiters.push(resolve));
  } else fence.collecting = true;
  try { return await fn(); }
  finally {
    fence.collecting = false;
    const operations = fence.operationWaiters.splice(0);
    fence.operations += operations.length;
    for (const resume of operations) resume();
    startWaitingCollector(fence);
  }
}

export function draftOperationReferenceKey(contextGraphId: string, subGraphName: string | undefined, operationId: string): string {
  return JSON.stringify([contextGraphId, subGraphName ?? '', operationId]);
}

export function draftPrivateReferenceKey(contextGraphId: string, subGraphName: string | undefined, agentAddress: string, kaNumber: string, version: string): string {
  return JSON.stringify([contextGraphId, subGraphName ?? '', agentAddress.toLowerCase(), kaNumber, version]);
}

export interface DraftArtifactReferences {
  readonly operations: ReadonlySet<string>;
  readonly privateVersions: ReadonlySet<string>;
  readonly rawNamespaces: ReadonlySet<string>;
}

/** Unknown, damaged, orphaned, or over-budget queue state disables collection. */
export async function readDraftArtifactReferences(store: TripleStore): Promise<DraftArtifactReferences | null> {
  return withDraftArtifactQueueState(store, async () => {
    const orphans = await store.query(`ASK { GRAPH ?g {
      ?request <${RDF_TYPE_PREDICATE}> <${CONTROL_REQUEST_TYPE}> .
      FILTER NOT EXISTS { ?job <${CONTROL_HAS_REQUEST}> ?request }
    } }`, { source: 'publisher.draftArtifacts.orphanRequests', priority: 'background' });
    if (orphans.type !== 'boolean' || orphans.value) return null;
    const rows = await store.query(`SELECT DISTINCT ?job ?payload WHERE { GRAPH ?g {
      { ?job <${RDF_TYPE_PREDICATE}> <${CONTROL_JOB_TYPE}> }
      UNION { ?job <${CONTROL_HAS_REQUEST}> ?request }
      OPTIONAL { ?job <${CONTROL_PAYLOAD}> ?payload }
    } } LIMIT ${JOB_LIMIT + 1}`, { source: 'publisher.draftArtifacts.queueReferences', priority: 'background' });
    if (rows.type !== 'bindings' || rows.bindings.length > JOB_LIMIT) return null;
    const operations = new Set<string>();
    const privateVersions = new Set<string>();
    const rawNamespaces = new Set<string>();
    for (const row of rows.bindings) {
      const decoded = decodeLiftJobPayload(row['payload']);
      if (decoded.kind !== 'canonical' && decoded.kind !== 'compatibility') return null;
      const request = decoded.job.request;
      if (request.jobType === 'lift') {
        const raw = request.lift;
        rawNamespaces.add(JSON.stringify([raw.contextGraphId, raw.subGraphName ?? '']));
        operations.add(draftOperationReferenceKey(raw.contextGraphId, raw.subGraphName, raw.shareOperationId));
      } else {
        const publish = request.knowledgeAssetVmPublish;
        if (!publish.kaUal || !publish.assertionVersion) return null;
        const scope = createGraphKnowledgeAssetScope(publish.kaUal, publish.assertionVersion);
        operations.add(draftOperationReferenceKey(publish.contextGraphId, publish.subGraphName, publish.shareOperationId));
        privateVersions.add(draftPrivateReferenceKey(publish.contextGraphId, publish.subGraphName, scope.agentAddress, scope.kaNumber, scope.assertionVersion));
      }
    }
    return { operations, privateVersions, rawNamespaces };
  });
}

function retirementSubject(contextGraphId: string, subGraphName: string | undefined, operationId: string): string {
  const digest = createHash('sha256').update(draftOperationReferenceKey(contextGraphId, subGraphName, operationId)).digest('hex');
  return `${RETIREMENTS}:${digest}`;
}

/** Persist before deleting a superseded snapshot so late admission cannot strand a job. */
export async function markDraftOperationRetired(store: TripleStore, contextGraphId: string, subGraphName: string | undefined, operationId: string, now: number): Promise<void> {
  await store.insert([{ graph: RETIREMENTS, subject: retirementSubject(contextGraphId, subGraphName, operationId), predicate: RETIRED_AT, object: sparqlString(new Date(now).toISOString()) }]);
}

export async function assertDraftOperationNotRetired(store: TripleStore, request: KnowledgeAssetVmPublishRequest): Promise<void> {
  const result = await store.query(`ASK { GRAPH <${RETIREMENTS}> { <${retirementSubject(request.contextGraphId, request.subGraphName, request.shareOperationId)}> <${RETIRED_AT}> ?at } }`);
  if (result.type !== 'boolean') throw new Error('Cannot determine draft artifact retirement state');
  if (result.value) throw Object.assign(new Error('The superseded share operation was retired; share the current draft before publishing'), { code: 'PUBLISH_INTENT_STALE' });
}
