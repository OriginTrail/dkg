interface CandidateOrderContext {
  /** Already capped curator membership, in the current uncredited rotation. */
  readonly candidatePeerIds: readonly string[];
  readonly preferredPeerId?: string;
  readonly streamPeerIds?: ReadonlySet<string>;
  readonly lastAttemptedPeerId?: string;
  readonly hasSetback: (peerId: string) => boolean;
  readonly isHeldOff: (peerId: string) => boolean;
}

/** Classify once, then retain rotation/preference order inside fixed transport tiers. */
export function orderVmRecoveryCandidates(context: CandidateOrderContext): {
  order: string[];
  heldOffPeerIds: ReadonlySet<string>;
} {
  // Preference reorders existing membership; it never admits a hinted outsider.
  const preferred = context.preferredPeerId;
  const candidates = context.candidatePeerIds.map((peerId, index) => ({
    peerId, index,
    preferred: peerId === preferred,
    stream: context.streamPeerIds?.has(peerId) === true,
    setback: context.hasSetback(peerId),
    heldOff: context.isHeldOff(peerId),
  }));
  const afterSetback = candidates.some((candidate) =>
    candidate.peerId === context.lastAttemptedPeerId && candidate.setback);
  const tier = (candidate: typeof candidates[number]): number => afterSetback
    ? candidate.setback ? 2 : candidate.stream ? 0 : 1
    : candidate.stream ? candidate.setback ? 1 : 0 : 2;
  candidates.sort((a, b) => tier(a) - tier(b)
    || Number(b.preferred) - Number(a.preferred) || a.index - b.index);
  return {
    order: candidates.map((candidate) => candidate.peerId),
    heldOffPeerIds: new Set(candidates.filter((candidate) => candidate.heldOff)
      .map((candidate) => candidate.peerId)),
  };
}
