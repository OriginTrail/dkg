// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad, SharedMemoryGraphScope } from '@origintrail-official/dkg-storage';
import type { DKGPublisher } from '@origintrail-official/dkg-publisher';
import { unpackKnowledgeAssetId } from './ka-identity.js';

type FinalizedLifecycleSwmDescriptor = Parameters<
  DKGPublisher['ensureFinalizedLifecycleSwmPlacement']
>[0];
type EnsuredFinalizedLifecycleSwmPlacement = Awaited<ReturnType<
  DKGPublisher['ensureFinalizedLifecycleSwmPlacement']
>>;

type NamedLifecycleSharedMemoryScope = Extract<
  SharedMemoryGraphScope,
  { kind: 'named-lifecycle' }
>;

interface FinalizedLifecycleSwmIdentity {
  authorAddress: string;
  contextGraphId: string;
  assertionName: string;
  assertionLifecycleAgentAddress: string;
  subGraphName?: string;
  rootEntities: readonly string[];
}

interface FinalizedLifecycleSwmPlacementDependencies {
  publisher: Pick<DKGPublisher, 'ensureFinalizedLifecycleSwmPlacement'>;
  operationContext: OperationContext;
}

/**
 * Derive the SWM identity boundary bound by a finalized seal.
 *
 * This lifecycle/SWM policy is shared by finalize and publish. Legacy or mock
 * seals without a packed KA id retain complete-family compatibility; a real
 * packed namespace must match the sealed author exactly.
 */
export function sharedMemoryScopeForFinalizedLifecycle(
  authorAddress: string,
  packedKaId: bigint | undefined,
): SharedMemoryGraphScope {
  if (packedKaId === undefined) return { kind: 'complete-family' };
  return namedSharedMemoryScopeForFinalizedLifecycle(authorAddress, packedKaId);
}

/** Strict finalized-lifecycle scope for call sites that require a packed id. */
export function namedSharedMemoryScopeForFinalizedLifecycle(
  authorAddress: string,
  packedKaId: bigint,
): NamedLifecycleSharedMemoryScope {
  const unpacked = unpackKnowledgeAssetId(packedKaId);
  const sealedAuthor = ethers.getAddress(authorAddress);
  const packedAuthor = BigInt(unpacked.agentAddress);
  // Legacy/mock seals may carry only the low 96-bit KA number. Preserve that
  // compatibility by binding a zero packed namespace to the sealed author;
  // a real nonzero namespace must still match exactly.
  if (packedAuthor !== 0n && ethers.getAddress(unpacked.agentAddress) !== sealedAuthor) {
    throw new Error(
      `Finalized lifecycle KA id ${packedKaId} is not in author ${sealedAuthor}'s namespace`,
    );
  }
  return {
    kind: 'named-lifecycle',
    identity: { agentAddress: sealedAuthor, kaNumber: unpacked.kaNumber },
  };
}

function placementDescriptor(
  identity: FinalizedLifecycleSwmIdentity,
  scope: NamedLifecycleSharedMemoryScope,
): FinalizedLifecycleSwmDescriptor {
  return {
    lifecycle: {
      contextGraphId: identity.contextGraphId,
      assertionName: identity.assertionName,
      assertionLifecycleAgentAddress: identity.assertionLifecycleAgentAddress,
      subGraphName: identity.subGraphName,
    },
    sealAuthorScope: scope.identity,
    rootEntities: identity.rootEntities,
  };
}

async function ensureNamedPlacement(
  identity: FinalizedLifecycleSwmIdentity,
  scope: NamedLifecycleSharedMemoryScope,
  dependencies: FinalizedLifecycleSwmPlacementDependencies,
): Promise<EnsuredFinalizedLifecycleSwmPlacement> {
  return dependencies.publisher.ensureFinalizedLifecycleSwmPlacement(
    placementDescriptor(identity, scope),
    dependencies.operationContext,
  );
}

/**
 * Strict finalize boundary: derive the named scope, repair placement, and own
 * the established source-empty failure contract in one operation.
 */
export async function placeFinalizedLifecycleSwm(
  input: FinalizedLifecycleSwmIdentity &
    FinalizedLifecycleSwmPlacementDependencies & { packedKaId: bigint },
): Promise<Extract<EnsuredFinalizedLifecycleSwmPlacement, { sourceEmpty: false }>> {
  const scope = namedSharedMemoryScopeForFinalizedLifecycle(
    input.authorAddress,
    input.packedKaId,
  );
  const placement = await ensureNamedPlacement(input, scope, input);
  if (placement.sourceEmpty) {
    throw Object.assign(
      new Error(
        `No shared-memory quads remain for finalized lifecycle "${input.assertionName}" ` +
          `in context graph "${input.contextGraphId}"`,
      ),
      { code: 'SWM_MIGRATION_SOURCE_EMPTY' },
    );
  }
  return placement;
}

/**
 * Publish boundary for finalized SWM: derive compatibility scope, perform the
 * named placement when possible, load the exact selected payload, and own the
 * no-data policy. Callers receive one ready-to-publish payload and never
 * assemble migration/load/source-empty state themselves.
 */
export async function prepareFinalizedLifecycleSwmForPublish(
  input: FinalizedLifecycleSwmIdentity &
    FinalizedLifecycleSwmPlacementDependencies & {
      packedKaId: bigint | undefined;
      load: (scope: SharedMemoryGraphScope) => Promise<Quad[]>;
    },
): Promise<{ scope: SharedMemoryGraphScope; quads: Quad[] }> {
  const scope = sharedMemoryScopeForFinalizedLifecycle(
    input.authorAddress,
    input.packedKaId,
  );
  if (scope.kind === 'named-lifecycle') {
    const placement = await ensureNamedPlacement(input, scope, input);
    if (placement.sourceEmpty) {
      throw new Error(
        `No quads in shared memory for context graph ${input.contextGraphId} matching selection`,
      );
    }
  }

  const quads = await input.load(scope);
  if (quads.length === 0) {
    throw new Error(
      `No quads in shared memory for context graph ${input.contextGraphId} matching selection`,
    );
  }
  return { scope, quads };
}
