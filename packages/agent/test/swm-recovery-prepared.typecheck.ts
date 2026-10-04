import type { GraphScopedSwmRecoveryDescriptor } from '../src/sync/graph-scoped-swm-recovery.js';
import type { PreparedSwmRecoveryDescriptor } from '../src/sync/requester/swm-recovered-provenance.js';
import type { SharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import type { SwmRecoveryCommitAsset } from '../src/sync/requester/swm-recovery-commit.js';

declare const provider: GraphScopedSwmRecoveryDescriptor;
declare const prepared: PreparedSwmRecoveryDescriptor;
declare const materializer: SharedMemorySnapshotMaterializer;

materializer.draftMayReplace('cg', prepared);
// @ts-expect-error provider claims have not crossed local evidence acquisition
materializer.draftMayReplace('cg', provider);
// @ts-expect-error identity retention requires the prepared evidence boundary
materializer.repairHeadPreservingIdentity('cg', provider, 'B');
// @ts-expect-error authenticated operation identity and timestamp belong together
const unpaired: PreparedSwmRecoveryDescriptor = { ...prepared, authenticatedPublisherOperation: { id: 'B' } };

const completed: SwmRecoveryCommitAsset = { kind: 'already-replaced', descriptor: provider };
const equivalent: SwmRecoveryCommitAsset = { kind: 'preserve-equivalent', descriptor: provider };
const replacement: SwmRecoveryCommitAsset = { kind: 'replace', descriptor: provider, loadVerifiedQuads: async () => [] };
// @ts-expect-error replacement requires its verified acquisition capability
const missingLoader: SwmRecoveryCommitAsset = { kind: 'replace', descriptor: provider };
// @ts-expect-error completed assets cannot request contradictory mutation modes
const contradictory: SwmRecoveryCommitAsset = { kind: 'already-replaced', descriptor: provider, requireEquivalent: true };
// @ts-expect-error preserving an equivalent asset requires no placeholder loader
const dummyLoader: SwmRecoveryCommitAsset = { kind: 'preserve-equivalent', descriptor: provider, loadVerifiedQuads: async () => [] };
void [unpaired, completed, equivalent, replacement, missingLoader, contradictory, dummyLoader];

const candidate = prepared.operationCandidates[0]!;
const decodedOwner: string = candidate.semantics.publisherIdentity;
const decodedClock: number = candidate.provenance.publishedAtMs;
const immutableIdentity: string | null = candidate.identityKey;
if (prepared.authenticatedPublisherOperation) {
  const authenticated: true = prepared.authenticatedPublisherOperation.provenance.publisherChronologyAuthenticated;
  void authenticated;
}
// @ts-expect-error a timestamp-only projection cannot cross the prepared candidate boundary
const incompleteCandidate: typeof candidate = { provenance: { shareOperationId: 'B', publishedAtMs: 1 } };
void [decodedOwner, decodedClock, immutableIdentity, incompleteCandidate];
