import { readFileSync } from 'node:fs';

import type { VerdictDiffCellV1 } from './authority-verdict-diff-cells-v1.js';

/**
 * Static constructibility resolution for the verdict-diff cell space.
 *
 * A cell is UNCONSTRUCTIBLE when no fixture can build its inputs -- distinct
 * from a cell whose inputs build fine and whose evaluator returns a refusal.
 * The second is a verdict and belongs in the table; only the first is retired
 * here.
 *
 * THE STRUCTURE IS THE POINT. Every rule carries the site that refuses the
 * state and the exact failure string that site emits. A statically-resolved
 * cell without a named refusal would make this a silent drop channel: the sweep
 * would shrink and the coverage claim would still read as complete. The rule
 * shape makes that impossible to express -- there is nowhere to put a cell
 * without also saying what refuses it.
 *
 * Rules are added only once their refusal has been READ AT THE SITE. A rule
 * derived from reasoning about what "should" be refused is the
 * specify-without-measuring trap wearing a resolver's clothes.
 */
export interface ConstructibilityRuleV1 {
  /** Stable id so a cell's retirement can be traced to one rule. */
  readonly id: string;
  /** file:line of the refusal, so the claim is checkable. */
  readonly site: string;
  /** The exact string that site emits, quoted from source. */
  readonly failure: string;
  /** Why this axis combination reaches that refusal. */
  readonly because: string;
  readonly refuses: (cell: VerdictDiffCellV1) => boolean;
}

/** Reads the exact source line a `file:line` citation names (1-based). */
export function readCitedSourceLineV1(site: string, base: URL): string {
  const [path, line] = site.split(':');
  const source = readFileSync(new URL(`${path}`, base), 'utf8');
  return source.split('\n')[Number(line) - 1] ?? '';
}

/**
 * A source citation this harness makes as a load-bearing claim, in the one
 * shape every citation uses.
 *
 * The manifest exists so citations have a single mechanism rather than a
 * structured form in the rule tables and hand-rolled `file:line` strings
 * wherever a test happens to need one. Two mechanisms for one contract is
 * worse than either, because only one of them gets maintained.
 *
 * THE LINE ANCHOR IS DELIBERATE AND IS NOT A COST TO BE OPTIMISED AWAY. The
 * weaker file-contains form is what this harness used until a rule cited :273 --
 * a closing brace -- while its failure string sat on :272, and the assertion
 * stayed green because "the file contains this string" is true for any line
 * number at all. The pin whose whole job was keeping citations followable was
 * green on an unfollowable one.
 *
 * The accepted consequence: a behaviour-preserving refactor that inserts a line
 * above a cited call turns this suite red. That is the intended trade. These
 * citations exist so a reader can follow them to a specific line to check an
 * architectural finding, and a citation that survives its target moving has
 * stopped tracking the thing it cites.
 */
export interface SourceCitationV1 {
  readonly id: string;
  /** file:line, relative to the repo root. */
  readonly site: string;
  /** A substring the cited LINE must contain. */
  readonly contains: string;
  /** The claim this citation supports, so a broken one can be re-aimed. */
  readonly why: string;
}

/**
 * THE SAME-PREDICATE FINDING, pinned rather than narrated.
 *
 * A mis-bound tombstone predecessor is refused at the CLOSURE BUILDER, not at
 * core's evaluator -- and both sites call the SAME predicate on the same
 * operands. The closure walk checks every parsed tombstone head against the
 * predecessor its own `previousHeadDigest` resolves to; the evaluator re-checks
 * the root head against `summary.tombstonePredecessor`, which the minter derived
 * from exactly that lookup. A verified authority summary is a WeakSet-guarded,
 * factory-only capability that cannot be forged, spread or cloned, so the
 * evaluator's conjunct cannot observe a pair the closure builder did not already
 * accept.
 *
 * Compared by OPERANDS AND WINDOW rather than by field name, because
 * same-fields-different-operands is exactly how a subsumption claim goes wrong:
 * here the operands genuinely coincide (the summary's `candidateHeadDigest` gate
 * forces the evaluator's candidate to BE the closure root) and the window is
 * closed by the summary being frozen at mint.
 *
 * So core's `:254` conjunct is UNREACHABLE-BY-CONSTRUCTION and the reject at
 * `:259` has no producer -- which is why nothing in the repo emits 'cold
 * tombstone closure lacks its exact deletion predecessor'. A comment saying this
 * would rot silently; these fail loudly.
 */
export const SAME_PREDICATE_CITATIONS_V1: readonly SourceCitationV1[] = [
  {
    id: 'closure-builder-binding-call',
    site: 'packages/core/src/system-record-verification-closure-v1-internal.ts:591',
    contains: 'isTombstoneBoundToPredecessorV1(head, predecessor)',
    why: 'The minting site: the closure walk applies the binding predicate itself.',
  },
  {
    id: 'evaluator-binding-call',
    site: 'packages/core/src/system-record-authority-v1-internal.ts:529',
    contains: 'isTombstoneBoundToPredecessorV1(candidateState, predecessor)',
    why: 'The evaluating site: the same predicate, same operands, later window. '
      + 'THE TEXT IS NO LONGER UNIQUE -- the same call now stands at three sites '
      + '(this absent-path check, the late-tombstone rule and the same-sequence '
      + 'tombstone rule), which is this register\'s own point rather than a defect: '
      + 'one predicate, several windows. The LINE is what disambiguates them, so a '
      + 're-pin must follow this site rather than resolve the text -- and this '
      + 'entry was re-resolved by following the site, because two of the three '
      + 'still carry this text verbatim and matching would have picked whichever '
      + 'came first. The third now reads `tombstonePredecessor`: the same-sequence '
      + 'rule takes its predecessor as an explicit operand instead of reading one '
      + 'out of an evidence object.',
  },
  {
    id: 'closure-builder-refusal',
    site: 'packages/core/src/system-record-verification-closure-v1-internal.ts:595',
    contains: 'tombstone predecessor is not the exact prior active authority state',
    why: 'The refusal a mis-bound pair actually receives, quoted from its site.',
  },
];

/**
 * WHICH CANDIDATE-HEAD FIELD EACH AXIS PINS, AND HOW TIGHTLY.
 *
 * This is the table that decides whether a codec refusal becomes a
 * constructibility RULE or stays a fixture obligation, and it exists because
 * the two are indistinguishable by eye. A refusal is a rule only when an axis
 * pins the field it binds to an ABSOLUTE value, because only then is some cell
 * forced onto the refused value with no fixture free to avoid it.
 *
 * A RELATIVE axis constrains the candidate against a referent the fixture also
 * builds. The builder satisfies it by moving the referent, so it forces an
 * absolute value only where the referent's own range is closed -- which is a
 * claim about the referent, and is proved by construction rather than assumed
 * (see the referent-freedom control in the codec-refusal test).
 *
 * Axes A, B, H, I and J are absent from this map: none of them names a field of
 * the candidate head at all.
 */
export const AXIS_CANDIDATE_HEAD_BINDING_V1 = {
  C_candidateHeadState: { field: 'state', binds: 'absolute' },
  D_sequenceRelation: { field: 'authoritySequence', binds: 'relative' },
  E_versionRelation: { field: 'version', binds: 'relative' },
  F_headDigest: { field: '*', binds: 'relative' },
  G_acceptedTransitionDigest: { field: 'acceptedTransitionDigest', binds: 'relative' },
  K_candidateForkResolutionDigest: { field: 'forkResolutionDigest', binds: 'absolute' },
  L_clock: { field: 'issuedAt', binds: 'relative' },
} as const;

export interface CodecRefusalV1 {
  /** file:line of the `fail(...)` call, so the citation lands on the refusal. */
  readonly site: string;
  /** The exact string that site emits, quoted from source. */
  readonly failure: string;
  /** The candidate-head fields the refusal reads. */
  readonly binds: readonly string[];
  /** Derived from AXIS_CANDIDATE_HEAD_BINDING_V1, never asserted by hand. */
  readonly disposition: 'constructibility-rule' | 'fixture-obligation';
  /** Set exactly when disposition is 'constructibility-rule'. */
  readonly ruleId?: string;
  readonly note: string;
}

/**
 * THE HEAD CODEC'S TOMBSTONE BRANCH HAS FOUR REFUSALS, NOT ONE.
 *
 * R1 came out of this branch, and recording only R1 would leave the next reader
 * to assume the branch had been swept. Three of the four bind fields no axis
 * names, so they refuse no cell and are the fixture builder's obligations --
 * but that is a MEASURED disposition, not a reading: every entry below was
 * fired at the site and its message captured (see the codec-refusal test).
 *
 * ONE OF THEM IS SHADOWED, which is why "read it at the site" is not the whole
 * job. `:269` cannot be reached by either natural mutation -- setting version
 * to zero trips :200 first, and dropping previousHeadDigest trips :206 first.
 * Only a version-zero tombstone carrying NO history digests at all reaches it.
 * A rule cited against a site that a fixture cannot actually drive would look
 * exactly as principled as a real one.
 */
export const TOMBSTONE_BRANCH_REFUSALS_V1: readonly CodecRefusalV1[] = [
  {
    site: 'packages/core/src/system-record-agent-profile-head-codec-v1-internal.ts:269',
    failure: 'tombstone must name an accepted active predecessor',
    binds: ['version', 'previousHeadDigest'],
    disposition: 'fixture-obligation',
    note:
      'Axis E relates the candidate version to the current head\'s, and an active '
      + 'current mints at version 2, so the builder honours below/equal/above with '
      + 'candidate versions 1/2/3 and never has to reach zero. previousHeadDigest is '
      + 'named by no axis. SHADOWED: reachable only via a version-zero tombstone '
      + 'carrying no history digests at all.',
  },
  {
    site: 'packages/core/src/system-record-agent-profile-head-codec-v1-internal.ts:272',
    failure: 'V1 has no direct terminal fork-resolution tombstone',
    binds: ['forkResolutionDigest'],
    disposition: 'constructibility-rule',
    ruleId: 'R1-tombstone-carries-fork-resolution',
    note:
      'Axis K pins forkResolutionDigest presence ABSOLUTELY and axis C pins state '
      + 'absolutely, so the cells where both are set are forced onto this refusal '
      + 'with no fixture free to avoid it. That is what makes this one a rule.',
  },
  {
    site: 'packages/core/src/system-record-agent-profile-head-codec-v1-internal.ts:275',
    failure: 'tombstone projection accounting must be zero',
    binds: ['ownedSubjectCount', 'projectionBytes', 'projectionQuads'],
    disposition: 'fixture-obligation',
    note: 'No axis names any projection count; the builder zeroes all three.',
  },
  {
    site: 'packages/core/src/system-record-agent-profile-head-codec-v1-internal.ts:278',
    failure: 'tombstone must commit the canonical empty subject table',
    binds: ['ownedSubjectTableDigest'],
    disposition: 'fixture-obligation',
    note: 'No axis names the subject-table digest; the builder commits the empty one.',
  },
];

export const CONSTRUCTIBILITY_RULES_V1: readonly ConstructibilityRuleV1[] = [
  {
    id: 'R1-tombstone-carries-fork-resolution',
    site: 'packages/core/src/system-record-agent-profile-head-codec-v1-internal.ts:272',
    failure: 'V1 has no direct terminal fork-resolution tombstone',
    because:
      'The head codec\'s tombstone branch refuses any head carrying '
      + 'forkResolutionDigest, so a tombstone candidate with that key present '
      + 'cannot be built at all -- neither evaluator ever sees the input.',
    refuses: (cell) =>
      cell.candidateHeadState === 'tombstone'
      && cell.candidateForkResolutionDigest === 'present',
  },
  // R2-R4 come from the OTHER construction surface. The harness drives storage
  // through the exported derivation, whose facts must first be issued by the
  // verified-replacement registry -- and that registry refuses three of the six
  // (storage operation x candidate head state) combinations outright. Both axes
  // are pinned absolutely, so these cells are forced onto the refusal with no
  // fixture free to avoid them.
  //
  // ORDER IS NOT ARBITRARY: rules are listed in the order the refusals actually
  // FIRE. issueActive validates the head at :637 BEFORE testing its state at
  // :641, so a tombstone candidate carrying a fork resolution really does hit
  // the codec first -- which is why R1 stays ahead of R2/R3 and owns those
  // cells. The consequence to read carefully: R2 and R3 retire the
  // K='absent' remainder, not their full (operation, state) territory.
  {
    id: 'R2-active-operation-needs-active-head',
    site: 'packages/storage/src/system-record-verified-replacement-v1-internal.ts:641',
    failure: 'verified replacement head must be active',
    because:
      'issueCandidate routes operation \'active\' straight to issueActive (:747), '
      + 'which refuses any head whose state is not active. A tombstone candidate '
      + 'can never be issued as an active replacement.',
    refuses: (cell) =>
      cell.storageOperation === 'active' && cell.candidateHeadState === 'tombstone',
  },
  {
    id: 'R3-quarantine-operation-needs-active-head',
    site: 'packages/storage/src/system-record-verified-replacement-v1-internal.ts:641',
    failure: 'verified replacement head must be active',
    because:
      'The quarantine branch does NOT validate its own head -- it delegates to '
      + 'issuer.issueActive at :757 and only then promotes the facts to '
      + '\'quarantine\'. So quarantine inherits the active-head requirement whole, '
      + 'and a tombstone can no more be quarantined than made active. Kept apart '
      + 'from R2 because the route differs: same refusal, reached by delegation.',
    refuses: (cell) =>
      cell.storageOperation === 'quarantine' && cell.candidateHeadState === 'tombstone',
  },
  {
    id: 'R4-tombstone-operation-needs-tombstone-head',
    site: 'packages/storage/src/system-record-verified-replacement-v1-internal.ts:833',
    failure: 'verified tombstone replacement head must be tombstone',
    because:
      'The tombstone branch is issueCandidate\'s fall-through (:822 onward) and '
      + 'refuses any head whose state is not tombstone. Unlike R2/R3 this rule '
      + 'retires BOTH fork-resolution values, because the head codec permits an '
      + 'ACTIVE head to carry forkResolutionDigest -- R1 is a tombstone-only '
      + 'refusal, so nothing retires these cells ahead of it. QUALIFIED BY THE '
      + 'FIRING: that permission holds only ABOVE version zero, since :200 '
      + 'refuses history digests on an ordinary initial head. Axis E is relative, '
      + 'so the fixture moves the version and the cells stay constructible; had E '
      + 'been absolute this half would have been unconstructible, owned by the '
      + 'codec rather than by this rule.',
    refuses: (cell) =>
      cell.storageOperation === 'tombstone' && cell.candidateHeadState === 'active',
  },
];

export interface ConstructibilitySplitV1 {
  readonly total: number;
  readonly constructible: readonly VerdictDiffCellV1[];
  /** Every retired cell paired with the rule that retired it. */
  readonly unconstructible: readonly {
    readonly cell: VerdictDiffCellV1;
    readonly ruleId: string;
  }[];
  /** Retirement counts per rule, so an over-matching rule is visible. */
  readonly byRule: Readonly<Record<string, number>>;
}

export function resolveConstructibilityV1(
  cells: readonly VerdictDiffCellV1[],
): ConstructibilitySplitV1 {
  const constructible: VerdictDiffCellV1[] = [];
  const unconstructible: { cell: VerdictDiffCellV1; ruleId: string }[] = [];
  const byRule: Record<string, number> = Object.fromEntries(
    CONSTRUCTIBILITY_RULES_V1.map((r) => [r.id, 0]),
  );

  for (const cell of cells) {
    // First matching rule owns the retirement, so a cell is never counted twice
    // and `byRule` sums exactly to the unconstructible total.
    const rule = CONSTRUCTIBILITY_RULES_V1.find((r) => r.refuses(cell));
    if (rule === undefined) {
      constructible.push(cell);
    } else {
      unconstructible.push({ cell, ruleId: rule.id });
      byRule[rule.id] = (byRule[rule.id] ?? 0) + 1;
    }
  }

  return { total: cells.length, constructible, unconstructible, byRule };
}
