import type { PreparedAgentProfileV1 } from '../src/profile.js';
import {
  type PreparedProfileProjectionSnapshotV1,
  prepareAgentProfileProductionV1,
} from '../src/system-records/agent-profile-producer-preparation-v1.js';
import type {
  AgentProfilePublicationBindingV1,
} from '../src/system-records/agent-profile-producer-api-v1.js';

declare const dependencies: Parameters<typeof prepareAgentProfileProductionV1>[0];
declare const prepared: PreparedAgentProfileV1;
declare const validated: PreparedProfileProjectionSnapshotV1;
declare const publication: AgentProfilePublicationBindingV1;

void prepareAgentProfileProductionV1(dependencies, validated, publication);

// @ts-expect-error preparation accepts a snapshotted projection plan, not a raw profile.
void prepareAgentProfileProductionV1(dependencies, prepared, publication);

// @ts-expect-error package exports block the preparation implementation phase.
type PublishedPreparationPhase = typeof import('@origintrail-official/dkg-agent/dist/system-records/agent-profile-producer-preparation-v1.js');
// @ts-expect-error package exports block the internal artifact helper.
type PublishedArtifactHelper = typeof import('@origintrail-official/dkg-agent/dist/system-records/agent-profile-producer-artifacts-v1-internal.js');
// @ts-expect-error package exports block the signing implementation phase.
type PublishedSigningPhase = typeof import('@origintrail-official/dkg-agent/dist/system-records/agent-profile-producer-signing-v1.js');
// @ts-expect-error package exports block the inventory implementation phase.
type PublishedInventoryPhase = typeof import('@origintrail-official/dkg-agent/dist/system-records/agent-profile-producer-inventory-v1.js');
// @ts-expect-error package exports block the commit implementation phase.
type PublishedCommitPhase = typeof import('@origintrail-official/dkg-agent/dist/system-records/agent-profile-producer-commit-v1.js');

void (undefined as PublishedPreparationPhase | undefined);
void (undefined as PublishedArtifactHelper | undefined);
void (undefined as PublishedSigningPhase | undefined);
void (undefined as PublishedInventoryPhase | undefined);
void (undefined as PublishedCommitPhase | undefined);
