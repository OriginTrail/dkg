import type {
  DKGAgentConfig,
  FinalizationRecoveryStore,
  FinalizationRecoveryStoreFactory,
} from '@origintrail-official/dkg-agent';

declare const store: FinalizationRecoveryStore;

const factory: FinalizationRecoveryStoreFactory = async (dataDir) => {
  dataDir satisfies string;
  return store;
};

const config: DKGAgentConfig = {
  name: 'external-embedder',
  dataDir: '/var/lib/dkg',
  finalizationRecoveryStoreFactory: factory,
};

config satisfies DKGAgentConfig;
