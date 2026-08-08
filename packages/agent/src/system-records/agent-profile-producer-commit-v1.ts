import type {
  AgentProfileProducerPublicationV1,
  CreateAgentProfileProducerOptionsV1,
} from './agent-profile-producer-contract-v1.js';
import type { AgentProfileProductionInventoryV1 } from './agent-profile-producer-inventory-v1.js';
import type { AgentProfileProductionPreparationV1 } from './agent-profile-producer-preparation-v1.js';
import type { SignedAgentProfileProductionV1 } from './agent-profile-producer-signing-v1.js';

export async function commitAgentProfileProductionV1(
  options: CreateAgentProfileProducerOptionsV1,
  preparation: AgentProfileProductionPreparationV1,
  signed: SignedAgentProfileProductionV1,
  inventoryPlan: AgentProfileProductionInventoryV1,
  signal: AbortSignal,
): Promise<AgentProfileProducerPublicationV1> {
  const commitLease = await options.store.prepareCommit({
    expectedHeadDigest: preparation.snapshot.currentHead?.objectDigest ?? null,
    expectedRootDescriptorDigest: preparation.snapshot.inventory?.descriptorDigest ?? null,
    publicationArtifacts: inventoryPlan.publicationArtifacts,
    inventory: inventoryPlan.inventory,
    rootEnvelope: inventoryPlan.rootEnvelope,
  });
  let committed = false;
  try {
    signal.throwIfAborted();
    await options.install({
      head: preparation.head,
      envelope: signed.envelope,
      canonicalProjectionBytes: preparation.projectionBytes,
      projectionQuads: preparation.projectionQuads,
      ownedSubjectTable: preparation.ownedSubjectTable,
      verifiedAuthoritySummary: inventoryPlan.verifiedAuthoritySummary,
      signal,
    });
    // Installation is the point of no return: a late abort cannot roll it back,
    // so the already-reserved advertisement must commit to keep both views aligned.
    await commitLease.commit();
    committed = true;
  } finally {
    if (!committed) commitLease.abort();
  }
  return Object.freeze({
    headDigest: preparation.headDigest,
    rootDescriptorDigest: inventoryPlan.inventory.descriptorDigest,
    version: preparation.head.version,
    authoritySequence: preparation.head.authoritySequence,
    inventoryWrites: inventoryPlan.inventoryWrites,
    inventoryWriteBytes: inventoryPlan.inventoryWriteBytes,
  });
}
