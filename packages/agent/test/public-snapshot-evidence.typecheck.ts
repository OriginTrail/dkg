import type { PublicSnapshotEvidence } from '../dist/public-snapshot-evidence.js';

declare const evidence: PublicSnapshotEvidence;
// @ts-expect-error The authentication index belongs to the evidence owner.
evidence.assets.clear();
// @ts-expect-error Consumers may not replace pinned roots.
evidence.snapshot.assets[0]!.root = 'other';

// @ts-expect-error Pinned observation fields cannot be replaced independently of the index.
evidence.observation.snapshot = evidence.snapshot;
// @ts-expect-error Pinned provenance is immutable.
evidence.observation.sourceCore = 'other';
// @ts-expect-error Pinned trust mode is immutable.
evidence.observation.mode = 'rpc-only';

import type { PublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import type { PublicSnapshotObservation } from '../dist/public-snapshot-evidence.js';
declare const raw: PublicGraphSnapshot;
// @ts-expect-error Sealing without validation does not grant accepted snapshot evidence.
const unaccepted: PublicSnapshotObservation = { mode: 'rpc-only', snapshot: raw, sourceCore: null };
void unaccepted;
