import type {
  DKGAgentConfig,
  SyncAdaptiveCapacityConfig,
} from '@origintrail-official/dkg-agent';

// Keep the nested adaptive-capacity knobs available to package-root consumers.
// Real literals make every public field name load-bearing for this typecheck.
const adaptiveCapacity: SyncAdaptiveCapacityConfig = {
  enabled: true,
  minInflight: 2,
  maxInflight: 8,
};

const agentConfig: Pick<DKGAgentConfig, 'syncAdaptiveCapacity'> = {
  syncAdaptiveCapacity: adaptiveCapacity,
};

// Omission is a distinct, supported configuration state: it preserves the
// role-aware default instead of manufacturing an empty policy object.
const omittedAgentConfig: Pick<DKGAgentConfig, 'syncAdaptiveCapacity'> = {};

void agentConfig;
void omittedAgentConfig;
