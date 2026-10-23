import type {
  DurableManifestDigest,
  DurableManifestPrefixDigest,
  SyncCheckpointEntry,
} from '../checkpoint/state.js';

export type ManifestCheckpointDecision =
  | { readonly kind: 'keep'; readonly prefixUpgrade?: DurableManifestPrefixDigest }
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

  if (!fullGenerationMatches) {
    if (
      !input.hasExactAssetFilter
      && checkpoint.offset > 0
      && savedPrefixMatches
      && checkpoint.responderSessionOffset === checkpoint.offset
      && prefixDigestAtOffset !== undefined
    ) {
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
  return { kind: 'keep' };
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
  readonly manifestRebindNeedsPriming: boolean;
}): ResponderResumeDecision {
  const verifiedOffset = input.checkpoint?.offset ?? 0;
  if (
    input.usesPageSession
    && verifiedOffset > 0
    && input.savedResponderSessionOffset === undefined
  ) {
    return input.manifestRebindNeedsPriming
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
