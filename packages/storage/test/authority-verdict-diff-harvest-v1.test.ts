import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CORE_AMBIGUOUS_REJECT_LITERALS_V1,
  CORE_DELEGATED_REJECT_REASON_SITES_V1,
  CORE_QUARANTINE_REASONS_V1,
  CORE_REJECT_REASON_SITES_V1,
  VERDICT_DIFF_AXES_V1,
} from './helpers/authority-verdict-diff-fixture-v1.js';

/**
 * Phase 1, first pinned piece: the harvested `literal -> site(s)` map for core's
 * authority decisions.
 *
 * WHY A SOURCE HARVEST AND NOT A RUN. `reject.reason` is an open `string`, so
 * its codomain cannot be enumerated from the type -- it has to be read out of
 * the source. Pinning the harvest here means a reject that is ADDED, REMOVED or
 * REWORDED turns this red immediately, rather than surfacing later as an
 * unmapped literal in the verdict table. The map is what makes such a red
 * triageable: it says which site to look at.
 *
 * This deliberately does not assert core's BEHAVIOUR -- that is the verdict
 * table's job. It asserts that the fixture the table depends on still describes
 * the file it was harvested from.
 */
const CORE_SRC = new URL(
  '../../core/src/system-record-authority-v1-internal.ts',
  import.meta.url,
);

/**
 * THE FILE THE EVALUATOR DELEGATES TO.
 *
 * `evaluateAgentProfileHeadAdvanceV1` delegates at :353 and returns that
 * decision VERBATIM at :358, so rejects minted here escape through the same
 * `{ decision, reason }` object carrying no marker of origin. The observable
 * codomain is therefore larger than any one file.
 */
const CORE_DELEGATE_SRC = new URL(
  '../../core/src/system-record-authority-verification-v1-internal.ts',
  import.meta.url,
);

function harvest(source: URL): {
  reject: Map<string, number[]>;
  quarantine: Map<string, number[]>;
} {
  const lines = readFileSync(source, 'utf8').split('\n');
  const reject = new Map<string, number[]>();
  const quarantine = new Map<string, number[]>();
  let pending: 'reject' | 'quarantine' | undefined;
  lines.forEach((line, index) => {
    const decision = /decision:\s*'(accept|stale|quarantine|reject)'/.exec(line);
    if (decision) {
      pending = decision[1] === 'reject' || decision[1] === 'quarantine'
        ? (decision[1] as 'reject' | 'quarantine')
        : undefined;
    }
    const reason = /reason:\s*'((?:[^'\\]|\\.)*)'/.exec(line);
    if (!reason || pending === undefined) return;
    const target = pending === 'reject' ? reject : quarantine;
    target.set(reason[1], [...(target.get(reason[1]) ?? []), index + 1]);
  });
  return { reject, quarantine };
}

describe('core authority decision reason harvest', () => {
  const { reject, quarantine } = harvest(CORE_SRC);
  // The delegate's rejects escape verbatim through the same decision object, so
  // the observable codomain is the pair, never this file alone.
  const delegatedReject = harvest(CORE_DELEGATE_SRC).reject;

  it('pins every reject literal and the sites that produce it', () => {
    expect(Object.fromEntries([...reject].sort())).toEqual(
      Object.fromEntries(Object.entries(CORE_REJECT_REASON_SITES_V1).map(
        ([literal, sites]) => [literal, [...sites]],
      )),
    );
  });

  // The finding this fixture exists to record. `{ decision: 'reject', reason }`
  // carries no origin, so for a literal produced at more than one site the
  // branch is indistinguishable to ANY caller -- the diff included. If this list
  // shrinks, someone made core more observable and the table can say more; if it
  // grows, a new branch became unobservable and Phase 3 inherits the problem.
  it('records exactly the reject literals that are observationally ambiguous', () => {
    // Quantified over BOTH producers, because that is what the register claims.
    // Counting sites per file would call a literal unambiguous whenever each
    // file produces it once -- which is precisely how this shipped saying five.
    const sites = new Map<string, number[]>();
    for (const map of [reject, delegatedReject]) {
      for (const [literal, found] of map) {
        sites.set(literal, [...(sites.get(literal) ?? []), ...found]);
      }
    }
    const ambiguous = [...sites].filter(([, s]) => s.length > 1).map(([l]) => l);
    expect(ambiguous.sort()).toEqual([...CORE_AMBIGUOUS_REJECT_LITERALS_V1].sort());
    // SIX UNTIL THE LATE-TOMBSTONE ENTRY MIRRORED THE CLOCK GATES. That entry has
    // to refuse an unusable clock and a too-far-future head ITSELF -- delegating
    // them would let a clock failure read as tombstone precedence -- so both
    // literals now have a second producing site. `head issuedAt exceeds the
    // future clock-skew bound` crossed from one site to two and joined the
    // register; `verification clock is invalid` was already ambiguous across the
    // two files and went from two sites to three. The register growing is the
    // honest record of a branch a caller can no longer distinguish, and it is
    // the price of the guard rather than an oversight.
    expect(ambiguous).toHaveLength(7);
  });

  // THE GUARD IS KEYED ON THE MECHANISM, NOT ON THE LITERAL THAT ESCAPED.
  // A pin naming 'verification clock is invalid' would go green the moment that
  // particular literal was reworded, while the next cross-file duplicate walked
  // through the same gap. The mechanism is: a literal both files can produce is
  // observationally ambiguous no matter how few sites either file has, so the
  // key INTERSECTION of the two maps must be a subset of the register.
  it('registers every literal both files can produce, so a cross-file duplicate cannot escape', () => {
    const crossFile = [...reject.keys()].filter((literal) => delegatedReject.has(literal));
    // Non-vacuity: an empty intersection would satisfy the subset check trivially.
    expect(crossFile.length).toBeGreaterThan(0);
    for (const literal of crossFile) {
      expect(CORE_AMBIGUOUS_REJECT_LITERALS_V1).toContain(literal);
    }
  });

  // Quarantine is a different kind of thing wearing the same field name: a
  // closed union that is part of the contract, where the VALUE is the meaning.
  // Several sites producing one value is not ambiguity -- a caller acts on the
  // value, not the branch -- so this pins the closed set, and the sites only so
  // a change in where quarantine is decided is visible.
  it('pins the closed quarantine reason union as a contract value', () => {
    expect([...quarantine.keys()].sort()).toEqual(
      Object.keys(CORE_QUARANTINE_REASONS_V1).sort(),
    );
    expect(Object.fromEntries([...quarantine].sort())).toEqual(
      Object.fromEntries(Object.entries(CORE_QUARANTINE_REASONS_V1).map(
        ([reason, { sites }]) => [reason, [...sites]],
      )),
    );
  });

  // Non-vacuity: the harvester must actually find things. Without this the three
  // rows above would all pass against an empty map if the regex or the path
  // broke -- the zero-is-indistinguishable-from-a-broken-probe failure.
  it('harvests a non-trivial number of sites, so an empty map cannot pass', () => {
    // 32 until the late-tombstone entry added its own precondition reject.
    expect([...reject.values()].flat().length).toBe(36);
    expect([...quarantine.values()].flat().length).toBe(10);
  });
});

/**
 * AXIS J IS PINNED AGAINST THE CONTRACT IT CLAIMS TO ENUMERATE.
 *
 * This is the check that was missing, and its absence cost a real defect: the
 * fixture's prose said axis J was "grounded in core's declared input shapes"
 * while the axis listed four of the six optional members that shape declares.
 * Prose was the only thing asserting the grounding, so nothing went red, and a
 * table that pins every constructible cell was measuring a QUARTER of the
 * evidence space it claimed. A grounding claim that is not executable is not a
 * grounding claim.
 *
 * TWO SOURCES, ASSERTED AGAINST EACH OTHER as well as against the axis, because
 * they can disagree and the disagreement is itself a defect: the INTERFACE
 * declares the contract, while the runtime `optionals` list in
 * `snapshotHeadAdvanceEvidenceV1` decides which keys survive the exact-record
 * snapshot. A member added to the interface but not to that list would be
 * silently dropped from every evaluation -- present to the type checker, absent
 * to the evaluator.
 */
const EVIDENCE_INTERFACE_START = /export interface AgentProfileHeadAdvanceEvidenceV1 \{/;

function harvestEvidenceOptionals(): { declared: string[]; snapshotted: string[] } {
  const source = readFileSync(CORE_SRC, 'utf8');
  const lines = source.split('\n');
  const start = lines.findIndex((line) => EVIDENCE_INTERFACE_START.test(line));
  const end = lines.findIndex((line, index) => index > start && line.trimEnd() === '}');
  const declared = lines.slice(start + 1, end)
    .map((line) => /^\s*readonly\s+(\w+)\?:/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);

  // ANCHORED TO THE FUNCTION IT MEANS, not to the first `const optionals` in the
  // file. It used to be the latter, and that was a latent defect this PR fired:
  // a SECOND snapshot helper with its own optionals list was added ABOVE this
  // one, so the pin silently began harvesting the other function's members and
  // compared them against this interface's declarations. The row stayed a row
  // and measured the wrong pair. A regex keyed on a shape that is unique only
  // until someone writes a second instance is a check that cannot fail on
  // schedule.
  const snapshotFn = source.indexOf('function snapshotHeadAdvanceEvidenceV1');
  if (snapshotFn < 0) throw new Error('snapshotHeadAdvanceEvidenceV1 not found in core source');
  const optionals = /const optionals = \[([^\]]*)\]/
    .exec(source.slice(snapshotFn))?.[1] ?? '';
  const snapshotted = [...optionals.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  return { declared, snapshotted };
}

/**
 * THE DELEGATED REJECT MAP IS PINNED TO ITS SOURCE, exactly as the primary one
 * is.
 *
 * The fixture recorded these six literals while only the FIRST source file was
 * harvested. So a delegated reject that was added, removed or reworded stayed
 * invisible unless the current sweep happened to reach that branch -- and the
 * sweep reaching a branch is a property of the axis set, not of the map. A map
 * the verdict table trusts but nothing pins is the same check-that-cannot-fail
 * this file exists to close for the primary map; it was closed on one file and
 * left open on the other.
 */
describe('core delegated authority-verification reason harvest', () => {
  const { reject, quarantine } = harvest(CORE_DELEGATE_SRC);

  it('pins every delegated reject literal and the sites that produce it', () => {
    expect(Object.fromEntries([...reject].sort())).toEqual(
      Object.fromEntries(Object.entries(CORE_DELEGATED_REJECT_REASON_SITES_V1).map(
        ([literal, sites]) => [literal, [...sites]],
      )),
    );
  });

  // Non-vacuity, for the same reason the primary harvest carries it: an empty
  // map compares equal to an empty map, so a broken path or a regex that
  // stopped matching would pass the row above without finding anything.
  it('harvests the six delegated reject sites, so an empty map cannot pass', () => {
    expect([...reject.values()].flat()).toHaveLength(6);
    expect(reject.has('transition does not bind the accepted predecessor')).toBe(true);
  });

  // PINNED AS ZERO RATHER THAN OMITTED. The delegate mints no quarantines
  // today; if it starts, that value escapes verbatim into a codomain the table
  // checks against a union harvested from the other file, and the table would
  // meet a quarantine reason it has no row for.
  it('pins the delegate as minting no quarantine reasons', () => {
    expect([...quarantine.keys()]).toStrictEqual([]);
  });
});

describe('core head-advance evidence optional harvest', () => {
  const { declared, snapshotted } = harvestEvidenceOptionals();

  it('pins axis J as exactly the declared optional evidence members', () => {
    expect([...declared].sort())
      .toEqual([...VERDICT_DIFF_AXES_V1.J_evidencePresence].sort());
  });

  // The interface and the runtime filter must name the same set, or a declared
  // member is unreachable at evaluation time regardless of what any axis says.
  it('pins the runtime optional filter as the same set the interface declares', () => {
    expect([...snapshotted].sort()).toEqual([...declared].sort());
  });

  // Non-vacuity, for the same reason the reject harvest has it: two empty lists
  // compare equal, so a broken regex would otherwise pass both rows above.
  it('harvests the six optional members, so an empty list cannot pass', () => {
    expect(declared).toHaveLength(6);
    expect(snapshotted).toHaveLength(6);
    expect(declared).toContain('verifiedAuthoritySummary');
    expect(declared).toContain('forkEvidenceHeads');
  });
});
