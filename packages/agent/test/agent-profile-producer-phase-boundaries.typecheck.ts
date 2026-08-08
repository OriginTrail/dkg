import type { PreparedAgentProfileV1 } from '../src/profile.js';
import {
  type AgentProfileProducerPreparationDependenciesV1,
  prepareAgentProfileProductionV1,
  type ValidatedAgentProfileProductionInputV1,
} from '../src/system-records/agent-profile-producer-preparation-v1.js';
import type {
  AgentProfilePublicationBindingV1,
} from '../src/system-records/agent-profile-producer-api-v1.js';
// @ts-expect-error phase dependency DTOs are not exported by the producer entrypoint.
import type { AgentProfileProducerPreparationDependenciesV1 as LeakedPreparationDeps } from '../src/system-records/agent-profile-producer-v1.js';
// @ts-expect-error artifact flattening is an inventory/store implementation detail.
import { flattenAgentProfileProducerPublicationArtifactsV1 as leakedFlattenArtifacts } from '../src/system-records/agent-profile-producer-v1.js';

declare const dependencies: AgentProfileProducerPreparationDependenciesV1;
declare const prepared: PreparedAgentProfileV1;
declare const validated: ValidatedAgentProfileProductionInputV1;
declare const publication: AgentProfilePublicationBindingV1;

void prepareAgentProfileProductionV1(dependencies, validated, publication);

// @ts-expect-error callers cannot fabricate the module-private validated-input brand.
const fabricated: ValidatedAgentProfileProductionInputV1 = {
  preparedSnapshot: prepared,
  projectionQuads: prepared.projectionQuads,
  ownedSubjectTable: [],
};
void fabricated;

// @ts-expect-error preparation accepts only the bound validated snapshot/projection input.
void prepareAgentProfileProductionV1(dependencies, prepared, publication);

declare const leaked: LeakedPreparationDeps;
void leaked;
void leakedFlattenArtifacts;

// @ts-expect-error package exports block the preparation implementation phase.
type PublishedPreparationPhase = typeof import('@origintrail-official/dkg-agent/dist/system-records/agent-profile-producer-preparation-v1.js');
// @ts-expect-error package exports block the signing implementation phase.
type PublishedSigningPhase = typeof import('@origintrail-official/dkg-agent/dist/system-records/agent-profile-producer-signing-v1.js');
// @ts-expect-error package exports block the inventory implementation phase.
type PublishedInventoryPhase = typeof import('@origintrail-official/dkg-agent/dist/system-records/agent-profile-producer-inventory-v1.js');
// @ts-expect-error package exports block the commit implementation phase.
type PublishedCommitPhase = typeof import('@origintrail-official/dkg-agent/dist/system-records/agent-profile-producer-commit-v1.js');

void (undefined as PublishedPreparationPhase | undefined);
void (undefined as PublishedSigningPhase | undefined);
void (undefined as PublishedInventoryPhase | undefined);
void (undefined as PublishedCommitPhase | undefined);
