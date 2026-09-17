// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import type { OrdinalRecoveryTarget } from '../chain-reconciler.js';

/**
 * Pure rotation evidence for exact VM recovery: what one retained slot knows
 * about its peer roster, attempt credits and backoff, and how one observed
 * roster or one physical attempt changes that knowledge. Nothing here
 * allocates capacity, cancels work or touches registry storage.
 */

export type VmRecoveryTarget = Pick<OrdinalRecoveryTarget, 'localCgId' | 'onChainCgId' | 'ordinal' | 'ual' | 'merkleRoot'>;
export type VmRecoverySlotLocator = Pick<VmRecoveryTarget, 'localCgId' | 'onChainCgId' | 'ordinal'>;

export function vmRecoverySlotKey(target: VmRecoverySlotLocator): string {
  return `${target.localCgId}\0${target.onChainCgId}\0${target.ordinal}`;
}

export function vmRecoveryTargetFingerprint(target: Pick<VmRecoveryTarget, 'ual' | 'merkleRoot'>): string {
  return `${target.ual}\0${target.merkleRoot.toLowerCase()}`;
}

/** Point-in-time evidence, independent of the token authorizing slot commands. */
export interface VmRecoveryRotationSnapshot extends Readonly<VmRecoverySlotLocator> {
  readonly fingerprint: string;
  readonly phase: 'collecting' | 'backoff';
  readonly backoffKind?: 'clean-absence' | 'incomplete-cycle';
  readonly candidatePeerIds: readonly string[];
  readonly attemptedPeerIds: readonly string[];
  readonly cleanAbsentPeerIds: readonly string[];
  readonly curatorRosterConfirmed: boolean;
  readonly collectionDeadlineAt: number;
  readonly lastAttemptedPeerId?: string;
  readonly failures: number;
  readonly nextRetryAt: number;
}

declare const slotHandleBrand: unique symbol;
/** Opaque authority for exactly one retained slot generation. */
export type VmRecoverySlotHandle = symbol & { readonly [slotHandleBrand]: true };

export interface VmRecoverySlotCapture {
  readonly handle: VmRecoverySlotHandle;
  readonly snapshot: VmRecoveryRotationSnapshot;
}

export interface VmRecoveryAdmissionParams {
  readonly candidatePeerIds: readonly string[];
  readonly curatorRosterConfirmed: boolean;
  readonly collectionDeadlineAt: number;
}

export interface VmRecoveryRotationPolicy {
  readonly now: number;
  readonly getLocalPeerId: () => string;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

/** Mutable evidence behind one retained generation; it never leaves the registry. */
export interface VmRecoveryRotationRecord extends VmRecoverySlotLocator {
  readonly handle: VmRecoverySlotHandle;
  fingerprint: string;
  phase: 'collecting' | 'backoff';
  backoffKind?: 'clean-absence' | 'incomplete-cycle';
  candidatePeerIds: Set<string>;
  attemptedPeerIds: Set<string>;
  cleanAbsentPeerIds: Set<string>;
  curatorRosterConfirmed: boolean;
  collectionDeadlineAt: number;
  lastAttemptedPeerId?: string;
  failures: number;
  nextRetryAt: number;
}

/** How retained evidence answers one observed roster. */
export type VmRecoveryRosterTransition = 'backoff' | 'collecting' | 'expired';

export function membershipMatches(left: ReadonlySet<string>, right: readonly string[]): boolean {
  return left.size === right.length && right.every(peer => left.has(peer));
}

export function createRotationRecord(
  target: VmRecoveryTarget,
  fingerprint: string,
  params: VmRecoveryAdmissionParams,
): VmRecoveryRotationRecord {
  return {
    handle: Symbol('vm-recovery-slot') as VmRecoverySlotHandle,
    localCgId: target.localCgId, onChainCgId: target.onChainCgId, ordinal: target.ordinal,
    fingerprint, phase: 'collecting',
    candidatePeerIds: new Set(params.candidatePeerIds), attemptedPeerIds: new Set(),
    cleanAbsentPeerIds: new Set(), curatorRosterConfirmed: params.curatorRosterConfirmed,
    collectionDeadlineAt: params.collectionDeadlineAt, failures: 0, nextRetryAt: 0,
  };
}

export function rotationSnapshot(record: VmRecoveryRotationRecord): VmRecoveryRotationSnapshot {
  const { handle: _handle, candidatePeerIds, attemptedPeerIds, cleanAbsentPeerIds, ...fields } = record;
  return Object.freeze({
    ...fields,
    candidatePeerIds: Object.freeze([...candidatePeerIds]),
    attemptedPeerIds: Object.freeze([...attemptedPeerIds]),
    cleanAbsentPeerIds: Object.freeze([...cleanAbsentPeerIds]),
  });
}

export function captureRotation(record: VmRecoveryRotationRecord): VmRecoverySlotCapture {
  return Object.freeze({ handle: record.handle, snapshot: rotationSnapshot(record) });
}

/** Evidence that no longer suppresses anything may donate its slot. */
export function isRotationExpired(record: VmRecoveryRotationRecord, now: number): boolean {
  return record.phase === 'backoff' ? now >= record.nextRetryAt : now >= record.collectionDeadlineAt;
}

/** Absence gathered while curator discovery was unavailable must not suppress the next lookup. */
export function hasUnconfirmedAbsence(record: VmRecoveryRotationRecord, curatorRosterConfirmed: boolean): boolean {
  return record.phase === 'backoff'
    && record.backoffKind === 'clean-absence'
    && (!record.curatorRosterConfirmed || !curatorRosterConfirmed);
}

function reopenCycle(record: VmRecoveryRotationRecord, collectionDeadlineAt: number): void {
  record.phase = 'collecting';
  record.backoffKind = undefined;
  record.nextRetryAt = 0;
  record.collectionDeadlineAt = collectionDeadlineAt;
}

function clearCredits(record: VmRecoveryRotationRecord): void {
  record.attemptedPeerIds.clear();
  record.cleanAbsentPeerIds.clear();
}

/** Fold one observed roster into retained evidence. */
export function reviseRotationRoster(
  record: VmRecoveryRotationRecord,
  params: VmRecoveryAdmissionParams,
  now: number,
): VmRecoveryRosterTransition {
  const { candidatePeerIds, curatorRosterConfirmed } = params;
  if (candidatePeerIds.length === 0) {
    // A transient empty socket view cannot invalidate a completed proof: doing
    // so would redial and refetch every sweep after ordinary disconnects.
    // Partial evidence is different and remains fail-open; drop it so the next
    // non-empty roster starts a genuinely fresh cycle.
    return record.phase === 'backoff' && now < record.nextRetryAt ? 'backoff' : 'expired';
  }
  const membershipUnchanged = membershipMatches(record.candidatePeerIds, candidatePeerIds);
  const rosterProofUpgraded = !record.curatorRosterConfirmed && curatorRosterConfirmed;
  if (!membershipUnchanged) {
    const priorCycleWasIncomplete = record.backoffKind === 'incomplete-cycle'
      || [...record.attemptedPeerIds].some((peerId) => !record.cleanAbsentPeerIds.has(peerId));
    const previousCandidatePeerIds = record.candidatePeerIds;
    const nextCandidatePeerIds = new Set(candidatePeerIds);
    record.candidatePeerIds = new Set(candidatePeerIds);
    record.curatorRosterConfirmed = curatorRosterConfirmed;
    const removedPeer = [...previousCandidatePeerIds].some((peerId) => !nextCandidatePeerIds.has(peerId));
    if (removedPeer) {
      // A proof roster is a set, not an accumulation of surviving credits.
      // Any removal/replacement invalidates the whole cycle so shrink can
      // never manufacture exhaustion or preserve an active suppression.
      reopenCycle(record, params.collectionDeadlineAt);
      clearCredits(record);
      record.lastAttemptedPeerId = undefined;
    } else if (!rosterProofUpgraded) {
      // Pure growth preserves valid credits for retained identities, but the
      // newly observed peer is uncredited and immediately breaks backoff.
      // Do not let a publication-window incomplete response compound into
      // multi-minute suppression merely because startup discovers the same
      // recovery roster one peer at a time. Clean-absence history still
      // keeps its exponential damping; only transport/timing uncertainty
      // starts a fresh base-delay epoch when the evidence universe grows.
      reopenCycle(record, params.collectionDeadlineAt);
      if (priorCycleWasIncomplete) record.failures = 0;
    }
  } else {
    record.curatorRosterConfirmed = curatorRosterConfirmed;
  }
  if (rosterProofUpgraded) {
    // A peer response gathered while curator discovery was unconfirmed is
    // useful transport evidence, not authoritative absence proof. Reprobe
    // the complete now-authoritative roster even when that roster also grew.
    reopenCycle(record, params.collectionDeadlineAt);
    clearCredits(record);
    record.lastAttemptedPeerId = undefined;
  }
  if (record.phase === 'backoff') {
    if (now < record.nextRetryAt) return 'backoff';
    // A deadline only opens a new collection cycle. It never earns another
    // failure/backoff without fresh clean-absence evidence from every peer.
    reopenCycle(record, params.collectionDeadlineAt);
    clearCredits(record);
    return 'collecting';
  }
  // Expired partial evidence fails open and releases its cache slot. The
  // caller reports evidence-free for this pass so a repeatedly ineligible
  // roster cannot refresh all collecting entries just before admission runs.
  return now >= record.collectionDeadlineAt ? 'expired' : 'collecting';
}

function enterBackoff(
  target: VmRecoverySlotLocator,
  record: VmRecoveryRotationRecord,
  kind: NonNullable<VmRecoveryRotationSnapshot['backoffKind']>,
  policy: VmRecoveryRotationPolicy,
): void {
  record.failures += 1;
  const exponentialBackoff = Math.min(
    policy.maxBackoffMs,
    policy.baseBackoffMs * 2 ** Math.max(0, record.failures - 1),
  );
  const jitterSample = createHash('sha256')
    .update(`${policy.getLocalPeerId()}\0${target.localCgId}\0${target.onChainCgId}\0${target.ordinal}\0${record.fingerprint}\0${record.failures}`)
    .digest()
    .readUInt32BE(0) / 0x1_0000_0000;
  const backoff = Math.min(
    policy.maxBackoffMs,
    Math.max(1, Math.round(exponentialBackoff * (0.8 + jitterSample * 0.4))),
  );
  record.phase = 'backoff';
  record.backoffKind = kind;
  record.collectionDeadlineAt = 0;
  record.nextRetryAt = policy.now + backoff;
}

function updateCompletedBackoff(
  target: VmRecoverySlotLocator,
  record: VmRecoveryRotationRecord,
  policy: VmRecoveryRotationPolicy,
  unavailablePeerIds: ReadonlySet<string>,
): void {
  const scheduledEveryPeer = record.candidatePeerIds.size > 0 && [...record.candidatePeerIds]
    .every((candidatePeerId) => record.attemptedPeerIds.has(candidatePeerId)
      || unavailablePeerIds.has(candidatePeerId));
  const cleanAbsentFromEveryPeer = record.candidatePeerIds.size > 0 && [...record.candidatePeerIds]
    .every((candidatePeerId) => record.cleanAbsentPeerIds.has(candidatePeerId));
  const completedBackoffKind = cleanAbsentFromEveryPeer
    ? 'clean-absence'
    : scheduledEveryPeer
      ? 'incomplete-cycle'
      : undefined;
  if (completedBackoffKind && record.curatorRosterConfirmed) {
    if (record.phase === 'backoff') {
      // A later absence proof may upgrade the physical attempt already
      // credited below. It is the same cycle, so retain one failure epoch.
      if (completedBackoffKind === 'clean-absence') record.backoffKind = 'clean-absence';
    } else {
      enterBackoff(target, record, completedBackoffKind, policy);
    }
  }
}

/** Record one selected peer visit, whether transport started or admission failed. */
export function recordRotationPeerVisit(
  target: VmRecoverySlotLocator,
  record: VmRecoveryRotationRecord,
  peerId: string,
  expectedCandidatePeerIds: readonly string[],
  policy: VmRecoveryRotationPolicy,
  unavailablePeerIds: ReadonlySet<string>,
): boolean {
  if (!membershipMatches(record.candidatePeerIds, expectedCandidatePeerIds)
    || !record.candidatePeerIds.has(peerId)) return false;
  record.lastAttemptedPeerId = peerId;
  record.attemptedPeerIds.add(peerId);
  // Preserve fairly accumulated proof progress while other targets share the
  // bounded peer budget. A cycle expires only after this slot stops making
  // physical progress for the effective maximum.
  record.collectionDeadlineAt = policy.now + policy.maxBackoffMs;
  updateCompletedBackoff(target, record, policy, unavailablePeerIds);
  return true;
}

/** Credit absence only after revalidation has proved it for an already-recorded attempt. */
export function creditRotationCleanAbsence(
  target: VmRecoverySlotLocator,
  record: VmRecoveryRotationRecord,
  peerId: string,
  expectedCandidatePeerIds: readonly string[],
  policy: VmRecoveryRotationPolicy,
  unavailablePeerIds: ReadonlySet<string>,
): boolean {
  if (!membershipMatches(record.candidatePeerIds, expectedCandidatePeerIds)
    || !record.candidatePeerIds.has(peerId)
    || !record.attemptedPeerIds.has(peerId)) return false;
  record.cleanAbsentPeerIds.add(peerId);
  updateCompletedBackoff(target, record, policy, unavailablePeerIds);
  return true;
}

/** Finish an unavailable roster without manufacturing a physical peer attempt. */
export function settleRotationUnavailablePeers(
  target: VmRecoverySlotLocator,
  record: VmRecoveryRotationRecord,
  expectedCandidatePeerIds: readonly string[],
  policy: VmRecoveryRotationPolicy,
  unavailablePeerIds: ReadonlySet<string>,
): boolean {
  if (!membershipMatches(record.candidatePeerIds, expectedCandidatePeerIds)) return false;
  updateCompletedBackoff(target, record, policy, unavailablePeerIds);
  return true;
}
