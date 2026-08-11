import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  buildAgentProfileVerificationClosureV1,
  canonicalizeOwnedSubjectTableObjectV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  computeAgentProfileHeadObjectDigestV1,
  evaluateAgentProfileHeadAdvanceV1,
  type SignedAgentProfileHeadEnvelopeV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import { readCitedSourceLineV1 } from './helpers/authority-verdict-diff-constructibility-v1.js';
import { makeAuthenticTerminalReplacementFixtureV1 } from './helpers/system-record-terminal-replacement-fixture.js';

/**
 * THE DRIVER THE AXIS-G DEMOTION OWES.
 *
 * Gating axis G on snapshot presence demoted the candidate-vs-predecessor
 * acceptedTransitionDigest relation from an AXIS to a FIXTURE OBLIGATION. A
 * demotion can SHADOW a refusal the same way a new guard can: the pin
 * arithmetic reconciles perfectly while the coverage that was driving the
 * refusal quietly falls, and nothing goes red. So the ruling attached a driver
 * obligation -- the obligation must ship with BOTH a correctly-bound and a
 * mis-bound predecessor, the mis-bound one SHOWN REFUSED -- and this is it.
 *
 * DISCHARGING IT MOVED THE REFUSAL'S ADDRESS, which is the finding. The mis-bound
 * predecessor is refused, but NOT where the ruling expected. It never reaches
 * core's evaluator at all.
 */

interface Vectors {
  readonly signed: { readonly activeEip191: { readonly envelope: SignedAgentProfileHeadEnvelopeV1 } };
}

const vectors = JSON.parse(readFileSync(new URL(
  '../../core/test/fixtures/system-record-v1/vectors.json',
  import.meta.url,
), 'utf8')) as Vectors;

const REPO_ROOT = new URL('../../../', import.meta.url);

/** The fixture's own closure clock; its tombstone is issued at 12:11:00Z. */
const NOW_MS = Date.parse('2026-08-05T12:12:00Z');

/**
 * The absent-snapshot accepted state. `current` is omitted rather than set to
 * undefined: snapshotAcceptedAuthorityStateV1 is an exact-record check, and a
 * non-discoverable disposition or a non-empty lineage would divert to :219's
 * reject before the tombstone branch is ever reached.
 */
const ABSENT_ACCEPTED = {
  disposition: 'discoverable' as const,
  transitionLineage: [],
  historicalRoots: [],
};

function headEnvelopeV1(object: unknown): SignedAgentProfileHeadEnvelopeV1 {
  return {
    ...structuredClone(vectors.signed.activeEip191.envelope),
    object,
    objectDigest: computeAgentProfileHeadObjectDigestV1(object as never),
  } as unknown as SignedAgentProfileHeadEnvelopeV1;
}

/**
 * Mints a tombstone-rooted closure over an arbitrary (tombstone, predecessor)
 * pair, so the pair itself is the variable under test rather than something the
 * shared fixture fixes. The owned-subject table is keyed on the PREDECESSOR's
 * digest, not the tombstone's -- a tombstone commits the canonical EMPTY table,
 * and the deletion proof is about what the predecessor owned.
 */
async function mintTombstoneClosureV1(
  tombstone: Record<string, unknown>,
  predecessor: Record<string, unknown>,
  ownedSubjectTable: readonly string[],
) {
  const tombstoneEnvelope = headEnvelopeV1(tombstone);
  const predecessorEnvelope = headEnvelopeV1(predecessor);
  const artifacts = new Map<string, unknown>([
    [`agent-profile-head:${tombstoneEnvelope.objectDigest}`, {
      objectKind: 'agent-profile-head',
      digest: tombstoneEnvelope.objectDigest,
      canonicalBytes: canonicalizeSignedSystemRecordEnvelopeV1(tombstoneEnvelope),
    }],
    [`agent-profile-head:${predecessorEnvelope.objectDigest}`, {
      objectKind: 'agent-profile-head',
      digest: predecessorEnvelope.objectDigest,
      canonicalBytes: canonicalizeSignedSystemRecordEnvelopeV1(predecessorEnvelope),
    }],
    [`owned-subject-table:${predecessor.ownedSubjectTableDigest as string}`, {
      objectKind: 'owned-subject-table',
      digest: predecessor.ownedSubjectTableDigest,
      canonicalBytes: canonicalizeOwnedSubjectTableObjectV1(
        predecessor.rootSubject as never,
        ownedSubjectTable as never,
      ),
    }],
  ]);
  return buildAgentProfileVerificationClosureV1(tombstoneEnvelope.objectDigest as never, {
    nowMs: NOW_MS,
    resolve: async (reference) =>
      artifacts.get(`${reference.objectKind}:${reference.digest}`) as never,
    verifyAuthorityEnvelope: () => true,
    verifyCurrentBundle: () => {
      throw new Error('a tombstone closure must not request a predecessor projection');
    },
  });
}

describe('absent-path tombstone evidence binding', () => {
  // THE POSITIVE CONTROL, and it is not optional. Without it the refusal below
  // is equally consistent with a closure builder that refuses every pair -- in
  // which case the "obligation" would be discharged by a fixture defect, and the
  // demoted axis would look covered while nothing was being exercised.
  it('mints and accepts a correctly-bound tombstone predecessor', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1();
    const closure = await mintTombstoneClosureV1(
      fixture.tombstone.head as unknown as Record<string, unknown>,
      fixture.active.head as unknown as Record<string, unknown>,
      fixture.active.ownedSubjectTable as unknown as readonly string[],
    );

    // The minted summary really does carry the deletion proof the absent path
    // consumes -- otherwise `accept` below could be reached without it.
    expect(closure.authoritySummary.tombstonePredecessor).toBeDefined();
    expect(closure.authoritySummary.deletionTableDigest)
      .toBe(fixture.active.head.ownedSubjectTableDigest);

    expect(evaluateAgentProfileHeadAdvanceV1(
      ABSENT_ACCEPTED,
      fixture.tombstone.head,
      { nowMs: NOW_MS, verifiedAuthoritySummary: closure.authoritySummary },
    )).toEqual({ decision: 'accept' });
  });

  // THE MIS-BOUND ARM. `projectionSchemaDigest` is the discriminator because it
  // is one of the ten fields isTombstoneBoundToPredecessorV1 compares AND it is
  // structurally free: perturbing it leaves a predecessor that still mints on its
  // own, so the refusal that fires is the BINDING check rather than a codec
  // complaint about the perturbed head. That is not a preference -- the other
  // compared fields were tried and each is refused earlier by a different layer
  // (evmIssuer and rootSubject by the agent-root/EVM-issuer binding, networkId by
  // the seal UAL network binding, peerId by the peerPublicKey derivation, version
  // by the noninitial-head history requirement), so none of them isolates this
  // predicate.
  it('refuses a predecessor mis-bound on a compared field', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1();
    const predecessor = {
      ...(fixture.active.head as unknown as Record<string, unknown>),
      projectionSchemaDigest: `0x${'11'.repeat(32)}`,
    };
    const tombstone = {
      ...(fixture.tombstone.head as unknown as Record<string, unknown>),
      previousHeadDigest: computeAgentProfileHeadObjectDigestV1(predecessor as never),
    };

    await expect(mintTombstoneClosureV1(
      tombstone,
      predecessor,
      fixture.active.ownedSubjectTable as unknown as readonly string[],
    )).rejects.toThrow('tombstone predecessor is not the exact prior active authority state');
  });

  /**
   * THE FINDING, PINNED RATHER THAN NARRATED.
   *
   * The mis-bound predecessor is refused at the CLOSURE BUILDER, not at core's
   * evaluator -- and both sites call THE SAME PREDICATE on the same operands.
   * The closure walk checks every parsed tombstone head against the predecessor
   * its own previousHeadDigest resolves to; the evaluator re-checks the root head
   * against summary.tombstonePredecessor, which the minter derived from exactly
   * that lookup. Since a verified authority summary is a WeakSet-guarded,
   * factory-only capability that cannot be forged, spread or cloned, the
   * evaluator's conjunct cannot observe a pair the closure builder did not
   * already accept.
   *
   * So core's `:254` conjunct is UNREACHABLE-BY-CONSTRUCTION, and the reject at
   * `:259` has no producer -- which is why no test anywhere in the repo emits
   * 'cold tombstone closure lacks its exact deletion predecessor'.
   *
   * This is compared by OPERANDS AND WINDOW, not by field name, because
   * same-fields-different-operands is exactly how a subsumption claim goes wrong:
   * the operands coincide (the summary's candidateHeadDigest gate at :234 forces
   * the evaluator's candidate to BE the closure root), and the window is closed
   * by the summary being frozen at mint.
   *
   * It is pinned as two line-anchored citations rather than prose so the claim
   * fails loudly if either call moves. A comment saying this would rot silently.
   */
  it('pins the same binding predicate at both the minting and evaluating sites', () => {
    expect(readCitedSourceLineV1(
      'packages/core/src/system-record-verification-closure-v1-internal.ts:591',
      REPO_ROOT,
    )).toContain('isTombstoneBoundToPredecessorV1(head, predecessor)');

    expect(readCitedSourceLineV1(
      'packages/core/src/system-record-authority-v1-internal.ts:254',
      REPO_ROOT,
    )).toContain('isTombstoneBoundToPredecessorV1(candidateState, predecessor)');

    expect(readCitedSourceLineV1(
      'packages/core/src/system-record-verification-closure-v1-internal.ts:595',
      REPO_ROOT,
    )).toContain('tombstone predecessor is not the exact prior active authority state');
  });
});
