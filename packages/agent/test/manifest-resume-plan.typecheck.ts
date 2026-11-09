import type { ManifestResumePlan, ManifestCheckpointUpdate } from '../src/sync/requester/manifest-resume-policy.js';
// @ts-expect-error Replacing a checkpoint requires its update payload.
const missingUpdate: ManifestResumePlan = { checkpointAction: 'replace', seeded: true, resume: { kind: 'fresh', verifiedOffset: 0, rawOffset: 0 } };
void missingUpdate;
declare const update: ManifestCheckpointUpdate;
// @ts-expect-error Expiry belongs to persistence, not a planned checkpoint update.
const syntheticRecord: ManifestCheckpointUpdate = { ...update, expiresAtMs: 10_000 };
void syntheticRecord;
