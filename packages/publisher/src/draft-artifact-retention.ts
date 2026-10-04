// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { createGraphKnowledgeAssetScope, sparqlString } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { CONTROL_HAS_REQUEST, CONTROL_JOB_TYPE, CONTROL_PAYLOAD, CONTROL_REQUEST_TYPE, RDF_TYPE_PREDICATE } from './async-lift-control-plane.js';
import { decodeLiftJobPayload } from './lift-job-payload-codec.js';
import type { KnowledgeAssetVmPublishRequest } from './lift-job.js';
import { withKeyedLocks } from './keyed-lock.js';

const locks = new WeakMap<TripleStore, Map<string, Promise<void>>>();
const RETIREMENTS = 'urn:dkg:publisher:draft-artifact-retirements';
const RETIRED_AT = 'urn:dkg:publisher:draftArtifactRetiredAt';
const JOB_LIMIT = 256;

/** Admission and artifact collection share one store-local reference boundary. */
export function withDraftArtifactReferences<T>(store: TripleStore, fn: () => Promise<T>): Promise<T> {
  let map = locks.get(store);
  if (!map) { map = new Map(); locks.set(store, map); }
  return withKeyedLocks(map, ['draft-artifact-references'], fn);
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
