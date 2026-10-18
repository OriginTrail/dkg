// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import { assertionLifecycleUri, contextGraphMetaUri, formatSparqlTerm, contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { KnowledgeAssetVmPublishRequest } from '@origintrail-official/dkg-publisher';

const DKG = 'http://dkg.io/ontology/';
export type NamedKaLifecycleRecoveryFacts = Pick<KnowledgeAssetVmPublishRequest,
  'contextGraphId' | 'name' | 'subGraphName' | 'kaNumber' | 'kaUal' | 'assertionVersion'>
  & { shareOperationId?: string; sealMerkleRoot: string };

/** Only called after canonical transaction proof and exact VM materialization.
 * A descriptor's required state can be absent after an interrupted replacement;
 * the retained identity, version and VM root must independently prove its owner.
 */
export async function incompleteNamedKaLifecycleAuthor(
  store: TripleStore, request: NamedKaLifecycleRecoveryFacts, author: string,
  options: { allowPublishedState?: boolean; requireCompleteVmProjection?: boolean } = {},
): Promise<string> {
  const refuse = (reason: string): never => {
    throw Object.assign(new Error(`Cannot repair published descriptor for "${request.name}": ${reason}`), {
      code: 'KA_VM_RECOVERY_INCONSISTENT',
    });
  };
  if (!request.kaNumber || !request.kaUal || !request.assertionVersion
    || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(request.sealMerkleRoot)) return refuse('incomplete recovery identity');
  const authors = /^0x[0-9a-fA-F]{40}$/.test(author)
    ? [...new Set([author, ethers.getAddress(author.toLowerCase()), author.toLowerCase()])]
    : [author];
  const graph = formatSparqlTerm(contextGraphMetaUri(request.contextGraphId), { position: 'graph' });
  const candidates = authors.map(address => ({ address,
    subject: assertionLifecycleUri(request.contextGraphId, address, request.name, request.subGraphName) }));
  const result = await store.query(`SELECT ?subject ?p ?o WHERE {
    VALUES ?subject { ${candidates.map(c => formatSparqlTerm(c.subject, { position: 'subject' })).join(' ')} }
    GRAPH ${graph} { ?subject ?p ?o }
  }`, { source: 'agent.recovery.incompleteNamedLifecycle' });
  if (result.type !== 'bindings') return refuse('lifecycle facts unavailable');
  const subjects = new Set(result.bindings.map(row => row.subject));
  if (subjects.size !== 1) return refuse('missing or ambiguous lifecycle identity; retain the original job evidence');
  const candidate = candidates.find(c => subjects.has(c.subject));
  if (!candidate) return refuse('unknown lifecycle subject');
  const one = (predicate: string): string | undefined => {
    const values = result.bindings.filter(row => row.p === predicate).map(row => row.o);
    if (values.length > 1) return refuse(`conflicting ${predicate} values`);
    return values[0];
  };
  const literal = (predicate: string): string | undefined => {
    const value = one(DKG + predicate);
    if (value === undefined) return undefined;
    const parsed = parseRdfLiteralTerm(value);
    if (!parsed || parsed.kind === 'language' || (parsed.kind === 'typed'
      && parsed.datatype !== (['kaId', 'assertionVersion'].includes(predicate)
        ? 'http://www.w3.org/2001/XMLSchema#integer' : 'http://www.w3.org/2001/XMLSchema#string'))) return refuse(`invalid ${predicate} literal`);
    return parsed.value;
  };
  const state = literal('state');
  if (state !== undefined && !(options.allowPublishedState && state === 'published')) {
    return refuse('state exists but the descriptor could not be resolved');
  }
  if (options.requireCompleteVmProjection && (literal('publishedUal') !== request.kaUal
    || literal('memoryLayer') !== 'VM'
    || one(DKG + 'assertionGraph') !== contextGraphLayerUri(request.contextGraphId, MemoryLayer.VerifiableMemory,
      author, BigInt(request.kaNumber), request.subGraphName))) return refuse('incomplete published identity or layer');
  if (literal('assertionName') !== request.name
    || one('http://www.w3.org/ns/prov#wasAttributedTo')?.toLowerCase() !== `did:dkg:agent:${author}`.toLowerCase()
    || literal('kaId') !== request.kaNumber
    || literal('reservedUal') !== request.kaUal
    || literal('assertionVersion') !== request.assertionVersion) {
    return refuse('retained name, author, reservation or version does not match the confirmed request');
  }
  const root = (value?: string) => value?.toLowerCase().replace(/^0x/, '');
  const confirmedRoot = root(request.sealMerkleRoot);
  if (root(literal('vmCurrentAssertion')) !== confirmedRoot) return refuse('missing or different confirmed VM pointer');
  for (const predicate of ['wmCurrentAssertion', 'swmCurrentAssertion']) {
    const value = literal(predicate);
    if (value !== undefined && root(value) !== confirmedRoot) return refuse('a newer local draft or share must be preserved');
  }
  const operation = literal('shareOperationId');
  if (request.shareOperationId !== undefined && operation !== undefined && operation !== request.shareOperationId) return refuse('a different share owns this lifecycle');
  return candidate.address;
}
