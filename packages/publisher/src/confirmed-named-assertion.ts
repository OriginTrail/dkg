// SPDX-License-Identifier: Apache-2.0
import { buildAssertionSealQuads, parseAssertionSealQuads, canonicalGraphScopedAuthorSealFromAssertionSealV1, canonicalizeCanonicalGraphScopedAuthorSealV1,
  assertionLifecycleUri, contextGraphAssertionUri, contextGraphMetaUri, createGraphKnowledgeAssetScope,
  MemoryLayer, knowledgeAssetLayerGraphUri, type CanonicalGraphScopedAuthorSealV1 } from '@origintrail-official/dkg-core';
import { tryReplaceSubjectAtomically, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { getBytes } from 'ethers';
import type { ConfirmedGraphKnowledgeAssetProof } from './confirmed-metadata-reconciliation.js';
import { decodeAssertionLifecycleRecord, decodeAssertionReservationValue } from './assertion-lifecycle-record.js';
import { generateAssertionReservationMetadata, sameAssertionReservationField, decodeAssertionReservationIdentity,
  ASSERTION_RESERVATION_PREDICATES as RESERVATION } from './assertion-reservation.js';
import { assertionRecoverySealGraph, assertionRecoverySealSubject, parseStoredAssertionSeal } from './assertion-seal-recovery.js';
import { withAssertionAllocation } from './assertion-ka-slot-ownership.js';

export interface ConfirmedNamedAssertionTarget {
  readonly contextGraphId: string;
  readonly agentAddress: string;
  readonly name: string;
  readonly subGraphName?: string;
  readonly packedKaId: bigint;
  readonly assertionVersion: string;
  readonly merkleRoot: string;
  readonly publicationDeployment: { readonly chainId: string; readonly lifecycleAddress: string };
  readonly kaUal?: string;
}
function invalid(): never {
  throw Object.assign(new Error('Invalid confirmed named assertion seal evidence'), { code: 'CONFIRMED_NAMED_ASSERTION_INTEGRITY' });
}
/** Bind already decoded seal fields to the confirmed command and its materialization. */
export function assertConfirmedNamedAssertionSeal(seal: CanonicalGraphScopedAuthorSealV1, target: ConfirmedNamedAssertionTarget, proof?: ConfirmedGraphKnowledgeAssetProof): void {
  if (seal.assertionVersion !== target.assertionVersion || seal.reservedKaId !== target.packedKaId.toString()
    || seal.assertionMerkleRoot.slice(2) !== target.merkleRoot.replace(/^0x/, '').toLowerCase()
    || seal.assertedAtChainId !== target.publicationDeployment.chainId
    || seal.assertedAtKav10Address !== target.publicationDeployment.lifecycleAddress.toLowerCase()
    || (target.kaUal !== undefined && seal.kaUal !== target.kaUal)) return invalid();
  if (proof) {
    const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
    if (seal.assertionVersion !== proof.assertionVersion || seal.reservedKaId !== proof.batchId
      || seal.assertionMerkleRoot.slice(2) !== proof.merkleRoot || Number(seal.publicTripleCount) !== proof.publicTripleCount || Number(seal.privateTripleCount) !== proof.privateTripleCount
      || (seal.privateMerkleRoot?.slice(2) ?? undefined) !== proof.privateMerkleRoot
      || proof.assertionGraph !== knowledgeAssetLayerGraphUri(target.contextGraphId, MemoryLayer.VerifiableMemory, scope, target.subGraphName)) return invalid();
  }
}
/** Render only at a wire/store write boundary; execution otherwise uses canonical fields. */
export function confirmedNamedAssertionSealQuads(seal: CanonicalGraphScopedAuthorSealV1, subject: string, graph: string): Quad[] {
  return buildAssertionSealQuads({ assertionUri: subject, metaGraph: graph, merkleRoot: getBytes(seal.assertionMerkleRoot),
    authorAddress: seal.authorAddress, authorAttestationR: getBytes(seal.authorAttestationR), authorAttestationVS: getBytes(seal.authorAttestationVS),
    authorSchemeVersion: 1, chainId: BigInt(seal.assertedAtChainId), kav10Address: seal.assertedAtKav10Address,
    reservedKaId: BigInt(seal.reservedKaId), finalizedAtIso: seal.assertionFinalizedAt, contentScopeVersion: 2,
    kaUal: seal.kaUal, assertionVersion: seal.assertionVersion, publicTripleCount: Number(seal.publicTripleCount),
    privateTripleCount: Number(seal.privateTripleCount), privateMerkleRoot: seal.privateMerkleRoot === null ? undefined : getBytes(seal.privateMerkleRoot) });
}
/** Caller holds the named lifecycle/materialization locks and owns the final persistence barrier. */
export async function reconcileConfirmedNamedAssertion(store: TripleStore, target: ConfirmedNamedAssertionTarget & { readonly kaUal: string },
  proof: ConfirmedGraphKnowledgeAssetProof, admittedSeal?: CanonicalGraphScopedAuthorSealV1): Promise<void> {
  const identity = createGraphKnowledgeAssetScope(target.kaUal, target.assertionVersion);
  if (((BigInt(identity.agentAddress) << 96n) | BigInt(identity.kaNumber)) !== target.packedKaId) return invalid();
  return withAssertionAllocation(store, { contextGraphId: target.contextGraphId, lifecycleOwner: target.agentAddress,
    name: target.name, subGraphName: target.subGraphName }, { agentAddress: identity.agentAddress, number: BigInt(identity.kaNumber), kaUal: identity.ual },
    () => reconcileWithAllocationLock(store, target, proof, admittedSeal));
}
async function reconcileWithAllocationLock(store: TripleStore, target: ConfirmedNamedAssertionTarget,
  proof: ConfirmedGraphKnowledgeAssetProof, admittedSeal?: CanonicalGraphScopedAuthorSealV1): Promise<void> {
  const meta = contextGraphMetaUri(target.contextGraphId);
  const assertion = contextGraphAssertionUri(target.contextGraphId, target.agentAddress, target.name, target.subGraphName);
  const lifecycle = assertionLifecycleUri(target.contextGraphId, target.agentAddress, target.name, target.subGraphName);
  const archiveGraph = assertionRecoverySealGraph(target.contextGraphId, target.subGraphName);
  const archive = assertionRecoverySealSubject(target.contextGraphId, target.name, target.agentAddress, target.subGraphName);
  const read = async (subject: string, graph: string) => {
    const result = await store.query(`CONSTRUCT { <${subject}> ?p ?o } WHERE { GRAPH <${graph}> { <${subject}> ?p ?o } }`);
    if (result.type !== 'quads') throw new Error('Confirmed named assertion evidence read unavailable');
    return result.quads;
  };
  const decode = (rows: Quad[], subject: string): CanonicalGraphScopedAuthorSealV1 | undefined => {
    const stored = parseStoredAssertionSeal(rows, subject);
    if (!stored || (stored.reservedKaId !== undefined && stored.reservedKaId !== target.packedKaId)) return undefined;
    try { return canonicalGraphScopedAuthorSealFromAssertionSealV1({ ...stored, reservedKaId: target.packedKaId, contentScopeVersion: 2 }); }
    catch { return undefined; }
  };
  const activeRows = await read(assertion, meta);
  let archivedRows: Quad[] | undefined;
  const readArchive = async () => archivedRows ??= await read(archive, archiveGraph);
  let seal = admittedSeal;
  if (seal) assertConfirmedNamedAssertionSeal(seal, target, proof);
  else for (const subject of [assertion, archive]) {
    const candidate = decode(subject === assertion ? activeRows : await readArchive(), subject);
    if (!candidate) continue;
    try { assertConfirmedNamedAssertionSeal(candidate, target, proof); seal = candidate; break; }
    catch { /* Historical commands remain pending until a matching original seal is available. */ }
  }
  if (!seal) throw new Error('Confirmed lifecycle repair awaits its authenticated named assertion seal');
  const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion), existing = await read(lifecycle, meta);
  const ontology = 'http://dkg.io/ontology/';
  const reservation = decodeAssertionReservationIdentity(decodeAssertionLifecycleRecord(existing.map(q => ({ p: q.predicate, o: q.object }))), target.agentAddress);
  if (reservation.kind === 'conflict') throw new Error('Confirmed named assertion reservation conflicts with surviving records');
  const projection = generateAssertionReservationMetadata({ contextGraphId: target.contextGraphId, agentAddress: target.agentAddress,
    assertionName: target.name, subGraphName: target.subGraphName, kaNumber: scope.kaNumber, reservedUal: scope.ual });
  const additions: Quad[] = [];
  for (const predicate of Object.values(RESERVATION)) {
    const desired = projection.find(quad => quad.predicate === predicate), rows = existing.filter(q => q.predicate === predicate);
    if (desired && rows.length === 0) additions.push(desired);
    else if (rows.some(row => desired === undefined || !sameAssertionReservationField(desired, row.object))) {
      throw new Error('Confirmed named assertion reservation conflicts with surviving records');
    }
  }
  const scopes = existing.filter(q => q.predicate === ontology + 'contentScopeVersion');
  if (!scopes.length) additions.push({ subject: lifecycle, graph: meta, predicate: ontology + 'contentScopeVersion',
    object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' });
  else if (scopes.length !== 1 || decodeAssertionReservationValue(ontology + 'contentScopeVersion', scopes[0]!.object) !== '2') {
    throw new Error('Confirmed named assertion reservation conflicts with surviving records');
  }
  if (!existing.some(q => q.predicate === ontology + 'assertionVersion')) additions.push({ subject: lifecycle, graph: meta,
    predicate: ontology + 'assertionVersion', object: `"${seal.assertionVersion}"^^<http://www.w3.org/2001/XMLSchema#integer>` });
  const originalSeal = canonicalizeCanonicalGraphScopedAuthorSealV1(seal);
  const same = (candidate: CanonicalGraphScopedAuthorSealV1 | undefined) => candidate !== undefined && canonicalizeCanonicalGraphScopedAuthorSealV1(candidate) === originalSeal;
  // Leave active drafts/seals untouched; restore the original only in the publisher's recovery archive.
  if (!same(decode(activeRows, assertion))) {
    const rows = await readArchive(), archived = decode(rows, archive);
    // A malformed archive cannot authorize its own replacement; keep the obligation.
    const current = parseAssertionSealQuads(rows, archive);
    if (rows.length > 0 && !current) throw new Error('Confirmed named assertion recovery awaits malformed archived seal reconciliation');
    if (current?.assertionVersion && BigInt(current.assertionVersion) > BigInt(seal.assertionVersion)) throw new Error('Confirmed named assertion recovery awaits newer archived seal reconciliation');
    if (!same(archived) && !await tryReplaceSubjectAtomically(store, archiveGraph, archive,
      confirmedNamedAssertionSealQuads(seal, archive, archiveGraph), { source: 'agent.publish.confirmedNamedSeal' })) {
      throw new Error('Confirmed named assertion recovery requires atomic seal replacement');
    }
  }
  if (additions.length) await store.insert(additions);
}
