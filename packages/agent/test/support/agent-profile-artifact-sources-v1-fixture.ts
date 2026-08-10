import type { SystemRecordArtifactRepositoryV1 } from '../../src/system-records/artifact-v1.js';
import type { AgentProfileArtifactSourcesV1 } from '../../src/system-records/receiver-v1.js';

export function agentProfileArtifactSources(
  closureArtifacts: SystemRecordArtifactRepositoryV1,
  securitySidecarArtifacts: SystemRecordArtifactRepositoryV1 = closureArtifacts,
): AgentProfileArtifactSourcesV1 {
  return Object.freeze({ closureArtifacts, securitySidecarArtifacts });
}
