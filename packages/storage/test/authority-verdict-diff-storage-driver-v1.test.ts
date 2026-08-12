import { describe, expect, it } from 'vitest';

import { createSystemRecordVerifiedReplacementRegistryV1 } from '../src/system-record-verified-replacement-v1-internal.js';
import type { VerdictDiffCellV1 } from './helpers/authority-verdict-diff-cells-v1.js';
import {
  buildCoreCandidateHeadV1,
  CORE_CURRENT_HEAD_V1,
} from './helpers/authority-verdict-diff-core-heads-v1.js';
import {
  ADMITTED_DEADLINE_MS_V1,
  buildStorageIssueV1,
  requireStorageSummaryForHeadV1,
  prepareStorageDriverV1,
  rebuildProjectionForHeadV1,
  STORAGE_LANE_BINDING_V1,
  type StorageDriveInputV1,
} from './helpers/authority-verdict-diff-storage-driver-v1.js';
import { makeSystemRecordActiveReplacementIssueV1 } from './helpers/system-record-active-replacement-fixture.js';

/**
 * THE STORAGE DRIVER'S OWN REFUSAL LADDER.
 *
 * The driver is the instrument the join's storage half is measured with, and an
 * instrument that cannot be shown to MISREAD is not proven, it is untested. Each
 * control below breaks the driver in one specific way and pins which layer
 * notices -- so a future change that quietly stops discriminating fails here,
 * beside the driver, rather than surfacing as a moved verdict in the join table
 * where it would read like a finding about the system.
 */
describe('authority verdict diff: storage driver controls', { timeout: 300_000 }, () => {
  function cell(over: Partial<VerdictDiffCellV1>): VerdictDiffCellV1 {
    return {
      id: 'control',
      snapshot: 'present',
      appliedStatus: 'active',
      candidateHeadState: 'active',
      sequenceRelation: 'equal',
      versionRelation: 'above',
      acceptedTransitionDigest: 'equal',
      storageOperation: 'active',
      coreDisposition: 'discoverable',
      evidence: [],
      candidateForkResolutionDigest: 'absent',
      clock: 'valid',
      ...over,
    } as VerdictDiffCellV1;
  }

  function headFor(source: VerdictDiffCellV1) {
    const build = buildCoreCandidateHeadV1(source);
    if (!build.built) throw new Error(`head refused: ${build.ruleId} ${build.message}`);
    return build.candidate;
  }

  /**
   * CONTROL 1 -- THE SWAPPED PROJECTION, and the ladder that says WHAT catches it.
   *
   * The genesis fixture head and every rotated head project to SIX quads and
   * SEVEN HUNDRED AND NINETY BYTES. A size check and a quad-count check
   * therefore cannot separate them; only a byte-for-byte comparison can. If the
   * driver could feed one head's projection to another, every projection-derived
   * verdict in the join would be measured against the wrong artifact while every
   * row still looked well formed.
   */
  it('C1 catches a swapped projection by BYTES, not by size or by shape', async () => {
    const candidate = headFor(cell({}));
    const rotated = rebuildProjectionForHeadV1(candidate as never);
    const genesis = makeSystemRecordActiveReplacementIssueV1(STORAGE_LANE_BINDING_V1 as never);

    // LAYER 1 -- SIZE and LAYER 2 -- SHAPE. Neither discriminates, and that is
    // the reason this control exists rather than a caveat about it.
    expect(genesis.canonicalProjectionBytes.byteLength)
      .toBe(rotated.canonicalProjectionBytes.byteLength);
    expect(genesis.projectionQuads.length).toBe(rotated.projectionQuads.length);
    // LAYER 3 -- BYTES. Discriminates.
    expect(Buffer.compare(
      Buffer.from(genesis.canonicalProjectionBytes),
      Buffer.from(rotated.canonicalProjectionBytes),
    )).not.toBe(0);

    // LAYER 0 -- THE DRIVER'S OWN GUARD. `rebuildProjectionForHeadV1` refuses to
    // hand back a projection whose commitments it cannot reproduce, so a swap
    // can only enter through the explicit control hook.
    expect(() => rebuildProjectionForHeadV1({
      ...(candidate as never as Record<string, unknown>),
      contentDigest: `0x${'11'.repeat(32)}`,
    } as never)).toThrow(/driver projection rebuild is unfaithful/u);

    // LAYER 4 -- THE SYSTEM. The owned-subject table is left CORRECT, so what is
    // isolated here is the projection alone.
    const driver = await prepareStorageDriverV1();
    const summary = await requireStorageSummaryForHeadV1(candidate);
    const honest = driver.drive({
      candidate,
      summary,
      operation: 'active',
      snapshotForm: { kind: 'present', appliedStatus: 'active' },
    });
    expect(honest).toStrictEqual({ kind: 'derivation', verdict: 'ready' });
    expect(driver.drive({
      candidate,
      summary,
      operation: 'active',
      snapshotForm: { kind: 'present', appliedStatus: 'active' },
      projectionOverride: {
        canonicalProjectionBytes: genesis.canonicalProjectionBytes,
        projectionQuads: genesis.projectionQuads as never,
        ownedSubjectTable: rotated.ownedSubjectTable,
      },
      // PIN THE REFUSAL, NOT MERELY THAT ONE HAPPENED. "differs from the honest
      // result" is satisfied by ANY failure, including an unrelated one in the
      // issue setup -- which would make this control read as projection coverage
      // while proving nothing about the projection.
    })).toStrictEqual({
      kind: 'refused',
      stage: 'issue',
      message: 'verified projection quad 0 has an unowned subject',
    });
  });

  /**
   * CONTROL 1b -- THE BYTE COMPARISON, ISOLATED.
   *
   * C1's swap moved BOTH the bytes and the quads, and the system caught it on
   * subject ownership -- a check that works only because the two heads have
   * different root subjects. This variant swaps ONLY the canonical bytes and
   * leaves the quads correct, which retires every other discriminator: the byte
   * COUNT gate passes at 790 == 790 and the subject-ownership gate passes on the
   * right quads. What remains is the assertion that compares the bytes to the
   * quads ONE BYTE AT A TIME.
   */
  it('C1b isolates the byte-for-byte compare as the only remaining discriminator', async () => {
    const candidate = headFor(cell({}));
    const rotated = rebuildProjectionForHeadV1(candidate as never);
    const genesis = makeSystemRecordActiveReplacementIssueV1(STORAGE_LANE_BINDING_V1 as never);
    const driver = await prepareStorageDriverV1();

    expect(genesis.canonicalProjectionBytes.byteLength)
      .toBe(Number((candidate as never as Record<string, string>).projectionBytes));
    expect(driver.drive({
      candidate,
      summary: await requireStorageSummaryForHeadV1(candidate),
      operation: 'active',
      snapshotForm: { kind: 'present', appliedStatus: 'active' },
      projectionOverride: {
        // WRONG bytes, RIGHT quads, RIGHT table.
        canonicalProjectionBytes: genesis.canonicalProjectionBytes,
        projectionQuads: rotated.projectionQuads,
        ownedSubjectTable: rotated.ownedSubjectTable,
      },
      // The byte-for-byte comparison names itself, which is the whole point of
      // this variant: a bare 'refused' here would also be satisfied by the
      // subject-ownership refusal C1 receives, and this control exists to prove
      // the OTHER discriminator fires once ownership is retired.
    })).toStrictEqual({
      kind: 'refused',
      stage: 'issue',
      message: 'verified projection quads do not exactly match their canonical bytes',
    });
  });

  /**
   * CONTROL 2 -- THE MIS-BOUND SUMMARY.
   *
   * The summary carries the transition lineage and root history every axis-D and
   * axis-G comparison is made against. If the driver could hand a candidate
   * someone else's summary, every authority-history verdict in the join would be
   * measured against the wrong lineage.
   */
  it('C2 catches a summary minted for a different head', async () => {
    const driver = await prepareStorageDriverV1();
    const outcome = driver.drive({
      candidate: headFor(cell({})),
      summary: driver.currentSummary,
      operation: 'active',
      snapshotForm: { kind: 'present', appliedStatus: 'active' },
    });
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' ? outcome.message : '')
      .toContain('verified authority summary');
  });

  /**
   * CONTROL 3 -- THE BINDING SHAPE.
   *
   * `consume` takes the SEVEN-key lane binding; the issue object is larger.
   * Handing it the issue object is the silent shape error, so the control fires
   * it deliberately -- and then consumes the SAME handle correctly, which is
   * what proves the refusal was the SHAPE and not a spent handle.
   */
  it('C3 catches consume() handed the issue object instead of the lane binding', async () => {
    const candidate = headFor(cell({}));
    const input: StorageDriveInputV1 = {
      candidate,
      summary: await requireStorageSummaryForHeadV1(candidate),
      operation: 'active',
      snapshotForm: { kind: 'absent' },
    };
    const issue = buildStorageIssueV1(input);
    expect(Object.keys(STORAGE_LANE_BINDING_V1)).toHaveLength(7);
    expect(Object.keys(issue).length).toBeGreaterThan(7);
    expect(ADMITTED_DEADLINE_MS_V1).toBeGreaterThan(0);

    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const handle = registry.issuer.issueCandidate(issue as never);
    expect(() => registry.consumer.consume(handle, issue as never)).toThrow();
    const facts = registry.consumer.consume(handle, STORAGE_LANE_BINDING_V1 as never);
    expect(facts.operation).toBe('active');
    registry.consumer.release(facts);
  });

  /**
   * CONTROL 4 -- THE SNAPSHOT MUST REACH THE CLASSIFIER.
   *
   * If `buildSnapshot` silently returned the absent snapshot for a present form,
   * every cell would take the absent short-circuit and the whole join table
   * would be ONE branch measured hundreds of times -- green, full, and covering
   * nothing. One candidate driven against several forms must produce results
   * that DIFFER.
   */
  it('C4 proves the snapshot form is load-bearing and the accept is not vacuous', async () => {
    const driver = await prepareStorageDriverV1();
    const above = headFor(cell({ versionRelation: 'above' }));
    const below = headFor(cell({ versionRelation: 'below' }));
    const aboveSummary = await requireStorageSummaryForHeadV1(above);
    const belowSummary = await requireStorageSummaryForHeadV1(below);
    const drive = (candidate: typeof above, summary: typeof aboveSummary, form: never) =>
      driver.drive({ candidate, summary, operation: 'active', snapshotForm: form });

    const results = {
      aboveVsAbsent: drive(above, aboveSummary, { kind: 'absent' } as never),
      aboveVsActive: drive(above, aboveSummary, { kind: 'present', appliedStatus: 'active' } as never),
      aboveVsDirty: drive(above, aboveSummary, { kind: 'present', appliedStatus: 'dirty' } as never),
      belowVsAbsent: drive(below, belowSummary, { kind: 'absent' } as never),
      belowVsActive: drive(below, belowSummary, { kind: 'present', appliedStatus: 'active' } as never),
    };
    // The discriminator must DISCRIMINATE: the same head must not answer the
    // same way to an absent row, an active row and a dirty one.
    expect(results.belowVsAbsent).not.toStrictEqual(results.belowVsActive);
    expect(results.aboveVsActive).not.toStrictEqual(results.aboveVsDirty);
    expect(new Set(Object.values(results).map((result) => JSON.stringify(result))).size)
      .toBeGreaterThanOrEqual(3);
  });

  // The referent every present-snapshot cell in the join is measured against.
  it('materialises the current head against the current row as already-applied', async () => {
    const driver = await prepareStorageDriverV1();
    expect(driver.drive({
      candidate: CORE_CURRENT_HEAD_V1,
      summary: driver.currentSummary,
      operation: 'active',
      snapshotForm: { kind: 'present', appliedStatus: 'active' },
    })).toStrictEqual({ kind: 'derivation', verdict: 'already-applied' });
  });
});
