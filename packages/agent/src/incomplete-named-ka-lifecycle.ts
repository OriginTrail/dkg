// SPDX-License-Identifier: Apache-2.0
import { contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { readAssertionLifecycleCandidates, type KnowledgeAssetVmPublishRequest } from '@origintrail-official/dkg-publisher';

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
  options: { allowPublishedState?: boolean; requireCompatibleVmProjection?: boolean } = {},
): Promise<string> {
  const refuse = (reason: string): never => {
    throw Object.assign(new Error(`Cannot repair published descriptor for "${request.name}": ${reason}`), {
      code: 'KA_VM_RECOVERY_INCONSISTENT',
    });
  };
  if (!request.kaNumber || !request.kaUal || !request.assertionVersion
    || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(request.sealMerkleRoot)) return refuse('incomplete recovery identity');
  let candidates;
  try { candidates = await readAssertionLifecycleCandidates(store, request.contextGraphId, author, request.name, request.subGraphName); }
  catch { return refuse('invalid retained lifecycle reservation'); }
  if (candidates.length !== 1) return refuse('missing or ambiguous lifecycle identity; retain the original job evidence');
  const candidate = candidates[0]!;
  const bindings = candidate.record.bindings;
  const one = (predicate: string): string | undefined => {
    const values = bindings.filter(row => row.p === predicate).map(row => row.o);
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
  if (options.requireCompatibleVmProjection) {
    const published = literal('publishedUal');
    const layer = literal('memoryLayer');
    const graph = one(DKG + 'assertionGraph');
    const permittedGraphs = [MemoryLayer.WorkingMemory, MemoryLayer.SharedWorkingMemory, MemoryLayer.VerifiableMemory]
      .map(layer => contextGraphLayerUri(request.contextGraphId, layer, author, BigInt(request.kaNumber!), request.subGraphName));
    if ((published !== undefined && published !== request.kaUal)
      || layer !== 'VM' || (graph !== undefined && !permittedGraphs.includes(graph))) {
      return refuse('conflicting published identity or layer');
    }
  }
  if (literal('assertionName') !== request.name
    || one('http://www.w3.org/ns/prov#wasAttributedTo')?.toLowerCase() !== `did:dkg:agent:${author}`.toLowerCase()
    || candidate.record.number?.toString() !== request.kaNumber
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
  return candidate.author;
}
