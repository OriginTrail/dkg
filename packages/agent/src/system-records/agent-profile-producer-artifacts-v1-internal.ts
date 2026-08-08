import type { AgentProfileProducerPublicationArtifactsV1 } from './agent-profile-producer-api-v1.js';
import type { SystemRecordArtifactV1 } from './artifact-v1.js';

export function flattenAgentProfileProducerPublicationArtifactsV1(
  artifacts: AgentProfileProducerPublicationArtifactsV1,
): readonly SystemRecordArtifactV1[] {
  return Object.freeze([
    artifacts.head,
    artifacts.bundle,
    artifacts.ownedSubjectTable,
    ...artifacts.inventoryObjects,
  ]);
}
