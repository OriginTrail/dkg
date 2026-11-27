import { assertionLifecycleUri, contextGraphMetaUri, toAgentDid } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { LifecycleMetadataOptions } from './metadata.js';

let eventCounter = 0;
export function nextEventId(): string {
  return `${Date.now().toString(36)}-${(++eventCounter).toString(36)}`;
}

export interface AssertionWrittenMeta {
  contextGraphId: string;
  agentAddress: string;
  assertionName: string;
  subGraphName?: string;
  /** Canonical WM graph, used for writes with no payload quads. */
  assertionGraph: string;
  /** Actual physical destinations after named-graph mapping. */
  destinationGraphs?: readonly string[];
  /** Number of payload quads submitted in this call, including duplicates. */
  quadCount: number;
  timestamp: Date;
}

/** One successful append activity; lite mode omits events without changing data. */
export function generateAssertionWrittenMetadata(
  meta: AssertionWrittenMeta,
  opts?: LifecycleMetadataOptions,
): Quad[] {
  if (opts?.provenanceEvents === false) return [];
  const assertion = assertionLifecycleUri(meta.contextGraphId, meta.agentAddress, meta.assertionName, meta.subGraphName);
  const subject = `${assertion}/event/${nextEventId()}`;
  const graph = contextGraphMetaUri(meta.contextGraphId);
  const prov = 'http://www.w3.org/ns/prov#';
  const dkg = 'http://dkg.io/ontology/';
  const xsd = 'http://www.w3.org/2001/XMLSchema#';
  const destinations = new Set(meta.destinationGraphs?.length ? meta.destinationGraphs : [meta.assertionGraph]);
  const terms = [
    ['http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${prov}Activity`],
    ['http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${dkg}AssertionWritten`],
    [`${prov}startedAtTime`, `"${meta.timestamp.toISOString()}"^^<${xsd}dateTime>`],
    [`${prov}wasAssociatedWith`, toAgentDid(meta.agentAddress)],
    [`${prov}used`, assertion],
    ...[...destinations].map((destination) => [`${dkg}assertionGraph`, destination]),
    [`${dkg}quadCount`, `"${meta.quadCount}"^^<${xsd}integer>`],
  ];
  return terms.map(([predicate, object]) => ({ subject, predicate, object, graph }));
}
