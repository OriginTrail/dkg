/**
 * The `perCgRequiredSignatures` gate used to short-circuit to
 * tentative as soon as ANY peer ACK had been collected, because
 * `selfSignEligible` was keyed on `v10ACKs.length === 0`. In an
 * M-of-N context graph a publish with 1 peer ACK plus the local
 * publisher's own participant ACK can still meet quorum — the old
 * gate dropped that self-sign contribution on the floor and forced
 * an unnecessary tentative result even though the on-chain contract
 * would have accepted the combined set.
 *
 * These tests pin the new semantic of `computePerCgQuorumState`
 * (extracted from the `publish()` body precisely so the quorum math
 * can be asserted without standing up Hardhat):
 *
 *   - selfSignEligible iff publisher identity NOT already present;
 *   - effectiveAckCount = collected + (selfSignEligible ? 1 : 0);
 *   - perCgQuorumUnmet iff perCgRequired > 0 AND effective < required;
 *   - double-count defence: if publisher ACK is already in the
 *     collected set, self-sign eligibility is FALSE (dedupe by id).
 */
import { describe, it, expect } from 'vitest';
import { computePerCgQuorumState } from '../src/dkg-publisher.js';

const PUBLISHER_ID = 101n;
const PEER_A = 201n;
const PEER_B = 202n;

function baseInputs(overrides: Partial<Parameters<typeof computePerCgQuorumState>[0]> = {}) {
  return {
    perCgRequiredSignatures: undefined,
    collectedAcks: undefined as
      | ReadonlyArray<{ readonly nodeIdentityId: bigint }>
      | undefined,
    publisherWalletReady: true,
    publisherNodeIdentityId: PUBLISHER_ID,
    v10ChainReady: true,
    ...overrides,
  };
}

describe('computePerCgQuorumState', () => {
  it('single-node baseline: no peer ACKs, self-sign is the ONE ACK, meets required=1', () => {
    const s = computePerCgQuorumState(baseInputs({ perCgRequiredSignatures: 1 }));
    expect(s.collectedAckCount).toBe(0);
    expect(s.selfSignEligible).toBe(true);
    expect(s.publisherAlreadyAcked).toBe(false);
    expect(s.effectiveAckCount).toBe(1);
    expect(s.perCgQuorumUnmet).toBe(false);
  });

  // r11-1 regression core: 1 peer ACK + self-sign must clear required=2.
  it('M-of-N (required=2): 1 peer ACK + self-sign counts toward quorum and clears', () => {
    const s = computePerCgQuorumState(
      baseInputs({
        perCgRequiredSignatures: 2,
        collectedAcks: [{ nodeIdentityId: PEER_A }],
      }),
    );
    expect(s.collectedAckCount).toBe(1);
    expect(s.selfSignEligible).toBe(true);
    expect(s.effectiveAckCount).toBe(2);
    expect(s.perCgQuorumUnmet).toBe(false);
  });

  it('M-of-N (required=3): 1 peer ACK + self-sign still short — stays tentative', () => {
    const s = computePerCgQuorumState(
      baseInputs({
        perCgRequiredSignatures: 3,
        collectedAcks: [{ nodeIdentityId: PEER_A }],
      }),
    );
    expect(s.effectiveAckCount).toBe(2);
    expect(s.perCgQuorumUnmet).toBe(true);
  });

  it('M-of-N (required=2): 2 peer ACKs already enough, self-sign still adds exactly one more', () => {
    const s = computePerCgQuorumState(
      baseInputs({
        perCgRequiredSignatures: 2,
        collectedAcks: [{ nodeIdentityId: PEER_A }, { nodeIdentityId: PEER_B }],
      }),
    );
    expect(s.collectedAckCount).toBe(2);
    expect(s.selfSignEligible).toBe(true);
    expect(s.effectiveAckCount).toBe(3);
    expect(s.perCgQuorumUnmet).toBe(false);
  });

  // Double-count defence: publisher identity is ALREADY in collected
  // set — self-sign eligibility flips off so we don't dedupe-adjust
  // the count twice.
  it('publisher ACK already present in v10ACKs → selfSignEligible=false (dedupe)', () => {
    const s = computePerCgQuorumState(
      baseInputs({
        perCgRequiredSignatures: 1,
        collectedAcks: [{ nodeIdentityId: PUBLISHER_ID }],
      }),
    );
    expect(s.publisherAlreadyAcked).toBe(true);
    expect(s.selfSignEligible).toBe(false);
    expect(s.effectiveAckCount).toBe(1);
    expect(s.perCgQuorumUnmet).toBe(false);
  });

  it('no publisher identity (0n) → selfSignEligible=false regardless of collected set', () => {
    const s = computePerCgQuorumState(
      baseInputs({
        perCgRequiredSignatures: 1,
        collectedAcks: undefined,
        publisherNodeIdentityId: 0n,
      }),
    );
    expect(s.selfSignEligible).toBe(false);
    expect(s.effectiveAckCount).toBe(0);
    expect(s.perCgQuorumUnmet).toBe(true);
  });

  it('no wallet ready → selfSignEligible=false', () => {
    const s = computePerCgQuorumState(
      baseInputs({
        perCgRequiredSignatures: 1,
        publisherWalletReady: false,
      }),
    );
    expect(s.selfSignEligible).toBe(false);
    expect(s.effectiveAckCount).toBe(0);
    expect(s.perCgQuorumUnmet).toBe(true);
  });

  it('no V10 chain context → selfSignEligible=false (would emit digest against nothing)', () => {
    const s = computePerCgQuorumState(
      baseInputs({
        perCgRequiredSignatures: 1,
        v10ChainReady: false,
      }),
    );
    expect(s.selfSignEligible).toBe(false);
    expect(s.perCgQuorumUnmet).toBe(true);
  });

  it('perCgRequired=0 means "no explicit gate" → quorumUnmet always false', () => {
    const s = computePerCgQuorumState(
      baseInputs({
        perCgRequiredSignatures: 0,
        collectedAcks: undefined,
      }),
    );
    expect(s.perCgQuorumUnmet).toBe(false);
  });

  // behaviour guard: the OLD gate would have reported
  // effectiveAckCount === 1 here (because `selfSignEligible` was
  // keyed on `collectedAckCount === 0`). Asserting effective=2
  // explicitly ensures we notice if the broadened eligibility
  // regresses back to the narrower form.
  it('regression floor: 1 peer ACK + publisher ready → effectiveAckCount MUST be 2', () => {
    const s = computePerCgQuorumState(
      baseInputs({
        collectedAcks: [{ nodeIdentityId: PEER_A }],
      }),
    );
    expect(s.effectiveAckCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// selfSignEligible must
// also gate on actual CG participation. Counting a self-sign that the V10
// contract would reject as `InvalidSignerNotParticipant` silently turned
// every non-participant publish into a guaranteed reverted on-chain tx
// AND incorrectly cleared the local quorum gate.
// ---------------------------------------------------------------------------
describe('computePerCgQuorumState — r21-6 CG participation gate', () => {
  it('chain says publisher IS a participant → self-sign counts (no behavioural change)', () => {
    const s = computePerCgQuorumState(
      baseInputs({
        perCgRequiredSignatures: 1,
        publisherIsCgParticipant: true,
      }),
    );
    expect(s.selfSignEligible).toBe(true);
    expect(s.effectiveAckCount).toBe(1);
    expect(s.perCgQuorumUnmet).toBe(false);
  });

  it('chain says publisher is NOT a participant → self-sign denied even if every other condition is met', () => {
    const s = computePerCgQuorumState(
      baseInputs({
        perCgRequiredSignatures: 1,
        publisherIsCgParticipant: false,
      }),
    );
    expect(s.selfSignEligible).toBe(false);
    expect(s.effectiveAckCount).toBe(0);
    expect(s.perCgQuorumUnmet).toBe(true);
  });

  it('non-participant publisher with one peer ACK STILL fails M-of-N (the bot finding)', () => {
    // Pre-r21-6: this returned effective=2 (peer + bogus self-sign),
    // perCgQuorumUnmet=false. The publisher would build a tx with
    // 2 sigs, the V10 contract would reject the publisher signature
    // as non-participant, and the publish would revert on-chain
    // even though the local quorum gate said "ready".
    const s = computePerCgQuorumState(
      baseInputs({
        perCgRequiredSignatures: 2,
        collectedAcks: [{ nodeIdentityId: PEER_A }],
        publisherIsCgParticipant: false,
      }),
    );
    expect(s.selfSignEligible).toBe(false);
    expect(s.effectiveAckCount).toBe(1);
    expect(s.perCgQuorumUnmet).toBe(true);
  });

  it('participant set unknown (undefined) → preserves historical lenient path', () => {
    // Adapters that don't expose a CG registry (basic mocks,
    // descriptive-name SWM domains that resolve to v10CgId=0n) MUST
    // still let the publish exercise the data-flow path; the V10
    // contract is the final authority on participation.
    const s = computePerCgQuorumState(
      baseInputs({
        perCgRequiredSignatures: 1,
        publisherIsCgParticipant: undefined,
      }),
    );
    expect(s.selfSignEligible).toBe(true);
    expect(s.effectiveAckCount).toBe(1);
    expect(s.perCgQuorumUnmet).toBe(false);
  });

  it('non-participant + already-ACKed publisher: dedupe still wins (selfSignEligible=false either way)', () => {
    const s = computePerCgQuorumState(
      baseInputs({
        perCgRequiredSignatures: 1,
        collectedAcks: [{ nodeIdentityId: PUBLISHER_ID }],
        publisherIsCgParticipant: false,
      }),
    );
    expect(s.publisherAlreadyAcked).toBe(true);
    expect(s.selfSignEligible).toBe(false);
    expect(s.effectiveAckCount).toBe(1);
    expect(s.perCgQuorumUnmet).toBe(false);
  });
});
