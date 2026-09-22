import type {
  NormalizedRpcUsageWindow,
  RpcUsageCumulativeSnapshot,
} from '../src/index.js';
import {
  RPC_USAGE_SNAPSHOT_CONSUMERS,
  RPC_USAGE_SNAPSHOT_CONSUMER_VOCABULARY_VERSION,
} from '../src/index.js';

// A downstream consumer constructing the pre-getLogs normalized shape remains
// source-compatible. New attribution is optional on the released window type
// and becomes concrete only after normalizeRpcUsageWindow().
const legacyNormalizedWindow: NormalizedRpcUsageWindow = {
  byMethod: {},
  ethCallByConsumer: {},
  lifetimeTotal: 0,
};

void legacyNormalizedWindow;

const snapshotV1: RpcUsageCumulativeSnapshot = {
  schemaVersion: 1,
  consumerVocabularyVersion: RPC_USAGE_SNAPSHOT_CONSUMER_VOCABULARY_VERSION,
  processEpoch: 'process-epoch',
  capturedAtUtc: '2026-09-20T12:00:00.000Z',
  capturedAtMonotonicMs: 1,
  completeness: {
    complete: true,
    reasons: [],
    populationEpoch: 3,
    sources: {
      mainAgent: { status: 'included', totalRegisteredTrackers: 1, totalsRetained: true },
      publisherWallets: { status: 'included', totalRegisteredTrackers: 1, totalsRetained: true },
      routeRuntimes: { status: 'included', totalRegisteredTrackers: 1, totalsRetained: true },
      other: { status: 'included', totalRegisteredTrackers: 0, totalsRetained: true },
    },
  },
  cumulative: {
    methods: { eth_call: 1 },
    consumers: { eth_call: { unattributed: 1 } },
    adapterRoles: { eth_call: { main_agent: 1 } },
  },
};

void snapshotV1;

const consumerVocabularyVersion: 1 = RPC_USAGE_SNAPSHOT_CONSUMER_VOCABULARY_VERSION;
const consumerVocabulary: readonly string[] = RPC_USAGE_SNAPSHOT_CONSUMERS;
void consumerVocabularyVersion;
void consumerVocabulary;
