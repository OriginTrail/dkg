// SPDX-License-Identifier: Apache-2.0
import { buildAssertionSealQuads, parseAssertionSealQuads, canonicalGraphScopedAuthorSealFromAssertionSealV1,
  assertionLifecycleUri, contextGraphAssertionUri, contextGraphMetaUri,
  createGraphKnowledgeAssetScope, MemoryLayer, knowledgeAssetLayerGraphUri,
  type AssertionSeal } from '@origintrail-official/dkg-core';
import { tryReplaceSubjectAtomically, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { hexlify } from 'ethers';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import { assertionRecoverySealGraph, assertionRecoverySealSubject, type ConfirmedGraphKnowledgeAssetProof } from '@origintrail-official/dkg-publisher';
import type { ConfirmedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle-evidence.js';
import { NamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';
import { packKnowledgeAssetIdFromIdentity } from './ka-identity.js';
const SUBJECT = 'urn:dkg:confirmed-lifecycle-seal';
const DKG = 'http://dkg.io/ontology/';
const integer = (n: string | bigint) => `"${n}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
const root = (bytes: Uint8Array) => hexlify(bytes).slice(2).toLowerCase();
const invalid = (): never => { throw new NamedKaVmLifecycleIntegrityError('Invalid confirmed named assertion seal evidence'); };

/** Stable public seal wire: no private plaintext or mutable workspace fields. */
export function confirmedNamedSealQuads(seal: AssertionSeal, packedKaId: bigint): readonly Quad[] {
  return buildAssertionSealQuads({ ...seal, assertionUri: SUBJECT, metaGraph: '',
    reservedKaId: packedKaId, contentScopeVersion: 2, kaUal: seal.kaUal!,
    assertionVersion: seal.assertionVersion!, publicTripleCount: seal.publicTripleCount!,
    privateTripleCount: seal.privateTripleCount!, rootEntities: undefined });
}

export function normalizeConfirmedNamedSeal(value: unknown, input: ConfirmedNamedKaVmLifecycleInput, proof?: ConfirmedGraphKnowledgeAssetProof): readonly Quad[] {
  if (!Array.isArray(value) || value.some(q => !q || typeof q !== 'object'
    || q.subject !== SUBJECT || q.graph !== '' || typeof q.predicate !== 'string' || typeof q.object !== 'string')) return invalid();
  const seal = parseAssertionSealQuads(value, SUBJECT);
  if (!seal || seal.contentScopeVersion !== 2 || !seal.kaUal || seal.assertionVersion !== input.assertionVersion
    || root(seal.merkleRoot) !== input.merkleRoot.replace(/^0x/, '').toLowerCase()
    || seal.chainId.toString() !== input.publicationDeployment.chainId
    || seal.kav10Address.toLowerCase() !== input.publicationDeployment.lifecycleAddress.toLowerCase()
    || seal.reservedKaId !== input.packedKaId) return invalid();
  const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
  if (packKnowledgeAssetIdFromIdentity(scope) !== input.packedKaId
    || seal.authorAddress.toLowerCase() !== scope.agentAddress.toLowerCase()) return invalid();
  if (proof && (seal.publicTripleCount !== proof.publicTripleCount
    || seal.privateTripleCount !== proof.privateTripleCount
    || (seal.privateMerkleRoot && root(seal.privateMerkleRoot)) !== proof.privateMerkleRoot
    || (input.materialization && scope.ual !== input.materialization.kaUal)
    || proof.assertionGraph !== knowledgeAssetLayerGraphUri(input.contextGraphId, MemoryLayer.VerifiableMemory, scope, input.subGraphName))) return invalid();
  const canonical = confirmedNamedSealQuads(seal, input.packedKaId);
  const terms = (quads: readonly Quad[]) => quads.map(q => JSON.stringify([q.predicate, q.object])).sort().join('\n');
  if (terms(value) !== terms(canonical)) return invalid();
  return Object.freeze(canonical.map(q => Object.freeze(q)));
}

/** The caller holds the lifecycle lock and certifies all writes with its captured barrier. */
export async function restoreConfirmedNamedAssertion(store: TripleStore, input: ConfirmedNamedKaVmLifecycleInput, proof: ConfirmedGraphKnowledgeAssetProof): Promise<void> {
  const meta = contextGraphMetaUri(input.contextGraphId);
  const assertion = contextGraphAssertionUri(input.contextGraphId, input.agentAddress, input.name, input.subGraphName);
  const lifecycle = assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.name, input.subGraphName);
  const archiveGraph = assertionRecoverySealGraph(input.contextGraphId, input.subGraphName);
  const archive = assertionRecoverySealSubject(input.contextGraphId, input.name, input.agentAddress, input.subGraphName);
  const read = async (subject: string, graph: string) => {
    const result = await store.query(`CONSTRUCT { <${subject}> ?p ?o } WHERE { GRAPH <${graph}> { <${subject}> ?p ?o } }`);
    if (result.type !== 'quads') throw new Error('Confirmed named assertion evidence read unavailable');
    return result.quads;
  };
  let sealQuads = input.namedSealQuads && normalizeConfirmedNamedSeal(input.namedSealQuads, input, proof);
  if (!sealQuads) {
    for (const [subject, graph] of [[assertion, meta], [archive, archiveGraph]]) {
      const rows = await read(subject!, graph!);
      try {
        const stored = parseAssertionSealQuads(rows, subject!);
        if (!stored || (stored.reservedKaId !== undefined && stored.reservedKaId !== input.packedKaId)) continue;
        sealQuads = normalizeConfirmedNamedSeal(confirmedNamedSealQuads(stored, input.packedKaId), input, proof);
        break;
      } catch { /* Historical evidence may need its authenticated original seal. */ }
    }
  }
  if (!sealQuads) throw new Error('Confirmed lifecycle repair awaits its authenticated named assertion seal');
  const seal = parseAssertionSealQuads([...sealQuads], SUBJECT)!;
  const scope = createGraphKnowledgeAssetScope(seal.kaUal!, input.assertionVersion);
  const existing = await read(lifecycle, meta);
  const required = [
    { predicate: DKG + 'kaId', object: integer(BigInt(scope.kaNumber)) },
    { predicate: DKG + 'reservedUal', object: JSON.stringify(scope.ual) },
    { predicate: DKG + 'contentScopeVersion', object: integer('2') },
    { predicate: DKG + 'assertionName', object: JSON.stringify(input.name) },
  ];
  const value = (term: string, predicate: string): string | undefined => {
    const literal = parseRdfLiteralTerm(term);
    const numeric = predicate === DKG + 'kaId' || predicate === DKG + 'contentScopeVersion';
    if (literal) {
      if (literal.kind === 'language' || (literal.kind === 'typed'
        && literal.datatype !== `http://www.w3.org/2001/XMLSchema#${numeric ? 'integer' : 'string'}`)) return undefined;
      return literal.value;
    }
    return predicate === DKG + 'reservedUal' ? term.replace(/^<|>$/g, '') : undefined;
  };
  const additions: Quad[] = [];
  for (const field of required) {
    const rows = existing.filter(q => q.predicate === field.predicate);
    if (rows.length === 0) additions.push({ ...field, subject: lifecycle, graph: meta });
    else if (rows.length !== 1 || value(rows[0]!.object, field.predicate) !== value(field.object, field.predicate)) throw new Error('Confirmed named assertion reservation conflicts with surviving records');
  }
  if (!existing.some(q => q.predicate === DKG + 'assertionVersion')) additions.push({ subject: lifecycle,
    predicate: DKG + 'assertionVersion', object: integer(input.assertionVersion), graph: meta });
  // An intact original active seal already supports pull/edit. Preserve newer active
  // drafts; only their recovery archive may need the original publication's seal.
  const canonicalSeal = (value: AssertionSeal) => JSON.stringify(canonicalGraphScopedAuthorSealFromAssertionSealV1({
    ...value, reservedKaId: input.packedKaId, contentScopeVersion: 2,
  }));
  const sameSeal = (rows: Quad[], subject: string): boolean => {
    try {
      const stored = parseAssertionSealQuads(rows, subject);
      return !!stored && (stored.reservedKaId === undefined || stored.reservedKaId === input.packedKaId)
        && canonicalSeal(stored) === canonicalSeal(seal);
    } catch { return false; }
  };
  if (!sameSeal(await read(assertion, meta), assertion)) {
    const archived = await read(archive, archiveGraph);
    const current = parseAssertionSealQuads(archived, archive);
    if (current?.assertionVersion && BigInt(current.assertionVersion) > BigInt(input.assertionVersion)) {
      throw new Error('Confirmed named assertion recovery awaits newer archived seal reconciliation');
    }
    if (!sameSeal(archived, archive)) {
      const recovered = sealQuads.map(q => ({ ...q, subject: archive, graph: archiveGraph }));
      if (!await tryReplaceSubjectAtomically(store, archiveGraph, archive, recovered, { source: 'agent.publish.confirmedNamedSeal' })) {
        throw new Error('Confirmed named assertion recovery requires atomic seal replacement');
      }
    }
  }
  if (additions.length) await store.insert(additions);
}
