import type { PreparedAgentProfileV1 } from '../src/profile.js';
import {
  prepareAgentProfileProductionV1,
  type ValidatedAgentProfileProductionInputV1,
} from '../src/system-records/agent-profile-producer-preparation-v1.js';
import type {
  AgentProfileProducerPreparationDependenciesV1,
  AgentProfilePublicationBindingV1,
} from '../src/system-records/agent-profile-producer-contract-v1.js';

declare const dependencies: AgentProfileProducerPreparationDependenciesV1;
declare const prepared: PreparedAgentProfileV1;
declare const validated: ValidatedAgentProfileProductionInputV1;
declare const publication: AgentProfilePublicationBindingV1;

void prepareAgentProfileProductionV1(dependencies, validated, publication);

// @ts-expect-error preparation accepts only the bound validated snapshot/projection input.
void prepareAgentProfileProductionV1(dependencies, prepared, publication);
