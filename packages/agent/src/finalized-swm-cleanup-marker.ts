// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  FINALIZED_SWM_CLEANUP_HEAD_FINGERPRINT_PREDICATE,
  FINALIZED_SWM_CLEANUP_MARKED_AT_PREDICATE,
  FINALIZED_SWM_CLEANUP_ROOT_PREDICATE,
  FINALIZED_SWM_CLEANUP_TASK_TYPE,
} from './dkg-agent-constants.js';

const DKG = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

/** Stable fields that identify one exact graph-scoped SWM lifecycle. */
export interface FinalizedSwmCleanupHeadIdentity {
  kaUal: string;
  assertionVersion: bigint | number | string;
  assertionGraph: string;
  publicQuadsDigest: string;
  publicTripleCount: number;
  privateMerkleRoot?: string;
  privateTripleCount: number;
  shareOperationId: string;
  publisherPeerId: string;
  accessPolicy?: string;
  allowedPeers: readonly string[];
}

export function finalizedSwmCleanupHeadFingerprint(
  head: FinalizedSwmCleanupHeadIdentity,
): string {
  return createHash('sha256').update(JSON.stringify({
    kaUal: head.kaUal,
    assertionVersion: head.assertionVersion.toString(),
    assertionGraph: head.assertionGraph,
    publicQuadsDigest: head.publicQuadsDigest,
    publicTripleCount: head.publicTripleCount,
    privateMerkleRoot: head.privateMerkleRoot?.toLowerCase(),
    privateTripleCount: head.privateTripleCount,
    shareOperationId: head.shareOperationId,
    publisherPeerId: head.publisherPeerId,
    accessPolicy: head.accessPolicy,
    allowedPeers: [...head.allowedPeers].sort(),
  })).digest('hex');
}

export function finalizedSwmCleanupTaskSubject(input: {
  contextGraphId: string;
  subGraphName?: string;
  head: FinalizedSwmCleanupHeadIdentity;
}): string {
  const key = JSON.stringify([
    input.contextGraphId,
    input.subGraphName ?? '',
    input.head.kaUal,
    input.head.assertionVersion.toString(),
    input.head.shareOperationId,
  ]);
  return `urn:dkg:finalized-swm-cleanup:${createHash('sha256').update(key).digest('hex')}`;
}

/** Build the durable, constant-size work item owned by the idle GC worker. */
export function buildFinalizedSwmCleanupTaskQuads(input: {
  contextGraphId: string;
  subGraphName?: string;
  head: FinalizedSwmCleanupHeadIdentity;
  expectedMerkleRootHex: string;
  metaGraph: string;
  markedAtIso: string;
}): Quad[] {
  const taskSubject = finalizedSwmCleanupTaskSubject(input);
  const integer = (value: bigint | number | string) =>
    `"${String(value)}"^^<${XSD_INTEGER}>`;
  return [
    { subject: taskSubject, predicate: RDF_TYPE, object: FINALIZED_SWM_CLEANUP_TASK_TYPE, graph: input.metaGraph },
    { subject: taskSubject, predicate: `${DKG}contentScopeVersion`, object: integer(GRAPH_KA_CONTENT_SCOPE_VERSION), graph: input.metaGraph },
    { subject: taskSubject, predicate: `${DKG}kaUal`, object: input.head.kaUal, graph: input.metaGraph },
    { subject: taskSubject, predicate: `${DKG}assertionVersion`, object: integer(input.head.assertionVersion), graph: input.metaGraph },
    { subject: taskSubject, predicate: `${DKG}shareOperationId`, object: JSON.stringify(input.head.shareOperationId), graph: input.metaGraph },
    { subject: taskSubject, predicate: `${DKG}assertionGraph`, object: input.head.assertionGraph, graph: input.metaGraph },
    { subject: taskSubject, predicate: FINALIZED_SWM_CLEANUP_ROOT_PREDICATE, object: JSON.stringify(input.expectedMerkleRootHex.toLowerCase()), graph: input.metaGraph },
    { subject: taskSubject, predicate: FINALIZED_SWM_CLEANUP_HEAD_FINGERPRINT_PREDICATE, object: JSON.stringify(finalizedSwmCleanupHeadFingerprint(input.head)), graph: input.metaGraph },
    { subject: taskSubject, predicate: FINALIZED_SWM_CLEANUP_MARKED_AT_PREDICATE, object: `"${input.markedAtIso}"^^<${XSD_DATE_TIME}>`, graph: input.metaGraph },
    ...(input.subGraphName ? [{
      subject: taskSubject,
      predicate: `${DKG}subGraphName`,
      object: JSON.stringify(input.subGraphName),
      graph: input.metaGraph,
    }] : []),
  ];
}
