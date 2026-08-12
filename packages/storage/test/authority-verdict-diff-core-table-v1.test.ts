import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { evaluateAgentProfileHeadAdvanceV1 } from '@origintrail-official/dkg-core/system-record-v1';

import {
  enumerateVerdictDiffCellsV1,
  type VerdictDiffCellV1,
} from './helpers/authority-verdict-diff-cells-v1.js';
import {
  resolveConstructibilityV1,
  type SourceCitationV1,
} from './helpers/authority-verdict-diff-constructibility-v1.js';
import {
  CORE_BUILDABLE_HEAD_SHAPES_V1,
  CORE_DECIDED_CELLS_V1,
  CORE_FORK_CARRYING_ACTIVE_SHAPES_V1,
  CORE_HARNESS_LIMITATIONS_V1,
  CORE_POST_RESOLVER_RETIRED_CELLS_V1,
  CORE_PROJECTIONS_V1,
  CORE_RESOLVER_CONSTRUCTIBLE_CELLS_V1,
  CORE_SEQUENCE_DEPTH_CITATIONS_V1,
  CORE_SUMMARY_ASYMMETRY_CITATIONS_V1,
  CORE_SUMMARY_MINT_OUTCOMES_V1,
  CORE_SWEEP_FINDINGS_V1,
  CORE_VERDICT_TABLE_DIGEST_V1,
  CORE_VERDICT_TABLE_V1,
  VERDICT_DIFF_COUNTERFACTUALS_V1,
} from './helpers/authority-verdict-diff-core-table-v1.js';
import {
  buildCoreAcceptedStateV1,
  buildCoreEvidenceV1,
  buildCoreSummaryIndexV1,
} from './helpers/authority-verdict-diff-core-evidence-v1.js';
import {
  buildCoreCandidateHeadV1,
  coreHeadShapeKeyV1,
  CORE_CURRENT_HEAD_V1,
} from './helpers/authority-verdict-diff-core-heads-v1.js';
import {
  runCoreSweepV1,
  type CoreProjectionRowV1,
} from './helpers/authority-verdict-diff-core-sweep-v1.js';
import {
  CORE_DELEGATED_REJECT_REASON_SITES_V1,
  CORE_QUARANTINE_REASONS_V1,
  CORE_REJECT_REASON_SITES_V1,
} from './helpers/authority-verdict-diff-fixture-v1.js';

/**
 * The core half of the verdict table, pinned.
 *
 * The suite walks ~394k cells and evaluates ~26k projections, so it carries an
 * explicit generous timeout: vitest's 5s default has already cost this lane a
 * run once, and a space-walking suite that times out says nothing about the
 * thing it was measuring.
 */
describe('authority verdict diff: core table', { timeout: 600_000 }, () => {
  function labelOf(row: CoreProjectionRowV1): string {
    const outcome = row.outcome;
    if (outcome.kind === 'decision') {
      return outcome.reason === undefined
        ? outcome.decision
        : `${outcome.decision}|${outcome.reason}`;
    }
    return outcome.kind === 'refused'
      ? `REFUSED|${outcome.ruleId}`
      : `THREW|${outcome.message}`;
  }

  /**
   * ONE SWEEP AND ONE MINT INDEX FOR THE WHOLE FILE, memoised the way the join
   * suite already memoises its own.
   *
   * These were recomputed per test -- three full sweeps and two mint-index
   * builds -- which is the same work five times over identical inputs. Measured
   * in CI at 226 seconds for this file, which is most of a lane budget spent
   * re-deriving what it already had.
   *
   * NO OBSERVATION LEAVES THE RUN. Every assertion still runs against the same
   * data it did before; only the number of times that data is computed changes.
   * A cut that dropped a driven cell would be a different thing entirely and
   * would have to name what it stopped observing.
   */
  let sweptCache: Promise<{
    split: ReturnType<typeof resolveConstructibilityV1>;
    rows: Awaited<ReturnType<typeof runCoreSweepV1>>;
  }> | undefined;
  function sweep() {
    sweptCache ??= (async () => {
      const split = resolveConstructibilityV1(enumerateVerdictDiffCellsV1());
      return { split, rows: await runCoreSweepV1(split.constructible) };
    })();
    return sweptCache;
  }

  // NO PARAMETER, because a memo that ignores its argument is a lie about what
  // it depends on. The earlier form took `constructible` and returned the first
  // cached promise regardless -- harmless while every caller passes the same
  // set, and exactly the shape that makes a later assertion silently
  // order-dependent if one ever passes a filtered one. It reads the sweep's own
  // split so there is only one set it CAN be about.
  let mintCache: Promise<Awaited<ReturnType<typeof buildCoreSummaryIndexV1>>> | undefined;
  function mintIndex() {
    mintCache ??= sweep().then(({ split }) => buildCoreSummaryIndexV1(split.constructible));
    return mintCache;
  }

  it('pins every projection verdict exactly, and the distribution that localises a move', async () => {
    const { split, rows } = await sweep();
    expect(split.constructible.length).toBe(CORE_RESOLVER_CONSTRUCTIBLE_CELLS_V1);
    expect(rows.length).toBe(CORE_PROJECTIONS_V1);

    // The digest DETECTS a change: two verdicts swapping between projections
    // with compensating counts leaves every distribution row untouched.
    const digest = createHash('sha256')
      .update(rows.map((row) => `${row.projectionKey}=>${labelOf(row)}`).sort().join('\n'))
      .digest('hex');
    expect(digest).toBe(CORE_VERDICT_TABLE_DIGEST_V1);

    // The distribution LOCALISES it: collected then asserted once, so a failure
    // names the offending verdict rather than reporting "expected true to be
    // false" from somewhere inside a 26,000-iteration loop.
    const observed: Record<string, { cells: number; projections: number }> = {};
    for (const row of rows) {
      const key = labelOf(row);
      const entry = observed[key] ?? { cells: 0, projections: 0 };
      entry.cells += row.cellCount;
      entry.projections += 1;
      observed[key] = entry;
    }
    expect(observed).toStrictEqual(CORE_VERDICT_TABLE_V1);
  });

  it('conserves: what the table decides plus what it retires is what it was given', async () => {
    const { rows } = await sweep();
    let decided = 0;
    let retired = 0;
    for (const row of rows) {
      if (row.outcome.kind === 'decision') decided += row.cellCount;
      else retired += row.cellCount;
    }
    expect(decided).toBe(CORE_DECIDED_CELLS_V1);
    expect(retired).toBe(CORE_POST_RESOLVER_RETIRED_CELLS_V1);
    // The sum is what makes per-cell coverage falsifiable: without it the table
    // stays full while covering fewer things than it claims.
    expect(decided + retired).toBe(CORE_RESOLVER_CONSTRUCTIBLE_CELLS_V1);

    // THE ONLY REFUSALS LEFT COME FROM THE HEAD LAYER. The evidence layer used to
    // retire 61,920 cells here, and it retired them on inputs a real caller could
    // assemble. Pinned as a shape rather than as prose: if any refusal id that is
    // not an axis-F one reappears, this names it instead of leaving the reader to
    // find it in a distribution that still sums.
    const refusedIds = new Set(
      rows.filter((row) => row.outcome.kind === 'refused')
        .map((row) => (row.outcome as { ruleId: string }).ruleId),
    );
    expect([...refusedIds].sort()).toStrictEqual([
      'F1-digest-equality-forces-the-current-state',
      'F2-digest-equality-forces-the-current-transition-digest',
      'F3-digest-equality-forces-the-current-fork-resolution-absence',
    ]);
  });

  it('records no verdict core did not return, and no literal the harvest cannot place', async () => {
    const { rows } = await sweep();
    const placeable = new Set([
      ...Object.keys(CORE_REJECT_REASON_SITES_V1),
      ...Object.keys(CORE_DELEGATED_REJECT_REASON_SITES_V1),
    ]);
    const quarantineReasons = new Set(Object.keys(CORE_QUARANTINE_REASONS_V1));

    const unmappedLiterals: string[] = [];
    const escaped: string[] = [];
    const unknownQuarantine: string[] = [];
    for (const row of rows) {
      const outcome = row.outcome;
      // A THROW IS NOT A VERDICT. The evaluator's contract is to return a
      // decision, so anything escaping it is a finding, never a table row.
      if (outcome.kind === 'threw') escaped.push(`${row.projectionKey}: ${outcome.message}`);
      if (outcome.kind !== 'decision') continue;
      if (outcome.decision === 'reject' && !placeable.has(outcome.reason ?? '')) {
        unmappedLiterals.push(outcome.reason ?? '<none>');
      }
      if (outcome.decision === 'quarantine' && !quarantineReasons.has(outcome.reason ?? '')) {
        unknownQuarantine.push(outcome.reason ?? '<none>');
      }
    }
    expect(escaped).toStrictEqual([]);
    // An unmapped literal is a reject that was added or reworded; the map says
    // which case to look at, which is exactly why it is cheap to triage.
    expect([...new Set(unmappedLiterals)]).toStrictEqual([]);
    expect([...new Set(unknownQuarantine)]).toStrictEqual([]);
  });

  it('mints a summary for only the head shapes core will close over, each for a stated reason', async () => {
    const split = resolveConstructibilityV1(enumerateVerdictDiffCellsV1());
    const { summaries, unresolvedArtifacts } = await mintIndex();
    const buildable = new Set(
      split.constructible
        .filter((cell) => buildCoreCandidateHeadV1(cell).built)
        .map(coreHeadShapeKeyV1),
    );
    expect(buildable.size).toBe(CORE_BUILDABLE_HEAD_SHAPES_V1);

    // Digests are normalised out of the key: they are head-content dependent, so
    // pinning them would make this row a restatement of the fixture's hashes
    // rather than of which REFUSALS the closure builder issues.
    const counts: Record<string, number> = {};
    for (const shapeKey of buildable) {
      const mint = summaries.get(shapeKey);
      const key = mint === undefined
        ? 'ABSENT'
        : mint.minted
          ? 'MINTED'
          : mint.message.replace(/0x[0-9a-f]{64}/gu, '<digest>');
      counts[key] = (counts[key] ?? 0) + 1;
    }
    expect(counts).toStrictEqual(CORE_SUMMARY_MINT_OUTCOMES_V1);
    for (const count of Object.values(counts)) expect(count).toBeGreaterThan(0);

    // NO PINNED REFUSAL MAY BE THIS HARNESS'S OWN OMISSION. A closure resolves
    // every digest a head names, so a fixture that fails to supply one receives a
    // refusal phrased exactly like a domain refusal -- and pinning it retires
    // cells on the harness's gap while every count still sums.
    //
    // THE PRIOR VERSION OF THIS GUARD KEYED ON THE STRING ONE INSTANCE HAPPENED
    // TO CARRY ('verification closure is missing'). That is a guard against a
    // MESSAGE, not against a class: reword the refusal, or reach the same gap
    // through a site that phrases it differently, and it stays green on exactly
    // the failure it was written for. The CLASS is defined by the MECHANISM --
    // whether the artifact a refusal is about is one the SYSTEM forbids or one
    // this FIXTURE never supplied -- and the mechanism is directly observable:
    // an unanswered resolve. `unresolvedArtifacts` records every lookup the
    // closure walk made that the artifact map could not answer, so the criterion
    // is "no refusal was reached through a gap", and it holds whatever any
    // message says.
    expect(unresolvedArtifacts).toStrictEqual([]);
  });

  /**
   * THE HARNESS'S OWN LIMITATIONS, RE-CHECKED RATHER THAN DECLARED.
   *
   * A relabel is only worth anything if the escape it names is real. Both entries
   * claim the system builds the object the rule appears to forbid, so both claims
   * are executed here against the objects THIS sweep builds -- which is also what
   * makes the "independent of #57" disposition checkable: F1's referent sits at
   * the current authority sequence and mints on the existing depth-2 chain, so
   * nothing about it waits on a deeper one.
   */
  it('re-checks that the escape objects its limitation register names are really built', async () => {
    const split = resolveConstructibilityV1(enumerateVerdictDiffCellsV1());
    const { summaries } = await mintIndex();
    const byShape = new Map<string, ReturnType<typeof buildCoreCandidateHeadV1>>();
    for (const cell of split.constructible) {
      const key = coreHeadShapeKeyV1(cell);
      if (!byShape.has(key)) byShape.set(key, buildCoreCandidateHeadV1(cell));
    }

    // The register must describe the rows the table actually carries. A
    // limitation whose count drifted from its row is a note about a table that
    // no longer exists.
    for (const limitation of CORE_HARNESS_LIMITATIONS_V1) {
      expect({ id: limitation.ruleId, row: CORE_VERDICT_TABLE_V1[`REFUSED|${limitation.ruleId}`] })
        .toStrictEqual({
          id: limitation.ruleId,
          row: { cells: limitation.cells, projections: limitation.projections },
        });
      // Every entry must carry at least one EXECUTED provenance, and the check
      // reads the LABEL rather than the prose. The first version of this guard
      // asserted that a paragraph contained the substring 'RUN:' and went red on
      // a rewording that lost no claim at all -- a wording-keyed guard, in the
      // commit whose subject is wording-keyed guards. It was also PROVEN VACUOUS
      // BY MUTATION: it passed on exactly the failure it existed to catch. A
      // guard that is false-positive AND vacuous at the same time is the
      // complete argument for keying on a label.
      expect({
        id: limitation.ruleId,
        executed: limitation.provenance.some((entry) => entry.kind === 'run'),
      }).toStrictEqual({ id: limitation.ruleId, executed: true });
      for (const entry of limitation.provenance) {
        expect(entry.claim.length).toBeGreaterThan(0);
        expect(entry.evidence.length).toBeGreaterThan(0);
      }
    }

    // F1's ESCAPE: a tombstone at the current head's OWN authority sequence with a
    // higher version. If this minted only at a deeper sequence, F1 really would
    // couple to #57 -- so the sequence equality is the load-bearing part of the
    // assertion, not the mint.
    const f1Escapes = [...byShape].filter(([, build]) => {
      if (!build.built) return false;
      const head = build.candidate as unknown as Record<string, string>;
      return head.state === 'tombstone'
        && head.authoritySequence === CORE_CURRENT_HEAD_V1.authoritySequence
        && BigInt(head.version) > BigInt(CORE_CURRENT_HEAD_V1.version);
    });
    const f1Minting = f1Escapes.filter(([shape]) => summaries.get(shape)?.minted === true);
    expect({ built: f1Escapes.length, minting: f1Minting.length })
      .toStrictEqual({ built: 2, minting: 1 });

    // F3's ESCAPE: an ACTIVE head carrying a fork resolution, which the codec
    // permits above version zero. Counted rather than merely found, so a fixture
    // change that stopped building them is visible.
    const f3Escapes = [...byShape].filter(([, build]) => {
      if (!build.built) return false;
      const head = build.candidate as unknown as Record<string, unknown>;
      return head.state === 'active' && head.forkResolutionDigest !== undefined;
    });
    expect(f3Escapes.length).toBe(CORE_FORK_CARRYING_ACTIVE_SHAPES_V1);

    // ...and core EVALUATES one live. "The codec builds it" would leave open that
    // the evaluator throws on it, which is not an escape at all.
    const forkShape = f3Escapes[0]?.[0];
    const forkCell = split.constructible.find((cell) => coreHeadShapeKeyV1(cell) === forkShape);
    const forkBuild = buildCoreCandidateHeadV1(forkCell as never);
    const decision = evaluateAgentProfileHeadAdvanceV1(
      buildCoreAcceptedStateV1(forkCell as never) as never,
      (forkBuild as { candidate: never }).candidate,
      buildCoreEvidenceV1(forkCell as never, summaries) as never,
    ) as { decision: string };
    expect(['accept', 'stale', 'reject', 'quarantine']).toContain(decision.decision);
  });

  it('keeps counterfactuals out of the cells and anchored to their mutation', () => {
    expect(VERDICT_DIFF_COUNTERFACTUALS_V1.length).toBeGreaterThan(0);
    for (const entry of VERDICT_DIFF_COUNTERFACTUALS_V1) {
      // Anchored means a file:line, both texts, and a proof it was applied --
      // otherwise the recorded result and "the experiment never ran" are
      // indistinguishable from the notes.
      expect(entry.site).toMatch(/^packages\/[^:]+\.ts:\d+$/u);
      expect(entry.before).not.toBe(entry.after);
      expect(entry.appliedProof.length).toBeGreaterThan(0);
      expect(entry.actualVerdict.length).toBeGreaterThan(0);

      // THE ANCHOR IS RESOLVED AGAINST THE SOURCE, NOT SHAPE-CHECKED.
      // A well-formed `file:line` naming a file that does not exist, or a line
      // that no longer holds the text the mutation moved, satisfies every
      // assertion above. The recorded experiment could therefore rot to
      // nothing while this test stayed green -- which is the species this
      // harness exists to refuse, sitting in the harness itself.
      const source = sourceOf(entry.site);
      const lineNumber = lineOf(entry.site);
      expect({ site: entry.site, resolves: lineNumber >= 1 && lineNumber <= source.length })
        .toStrictEqual({ site: entry.site, resolves: true });
      expect(source[lineNumber - 1]?.trim()).toContain(entry.before.trim());

      // AND THE APPLIED PROOF'S PREMISE IS EXECUTED RATHER THAN READ.
      // "occurrence count of the original predicate 1 -> 0" only means the
      // mutation was site-anchored if the original predicate occurs exactly
      // ONCE in that file. At two occurrences the same proof text is
      // compatible with having moved a line other than the one cited.
      const occurrences = source.filter((line) => line.includes(entry.before)).length;
      expect({ site: entry.site, occurrences })
        .toStrictEqual({ site: entry.site, occurrences: 1 });
    }
    // No counterfactual result may appear as a table verdict.
    const verdicts = new Set(Object.keys(CORE_VERDICT_TABLE_V1));
    for (const entry of VERDICT_DIFF_COUNTERFACTUALS_V1) {
      expect(verdicts.has(entry.result)).toBe(false);
    }
  });

  /**
   * THE FINDINGS' CITATIONS, RESOLVED AND REQUIRED TO DISCRIMINATE.
   *
   * A finding that names a file:line is making a checkable claim, and the check
   * has two halves. The line must still hold the text -- otherwise the citation
   * has quietly re-aimed at whatever moved into that position. And the text must
   * occur ONCE in the file, because a line-anchored citation on a string that
   * appears twice cannot say which occurrence it means. That second half is not
   * hypothetical here: the obvious anchor for the asymmetry finding
   * (next-state-v1-internal.ts:850) is a line whose text appears at :850 and
   * again at :906, in two functions about different subjects, which is precisely
   * why the finding cites :863 instead.
   */
  it('resolves every finding citation at a line that occurs exactly once', () => {
    const citations: readonly SourceCitationV1[] = [
      ...CORE_SUMMARY_ASYMMETRY_CITATIONS_V1,
      ...CORE_SEQUENCE_DEPTH_CITATIONS_V1,
    ];
    expect(citations.length).toBeGreaterThan(0);
    for (const citation of citations) {
      const source = sourceOf(citation.site);
      const lineNumber = lineOf(citation.site);
      expect({
        id: citation.id,
        onTheCitedLine: (source[lineNumber - 1] ?? '').includes(citation.contains),
      }).toStrictEqual({ id: citation.id, onTheCitedLine: true });
      const occurrences = source.filter((line) => line.includes(citation.contains)).length;
      expect({ id: citation.id, occurrences })
        .toStrictEqual({ id: citation.id, occurrences: 1 });
      expect(citation.why.length).toBeGreaterThan(0);
    }
  });

  it('carries its findings as data rather than as a commit message', () => {
    // Seven since the sequence-depth closure added the axis-G denotation
    // finding. The count is pinned rather than bounded so a finding cannot be
    // dropped silently -- a `toBeGreaterThan` here would let one disappear.
    expect(CORE_SWEEP_FINDINGS_V1.length).toBe(7);
    for (const finding of CORE_SWEEP_FINDINGS_V1) expect(finding.length).toBeGreaterThan(80);

    // REGISTER SEPARATION, ASSERTED. A harness limitation filed among the system
    // findings is read as a statement about the system, which is the error the
    // separate register exists to correct.
    const findingText = CORE_SWEEP_FINDINGS_V1.join('\n');
    for (const limitation of CORE_HARNESS_LIMITATIONS_V1) {
      expect({ id: limitation.ruleId, inFindings: findingText.includes(limitation.ruleId) })
        .toStrictEqual({ id: limitation.ruleId, inFindings: false });
    }
    expect(CORE_HARNESS_LIMITATIONS_V1.length).toBe(2);
  });
});

/** Reads the file a `path:line` citation names, relative to the repo root. */
function sourceOf(site: string): readonly string[] {
  const separator = site.lastIndexOf(':');
  return readFileSync(
    new URL(`../../../${site.slice(0, separator)}`, import.meta.url),
    'utf8',
  ).split('\n');
}

function lineOf(site: string): number {
  return Number(site.slice(site.lastIndexOf(':') + 1));
}
