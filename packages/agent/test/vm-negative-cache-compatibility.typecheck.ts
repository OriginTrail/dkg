import type {
  ContextGraphSubscriptionStore,
  VmReconcileNegativeRecord,
} from '../src/index.js';

// Existing custom stores may still declare the retired optional hooks.
const record: VmReconcileNegativeRecord = {
  cacheKey: 'cg#ka', localCgId: 'cg', failures: 1, nextRetryAt: 0,
  swmGen: '0', candidateNamespaces: [], peerTopologyKey: 'unreadable',
};
const store: ContextGraphSubscriptionStore = {
  loadAll: async () => [], save: async () => {}, delete: async () => {},
  loadVmReconcileNegative: async () => record,
  saveVmReconcileNegative: async (_record: VmReconcileNegativeRecord) => {},
  deleteVmReconcileNegative: async (_cacheKey: string) => {},
  deleteVmReconcileNegativesForContextGraph: async (_contextGraphId: string) => {},
};
void store;
