import {
  GRAPH_KA_CONTENT_SCOPE_VERSION, MemoryLayer, LegacyKnowledgeAssetReadOnlyError,
  contextGraphAssertionUri, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri,
  isSwmMerkleExcludedQuad, type GraphKnowledgeAssetScope,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { validateGraphScopedPayloadAgainstSeal, type ResolvedAssertionSource } from './assertion-seal-recovery.js';

/** Read-only lifecycle inspection; caller policy decides whether recovery is allowed. */
export type AssertionPromoteState = { kind: 'mutable' } | {
  kind: 'blocked';
  error: unknown;
} | { kind: 'swm-seal-unavailable'; error: unknown; operationId: string | undefined };

interface PullSourceInput {
  contextGraphId: string;
  name: string;
  agentAddress: string;
  subGraphName?: string;
  sourceLayer: 'swm' | 'vm';
  state: AssertionPromoteState;
  loadSeals: () => Promise<ResolvedAssertionSource['loadedSeal'][]>;
  verifyRecovery: (operationId: string | undefined) => Promise<ResolvedAssertionSource | undefined>;
  readPublicQuads: (graph: string) => Promise<Quad[]>;
  readPrivateQuads: (scope: GraphKnowledgeAssetScope) => Promise<Quad[]>;
}

/** Normal and recovered pulls return the same complete, validated source. */
export async function resolveAssertionPullSource(input: PullSourceInput): Promise<ResolvedAssertionSource> {
  const { contextGraphId, name, agentAddress, subGraphName, sourceLayer, state } = input;
  let recovery: ResolvedAssertionSource | undefined;
  if (state.kind === 'blocked') throw state.error;
  if (state.kind === 'swm-seal-unavailable') {
    recovery = await input.verifyRecovery(state.operationId);
    if (!recovery) throw state.error;
    if (sourceLayer === 'swm') return recovery;
  }
  const sealSubject = contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName);
  const loadedSeals = recovery ? [recovery.loadedSeal] : await input.loadSeals();
  if (loadedSeals.length === 0) {
    throw Object.assign(new Error(
      `Cannot pull "${name}" from ${sourceLayer.toUpperCase()}: rootless mutation requires a finalized v2 assertion seal`,
    ), { code: 'UNSEALED_PULL_FROM_BLOCKED' });
  }
  let selectedSeal: ResolvedAssertionSource['loadedSeal'] | undefined;
  let selectedScope: GraphKnowledgeAssetScope | undefined;
  let validated: ResolvedAssertionSource['payload'] | undefined;
  let candidateError: unknown;
  let sawLegacySeal = false;

  // Active and recovery seals may legitimately coexist while an edit is
  // open. Validate candidates against the requested exact source graph in
  // priority order; a discarded/torn active seal must never shadow the last
  // complete VM/SWM recovery commitment.
  for (const loadedSeal of loadedSeals) {
    const seal = loadedSeal.seal;
    if (seal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
      sawLegacySeal = true;
      continue;
    }
    if (
      !seal.kaUal
      || !seal.assertionVersion
      || seal.publicTripleCount === undefined
      || seal.privateTripleCount === undefined
    ) {
      candidateError = new Error(`Graph-scoped assertion seal for <${sealSubject}> is incomplete`);
      continue;
    }

    try {
      const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
      const sourceGraph = knowledgeAssetLayerGraphUri(
        contextGraphId,
        sourceLayer === 'swm'
          ? MemoryLayer.SharedWorkingMemory
          : MemoryLayer.VerifiableMemory,
        scope,
        subGraphName,
      );
      const sourcePublicQuads = (await input.readPublicQuads(sourceGraph)).filter(
        (quad) => !isSwmMerkleExcludedQuad(quad),
      );
      const sourcePrivateQuads = await input.readPrivateQuads(scope);
      if (sourcePublicQuads.length === 0 && sourcePrivateQuads.length === 0) {
        throw Object.assign(
          new Error(
            `No exact ${sourceLayer.toUpperCase()} content found for sealed KA ${scope.ual} assertion ${scope.assertionVersion}; WM draft was not modified.`,
          ),
          { code: 'PULL_FROM_EMPTY_SOURCE' },
        );
      }
      const candidatePayload = await validateGraphScopedPayloadAgainstSeal(
        seal,
        sourcePublicQuads,
        sourcePrivateQuads,
        `${sourceLayer}-memory`,
      );
      selectedSeal = loadedSeal;
      selectedScope = scope;
      validated = candidatePayload;
      break;
    } catch (error) {
      candidateError = error;
    }
  }

  if (!selectedSeal || !selectedScope || !validated) {
    if (candidateError) throw candidateError;
    if (sawLegacySeal) throw new LegacyKnowledgeAssetReadOnlyError();
    throw Object.assign(
      new Error(
        `Cannot pull "${name}" from ${sourceLayer.toUpperCase()}: no complete v2 assertion seal matches the exact source graph`,
      ),
      { code: 'UNSEALED_PULL_FROM_BLOCKED' },
    );
  }

  return { loadedSeal: selectedSeal, scope: selectedScope, payload: validated };
}
