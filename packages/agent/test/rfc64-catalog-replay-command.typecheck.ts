import type { DKGAgent, Rfc64CatalogSelectionV1, Rfc64CatalogConnectionReplayStatusV1, Rfc64CatalogRuntimeSelectionStatusV1 } from '../src/index.js';
import type {
  Rfc64CatalogReplayRecoveryCommandV1,
} from '../src/rfc64/catalog-replay-recovery-runtime-v1.js';

const pending: Rfc64CatalogReplayRecoveryCommandV1 = {
  kind: 'pending-recovery',
  contextGraphId: 'cg',
  policyDigest: 'digest',
};

const full: Rfc64CatalogReplayRecoveryCommandV1 = {
  kind: 'full-connected-peers',
  contextGraphId: 'cg',
  policyDigest: 'digest',
  connectedPeerIds: ['peer'],
};

const invalidPending: Rfc64CatalogReplayRecoveryCommandV1 = {
  kind: 'pending-recovery',
  contextGraphId: 'cg',
  policyDigest: 'digest',
  // @ts-expect-error Pending recovery cannot carry a peer-seeding instruction.
  connectedPeerIds: ['peer'],
};

const invalidConnection: Rfc64CatalogReplayRecoveryCommandV1 = {
  kind: 'connection-demand',
  contextGraphId: 'cg',
  policyDigest: 'digest',
  demand: { peerId: 'peer', generation: 1 },
  // @ts-expect-error A connection demand cannot also claim full-replay semantics.
  connectedPeerIds: ['peer'],
};

void pending;
void full;
void invalidPending;
void invalidConnection;

// Lifecycle machinery remains behind the package-root agent capabilities.
declare const agent: DKGAgent;
// @ts-expect-error Consumers cannot obtain or reset the mutable connection runtime.
agent.rfc64CatalogConnectionReplayRuntimeV1().reset();
void agent.prepareRfc64CatalogConnectionReplayV1('peer');
void agent.prepareRfc64CatalogGraphActivationReplayV1('peer', 'cg');

const selection: Rfc64CatalogSelectionV1 = agent.readRfc64CatalogSelectionV1();
const diagnostics: Rfc64CatalogRuntimeSelectionStatusV1 = agent.readRfc64CatalogRuntimeSelectionV1();
const replay: Rfc64CatalogConnectionReplayStatusV1 | undefined = diagnostics.connectionReplay;
// @ts-expect-error Authority selection has no execution telemetry.
void selection.connectionReplay;
if (replay) {
  // @ts-expect-error Operator snapshots are immutable.
  replay.pendingScopes = 0;
}
