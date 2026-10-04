import type { PreparedAssertionPromoteSource } from '../../src/assertion-promote-source.js';
import {
  createPromoteOperationIntent,
  type PromoteOperationIntent,
} from '../../src/promote-operation-intent.js';

const intent: PromoteOperationIntent = createPromoteOperationIntent({
  operationId: 'operation-1',
  timestampMs: 1_700_000_000_000,
  confirmationRequired: false,
  accessPolicy: 'public',
});

// @ts-expect-error Durable envelope fields are immutable after codec validation.
intent.timestampMs += 1;
// @ts-expect-error The peer collection is immutable after codec validation.
intent.allowedPeers.push('peer-b');

export type ImmutablePromoteOperationIntent = typeof intent;

type PreparedClaim = PreparedAssertionPromoteSource['promoteClaim'];
const freshClaim: PreparedClaim = { kind: 'absent' };
const legacyClaim: PreparedClaim = { kind: 'legacy', operationId: 'operation-1' };
const replayClaim: PreparedClaim = { kind: 'modern', operationId: intent.operationId,
  serializedIntent: 'validated-wire-intent', intent };
// @ts-expect-error Corrupt claims cannot escape successful source preparation.
const corruptClaim: PreparedClaim = { kind: 'corrupt', error: new Error('corrupt') };
// @ts-expect-error A fresh source cannot carry an orphaned immutable intent.
const orphanedIntent: PreparedClaim = { kind: 'absent', intent };
// @ts-expect-error An ID-only legacy claim cannot carry a modern intent.
const ambiguousLegacy: PreparedClaim = { kind: 'legacy', operationId: 'operation-1', intent };
// @ts-expect-error A replay cannot omit its validated immutable envelope.
const incompleteReplay: PreparedClaim = { kind: 'modern', operationId: 'operation-1' };

export type PreparedPromoteClaimContracts = [typeof freshClaim, typeof legacyClaim, typeof replayClaim,
  typeof corruptClaim, typeof orphanedIntent, typeof ambiguousLegacy, typeof incompleteReplay];
