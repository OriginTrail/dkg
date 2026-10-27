import { withoutSyncCheckpointResponderSession } from '@origintrail-official/dkg-core';
import type {
  DurableManifestDigest,
  DurableManifestPrefixDigest,
  SyncCheckpointEntry,
} from '../checkpoint/state.js';

export type ManifestCheckpointDecision =
  | {
      readonly kind: 'keep';
      readonly prefixUpgrade?: DurableManifestPrefixDigest;
      /** The offset is a proven boundary of this generation; a fresh responder session may be primed to it. */
      readonly primeable?: true;
    }
  | {
      readonly kind: 'rebind-and-prime';
      readonly prefixDigest: DurableManifestPrefixDigest;
    }
  | { readonly kind: 'reset' };

/** Pure generation/prefix decision for one persisted durable DATA checkpoint. */
export function resolveManifestCheckpointDecision(input: {
  readonly checkpoint?: SyncCheckpointEntry;
  readonly manifestDigest?: DurableManifestDigest;
  readonly prefixDigestAtOffset?: DurableManifestPrefixDigest;
  readonly hasExactAssetFilter: boolean;
}): ManifestCheckpointDecision {
  const { checkpoint, manifestDigest, prefixDigestAtOffset } = input;
  if (!checkpoint || !manifestDigest) return { kind: 'keep' };

  const fullGenerationMatches = checkpoint.manifestDigest === manifestDigest;
  const savedPrefixMatches = checkpoint.manifestPrefixDigest !== undefined
    && checkpoint.manifestPrefixDigest === prefixDigestAtOffset;
  const offsetHasCurrentBoundaryProof = checkpoint.offset === 0
    || prefixDigestAtOffset !== undefined;
  // The verified prefix is canonical, so a fresh responder session reaches the
  // same rows at this offset. A held token proves where its raw coordinate is;
  // without one (expired, cleared, or a prefix proven against another peer)
  // the first page after the jump must still start the next manifest graph.
  const primeableBoundary = !input.hasExactAssetFilter
    && checkpoint.offset > 0
    && savedPrefixMatches
    && (
      checkpoint.responderSessionOffset === undefined
      || checkpoint.responderSessionOffset === checkpoint.offset
    );

  if (!fullGenerationMatches) {
    if (primeableBoundary && prefixDigestAtOffset !== undefined) {
      return { kind: 'rebind-and-prime', prefixDigest: prefixDigestAtOffset };
    }
    return { kind: 'reset' };
  }
  if (!offsetHasCurrentBoundaryProof) return { kind: 'reset' };
  if (
    checkpoint.offset > 0
    && checkpoint.manifestPrefixDigest !== undefined
    && !savedPrefixMatches
  ) return { kind: 'reset' };
  if (
    checkpoint.offset > 0
    && prefixDigestAtOffset !== undefined
    && checkpoint.manifestPrefixDigest === undefined
  ) return { kind: 'keep', prefixUpgrade: prefixDigestAtOffset };
  // A terminal offset of this generation has no next graph to resume into.
  return primeableBoundary && checkpoint.terminal !== true
    ? { kind: 'keep', primeable: true }
    : { kind: 'keep' };
}

export type ResponderResumeDecision =
  | { readonly kind: 'fresh'; readonly verifiedOffset: 0; readonly rawOffset: 0 }
  | { readonly kind: 'resume'; readonly verifiedOffset: number; readonly rawOffset: number }
  | { readonly kind: 'prime'; readonly verifiedOffset: number; readonly rawOffset: number }
  | { readonly kind: 'reset-unmappable'; readonly verifiedOffset: 0; readonly rawOffset: 0 };

/** Keep verified manifest and raw responder coordinates distinct. */
export function resolveResponderResumeDecision(input: {
  readonly checkpoint?: SyncCheckpointEntry;
  readonly usesPageSession: boolean;
  readonly savedResponderSessionOffset?: number;
  readonly manifestCheckpointDecision: ManifestCheckpointDecision;
}): ResponderResumeDecision {
  const verifiedOffset = input.checkpoint?.offset ?? 0;
  if (
    input.usesPageSession
    && verifiedOffset > 0
    && input.savedResponderSessionOffset === undefined
  ) {
    const decision = input.manifestCheckpointDecision;
    return decision.kind === 'rebind-and-prime' || (decision.kind === 'keep' && decision.primeable === true)
      ? { kind: 'prime', verifiedOffset, rawOffset: verifiedOffset }
      : { kind: 'reset-unmappable', verifiedOffset: 0, rawOffset: 0 };
  }
  const rawOffset = input.savedResponderSessionOffset ?? verifiedOffset;
  if (!Number.isSafeInteger(rawOffset) || rawOffset < 0) {
    return { kind: 'reset-unmappable', verifiedOffset: 0, rawOffset: 0 };
  }
  if (verifiedOffset === 0 && rawOffset === 0) {
    return { kind: 'fresh', verifiedOffset: 0, rawOffset: 0 };
  }
  return { kind: 'resume', verifiedOffset, rawOffset };
}

export type ResponderSessionLossCleanup = 'clear-session' | 'clear-checkpoint';

export function resolveResponderSessionLossCleanup(input: {
  readonly usesPageSession: boolean;
  readonly hasExactAssetFilter: boolean;
  readonly checkpoint?: SyncCheckpointEntry;
  readonly manifestDigest?: DurableManifestDigest;
  readonly verifiedOffset: number;
  readonly rawOffset: number;
  readonly prefixDigestAtOffset?: DurableManifestPrefixDigest;
  readonly supportsSessionClear: boolean;
}): ResponderSessionLossCleanup {
  return input.usesPageSession
    && !input.hasExactAssetFilter
    && input.verifiedOffset > 0
    && input.manifestDigest !== undefined
    && input.checkpoint?.manifestDigest === input.manifestDigest
    && input.prefixDigestAtOffset !== undefined
    && input.checkpoint?.manifestPrefixDigest === input.prefixDigestAtOffset
    && input.rawOffset === input.verifiedOffset
    && input.supportsSessionClear
    ? 'clear-session'
    : 'clear-checkpoint';
}

type ManifestBoundCheckpoint = SyncCheckpointEntry & { readonly manifestDigest: DurableManifestDigest };
type CheckpointTransition =
  | { readonly checkpointAction: 'reset'; readonly checkpoint?: undefined; readonly seeded: false }
  | { readonly checkpointAction: 'keep'; readonly checkpoint?: SyncCheckpointEntry; readonly seeded: false }
  | { readonly checkpointAction: 'replace'; readonly checkpoint: ManifestBoundCheckpoint; readonly seeded: boolean }
  | { readonly checkpointAction: 'upgrade'; readonly checkpoint: ManifestBoundCheckpoint; readonly seeded: false };

/** Replacing/upgrading always carries the final manifest binding required by persistence. */
export type ManifestResumePlan = CheckpointTransition & { readonly resume: ResponderResumeDecision };

export function resolveManifestResumePlan(input: {
  readonly checkpoint?: SyncCheckpointEntry;
  /** A live, non-terminal source that advances the destination, checked without mutation. */
  readonly proposedCheckpoint?: SyncCheckpointEntry;
  readonly manifestDigest?: DurableManifestDigest;
  readonly prefixDigestAtOffset?: (offset: number) => DurableManifestPrefixDigest | undefined;
  readonly hasExactAssetFilter: boolean;
  readonly usesPageSession: boolean;
  readonly savedResponderSessionOffset?: number;
  readonly forceFreshSession?: boolean;
  readonly nowMs: number;
}): ManifestResumePlan {
  const reset = (resume: ResponderResumeDecision = { kind: 'fresh', verifiedOffset: 0, rawOffset: 0 }): ManifestResumePlan =>
    ({ checkpointAction: 'reset', seeded: false, resume });
  const finish = (transition: CheckpointTransition, decision: ManifestCheckpointDecision): ManifestResumePlan => {
    const resume = resolveResponderResumeDecision({ checkpoint: transition.checkpoint, usesPageSession: input.usesPageSession,
      savedResponderSessionOffset: transition.checkpointAction === 'replace' ? undefined : input.savedResponderSessionOffset,
      manifestCheckpointDecision: decision });
    return resume.kind === 'reset-unmappable' ? reset(resume) : { ...transition, resume };
  };
  if (input.forceFreshSession) return reset();
  const decide = (checkpoint: SyncCheckpointEntry | undefined) => resolveManifestCheckpointDecision({
    checkpoint, manifestDigest: input.manifestDigest,
    prefixDigestAtOffset: checkpoint ? input.prefixDigestAtOffset?.(checkpoint.offset) : undefined,
    hasExactAssetFilter: input.hasExactAssetFilter,
  });
  if (input.manifestDigest && !input.hasExactAssetFilter && input.proposedCheckpoint) {
    const proposed = withoutSyncCheckpointResponderSession(input.proposedCheckpoint);
    const decision = decide(proposed);
    if (decision.kind !== 'reset') return finish({ checkpointAction: 'replace', seeded: true,
      checkpoint: { ...proposed, manifestDigest: input.manifestDigest, terminal: undefined,
        manifestPrefixDigest: decision.kind === 'rebind-and-prime' ? decision.prefixDigest
          : decision.prefixUpgrade ?? proposed.manifestPrefixDigest } }, decision);
  }
  const checkpoint = input.checkpoint;
  const decision = decide(checkpoint);
  if (decision.kind === 'reset') return reset();
  if (checkpoint && input.manifestDigest) {
    const refreshed = { ...checkpoint, manifestDigest: input.manifestDigest, terminal: undefined,
      updatedAtMs: input.nowMs, expiresAtMs: input.nowMs + checkpoint.expiresAtMs - checkpoint.updatedAtMs };
    if (decision.kind === 'rebind-and-prime') return finish({ checkpointAction: 'replace', seeded: false,
      checkpoint: { ...withoutSyncCheckpointResponderSession(refreshed), manifestDigest: input.manifestDigest,
        manifestPrefixDigest: decision.prefixDigest } }, decision);
    if (decision.prefixUpgrade) return finish({ checkpointAction: 'upgrade', seeded: false,
      checkpoint: { ...refreshed, manifestPrefixDigest: decision.prefixUpgrade } }, decision);
  }
  return finish({ checkpointAction: 'keep', checkpoint, seeded: false }, decision);
}
