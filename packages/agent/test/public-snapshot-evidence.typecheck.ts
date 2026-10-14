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
