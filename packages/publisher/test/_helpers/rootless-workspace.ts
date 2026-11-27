import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  createGraphKnowledgeAssetScope,
  decodeWorkspacePublishRequest,
  encodeWorkspacePublishRequest,
  knowledgeAssetLayerGraphUri,
  MemoryLayer,
  type WorkspacePublishRequestMsg,
} from '@origintrail-official/dkg-core';
import { parseSimpleNQuads } from '../../src/publish-handler.js';

const DEFAULT_AGENT = '0x0000000000000000000000000000000000000001';

/**
 * Stable, non-cryptographic fixture number. Reusing an operation id reuses the
 * same KA identity, while unrelated test messages do not accidentally collide.
 */
function fixtureKaNumber(contextGraphId: string, identityHint: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(`${contextGraphId}\0${identityHint}`)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return String((hash >>> 0) + 1);
}

export type RootlessWorkspaceRequest = Omit<
  WorkspacePublishRequestMsg,
  | 'manifest'
  | 'contentScopeVersion'
  | 'publicTripleCount'
  | 'privateTripleCount'
> & {
  manifest?: WorkspacePublishRequestMsg['manifest'];
  contentScopeVersion?: number;
  publicTripleCount?: number;
  privateTripleCount?: number;
};

/** Encode a complete graph-scoped KA envelope for receiver-focused tests. */
export function encodeRootlessWorkspaceRequest(
  input: RootlessWorkspaceRequest,
): Uint8Array {
  const agentAddress = input.agentAddress?.trim() || DEFAULT_AGENT;
  const parsedQuads = parseSimpleNQuads(new TextDecoder().decode(input.nquads));
  // Most receiver fixtures model one KA over one stable subject. The subject is
  // only a deterministic test-id hint; it is never emitted as root metadata or
  // used by production content selection.
  const identityHint = parsedQuads[0]?.subject || input.shareOperationId;
  const kaNumber = input.kaNumber?.trim()
    || fixtureKaNumber(input.contextGraphId, identityHint);
  const kaUal = input.kaUal?.trim()
    || `did:dkg:31337/${agentAddress.toLowerCase()}/${kaNumber}`;
  const scope = createGraphKnowledgeAssetScope(
    kaUal,
    input.assertionVersion?.trim() || '1',
  );
  if (scope.agentAddress.toLowerCase() !== agentAddress.toLowerCase()) {
    throw new Error(
      `Fixture agent ${agentAddress} does not match KA UAL agent ${scope.agentAddress}`,
    );
  }
  if (scope.kaNumber !== kaNumber) {
    throw new Error(
      `Fixture KA number ${kaNumber} does not match KA UAL number ${scope.kaNumber}`,
    );
  }
  const publicTripleCount = input.publicTripleCount
    ?? parsedQuads.length;

  return encodeWorkspacePublishRequest({
    ...input,
    manifest: [],
    agentAddress,
    kaNumber,
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: scope.ual,
    assertionVersion: scope.assertionVersion,
    publicTripleCount,
    privateTripleCount: input.privateTripleCount ?? 0,
  });
}

export function rootlessSharedMemoryGraphFromWire(payload: Uint8Array): string {
  const request = decodeWorkspacePublishRequest(payload);
  return rootlessSharedMemoryGraph(
    request.contextGraphId,
    request,
    request.subGraphName,
  );
}

export function rootlessSharedMemoryGraph(
  contextGraphId: string,
  request: Pick<WorkspacePublishRequestMsg, 'kaUal' | 'assertionVersion'>,
  subGraphName?: string,
): string {
  const scope = createGraphKnowledgeAssetScope(
    request.kaUal ?? '',
    request.assertionVersion ?? '',
  );
  return knowledgeAssetLayerGraphUri(
    contextGraphId,
    MemoryLayer.SharedWorkingMemory,
    scope,
    subGraphName,
  );
}
