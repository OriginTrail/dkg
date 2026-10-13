import type { PublicSnapshotEvidence } from '../dist/public-snapshot-evidence.js';

declare const evidence: PublicSnapshotEvidence;
// @ts-expect-error The authentication index belongs to the evidence owner.
evidence.assets.clear();
// @ts-expect-error Consumers may not replace pinned roots.
evidence.snapshot.assets[0]!.root = 'other';
