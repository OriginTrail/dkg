import { ethers } from 'ethers';
import {
  ASSERTION_SEAL_PREDICATES, GRAPH_KA_CONTENT_SCOPE_VERSION, assertSafeIri, parseAssertionSealQuads,
  contextGraphMetaUri, contextGraphAssertionUri, contextGraphPrivateUri, contextGraphSubGraphPrivateUri, createGraphKnowledgeAssetScope, isSwmMerkleExcludedQuad,
  type AssertionSeal, type GraphKnowledgeAssetScope,
} from '@origintrail-official/dkg-core';
import type { GraphManager, Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { readAssertionLifecycleRecord } from './assertion-lifecycle-record.js';
import { resolveKnowledgeAssetWorkspaceHead } from './workspace-resolution.js';
import { workspacePublicQuadsDigest } from './workspace-snapshot-store.js';
import { assertNoKnowledgeAssetPayloadNamedGraphs } from './knowledge-asset-graph-policy.js';
import { skolemizeKnowledgeAssetParts } from './auto-partition.js';
import { computePrivateRootV10 as computePrivateRoot, computeFlatKCRootV10 as computeFlatKCRoot } from './merkle.js';

interface PullRecoveryProof {
  store: TripleStore;
  graphManager: GraphManager;
  contextGraphId: string;
  name: string;
  agentAddress: string;
  subGraphName?: string;
  operationId: string | undefined;
  archived: ResolvedAssertionSource['loadedSeal'] | undefined;
  activeSubjects: string[];
  shareComplete: boolean;
  readPublicQuads: (graph: string) => Promise<Quad[]>;
  readPrivateQuads: (scope: GraphKnowledgeAssetScope) => Promise<Quad[]>;
}

export interface ResolvedAssertionSource {
  loadedSeal: { seal: AssertionSeal; subject: string; quads: Quad[] };
  scope: GraphKnowledgeAssetScope;
  payload: Awaited<ReturnType<typeof validateGraphScopedPayloadAgainstSeal>>;
}

/** Prove an interrupted clear belongs to the exact completed SWM commitment. */
export async function verifyPullRecoverySeal(input: PullRecoveryProof): Promise<ResolvedAssertionSource | undefined> {
  const { store, graphManager, contextGraphId, name, agentAddress, subGraphName,
    operationId, archived, activeSubjects, shareComplete, readPublicQuads, readPrivateQuads } = input;
  if (!archived || archived.seal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) return undefined;
  const { seal } = archived;
  if (!seal.kaUal || !seal.assertionVersion) return undefined;
  const lifecycle = await readAssertionLifecycleRecord(
    store, contextGraphId, agentAddress, name, subGraphName, 'strict-reservation',
  );
  const reservedUals = lifecycle.bindings.filter((row) => row.p === 'http://dkg.io/ontology/reservedUal');
  const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
  if (reservedUals.length !== 1 || lifecycle.reservedUal !== scope.ual
    || lifecycle.number !== BigInt(scope.kaNumber)) return undefined;
  if (!shareComplete) return undefined;

  // A partial clear can only REMOVE fields. Conflicting surviving fields may
  // belong to a newer finalized draft and must never authorize its replacement.
  const predicates = new Set<string>(Object.values(ASSERTION_SEAL_PREDICATES));
  const archivedTerms = new Set(archived.quads.map((quad) => JSON.stringify([quad.predicate, quad.object])));
  for (const subject of activeSubjects) {
    const result = await store.query(
      `CONSTRUCT { <${assertSafeIri(subject)}> ?p ?o } WHERE {
        GRAPH <${assertSafeIri(contextGraphMetaUri(contextGraphId))}> { <${assertSafeIri(subject)}> ?p ?o }
      }`,
    );
    if (result.type !== 'quads' || result.quads.some((quad) => predicates.has(quad.predicate)
      && !archivedTerms.has(JSON.stringify([quad.predicate, quad.object])))) return undefined;
  }
  const head = await resolveKnowledgeAssetWorkspaceHead({
    store, graphManager, contextGraphId, kaUal: seal.kaUal, subGraphName,
  });
  if (!head || head.assertionVersion !== String(seal.assertionVersion)
    || (operationId && !head.operationAliases.some((alias) => alias.shareOperationId === operationId))
    || head.publicTripleCount !== seal.publicTripleCount
    || head.privateTripleCount !== seal.privateTripleCount) return undefined;
  const sourcePublic = (await readPublicQuads(head.assertionGraph))
    .filter((quad) => !isSwmMerkleExcludedQuad(quad));
  if (workspacePublicQuadsDigest(sourcePublic) !== head.publicQuadsDigest) return undefined;
  const sourcePrivate = await readPrivateQuads(scope);
  if (sourcePublic.length === 0 && sourcePrivate.length === 0) return undefined;
  const validated = await validateGraphScopedPayloadAgainstSeal(seal, sourcePublic, sourcePrivate, 'swm-recovery');
  const privateRoot = validated.privateMerkleRoot ? ethers.hexlify(validated.privateMerkleRoot) : undefined;
  if (privateRoot?.replace(/^0x/i, '').toLowerCase()
    !== head.privateMerkleRoot?.replace(/^0x/i, '').toLowerCase()) return undefined;
  return { loadedSeal: archived, scope, payload: validated };
}

export async function validateGraphScopedPayloadAgainstSeal(
  seal: AssertionSeal,
  publicQuads: readonly Quad[],
  privateQuads: readonly Quad[],
  sourceLabel: string,
): Promise<{
  normalizedPublicQuads: Quad[];
  normalizedPrivateQuads: Quad[];
  privateMerkleRoot: Uint8Array | undefined;
}> {
  assertNoKnowledgeAssetPayloadNamedGraphs(publicQuads, privateQuads);
  const normalizedParts = await skolemizeKnowledgeAssetParts(
    [...publicQuads],
    [...privateQuads],
    { allowCanonicalSkolemTerms: true },
  );
  const normalizedPublicQuads = normalizedParts.publicQuads;
  const normalizedPrivateQuads = normalizedParts.privateQuads;
  if (normalizedPublicQuads.length !== seal.publicTripleCount) {
    throw new Error(
      `Graph-scoped assertion triple-count mismatch: seal=${seal.publicTripleCount}, `
      + `${sourceLabel}=${normalizedPublicQuads.length}`,
    );
  }
  if (normalizedPrivateQuads.length !== seal.privateTripleCount) {
    throw new Error(
      `Graph-scoped assertion private triple-count mismatch: seal=${seal.privateTripleCount}, `
      + `private-store=${normalizedPrivateQuads.length}`,
    );
  }
  const privateMerkleRoot = computePrivateRoot(normalizedPrivateQuads);
  const privateRootMatches = seal.privateMerkleRoot === undefined
    ? privateMerkleRoot === undefined
    : privateMerkleRoot !== undefined
      && seal.privateMerkleRoot.length === privateMerkleRoot.length
      && seal.privateMerkleRoot.every((byte, index) => byte === privateMerkleRoot[index]);
  if (!privateRootMatches) {
    throw new Error(
      `Graph-scoped assertion private Merkle mismatch: seal=${seal.privateMerkleRoot
        ? ethers.hexlify(seal.privateMerkleRoot)
        : '(none)'}, private-store=${privateMerkleRoot
        ? ethers.hexlify(privateMerkleRoot)
        : '(none)'}`,
    );
  }
  const merkleRoot = computeFlatKCRoot(
    normalizedPublicQuads,
    privateMerkleRoot ? [privateMerkleRoot] : [],
  );
  if (
    merkleRoot.length !== seal.merkleRoot.length
    || !merkleRoot.every((byte, index) => byte === seal.merkleRoot[index])
  ) {
    throw new Error(
      `Graph-scoped assertion Merkle mismatch: seal=${ethers.hexlify(seal.merkleRoot)}, `
      + `${sourceLabel}=${ethers.hexlify(merkleRoot)}`,
    );
  }
  return { normalizedPublicQuads, normalizedPrivateQuads, privateMerkleRoot };
}

export function assertionRecoverySealGraph(
    contextGraphId: string,
    subGraphName?: string,
  ): string {
    return subGraphName
      ? contextGraphSubGraphPrivateUri(contextGraphId, subGraphName)
      : contextGraphPrivateUri(contextGraphId);
  }

export function assertionRecoverySealSubject(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): string {
    return `${contextGraphAssertionUri(
      contextGraphId,
      agentAddress,
      name,
      subGraphName,
    )}/_recovery_seal`;
  }

/** A torn active seal may coexist with a complete recovery archive. */
export function parseStoredAssertionSeal(quads: Quad[], subject: string): AssertionSeal | undefined {
  try { return parseAssertionSealQuads(quads, subject) ?? undefined; }
  catch { return undefined; }
}
