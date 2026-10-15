// The known gaps of devnet-test-issue-3251-member-sharing.mjs, in one place.
//
// A check reports an ordinary result: { check, outcome: 'pass' | 'fail', text,
// quiet, evidence }. `classify` applies the known gaps to it once, before it
// is reported. A failure that a gap explains, with evidence of the gap's
// cause, is an expected failure: printed as XFAIL with the issue, and it does
// not fail its case. The check that a gap is about holding is printed as XPASS
// (and counted as held), so that the gap can be retired once its issue is
// fixed. Every other result is reported as it is; a `quiet` pass (a
// precondition that held) is not reported at all.
//
// Retiring a gap is removing its entry, and its tests.

/**
 * #3264: a member of a registered graph that reaches only the owner never
 * obtains the graph's definition. It covers checks of a member, never of the
 * owner, on a graph that is registered on chain and public: the member's
 * definition (the gap itself), its `synced` flag, and its own writes into the
 * graph. On a private graph the member joins through the signed request flow,
 * which #3264 is not about. A failure of one is the gap only with evidence of
 * the gap's state and of what preceded it: the member lacked the definition
 * (in the same listing, or right after its write was refused, which also
 * takes the refusal's structured code, never the wording of its message), and
 * it was never seen holding it before. A member that holds the definition,
 * that held it and lost it, or whose state is not known, fails.
 */
const REGISTERED_DEFINITION = {
  issue: '#3264',
  what: 'a member of a registered graph that reaches only the owner never obtains the graph\'s definition',
  covers: ({ check, evidence }) => evidence?.registered === true && evidence?.private === false && evidence?.member === true
    && ['definition', 'synced', 'write-refused'].includes(check),
  isTheGap: ({ check }) => check === 'definition',
  failure({ check, evidence }) {
    const refusedAsUnknown = check !== 'write-refused' || evidence.errorCode === 'CONTEXT_GRAPH_NOT_FOUND';
    if (evidence.definitionHeld === false && evidence.definitionSeen === false && refusedAsUnknown) {
      return { expected: true, because: { synced: 'it holds no definition of the graph', 'write-refused': 'the author holds no definition of the graph' }[check] };
    }
    if (evidence.definitionHeld === false && evidence.definitionSeen === true) {
      return { expected: false, because: `${check === 'write-refused' ? 'the author' : 'it'} held the definition before and lost it, so this is not #3264` };
    }
    return { expected: false, because: check === 'synced' && evidence.definitionHeld === true ? 'it holds the definition, so this is not #3264' : undefined };
  },
};

export const KNOWN_GAPS = [REGISTERED_DEFINITION];

/**
 * A check's result with the known gaps applied: { verdict: 'pass' | 'quiet' |
 * 'fail' | 'xfail' | 'xpass', text, gap }.
 */
export function classify(result, gaps = KNOWN_GAPS) {
  const gap = gaps.find(candidate => candidate.covers(result)) ?? null;
  if (result.outcome === 'pass') {
    if (gap?.isTheGap(result)) return { verdict: 'xpass', text: result.text, gap };
    return { verdict: result.quiet ? 'quiet' : 'pass', text: result.text, gap: null };
  }
  const judged = gap ? gap.failure(result) : { expected: false };
  const text = judged.because ? `${result.text}; ${judged.because}` : result.text;
  return judged.expected ? { verdict: 'xfail', text, gap } : { verdict: 'fail', text, gap: null };
}

export const xfailLine = (caseId, text, gap) => `  [XFAIL] case ${caseId}: ${text} (expected failure: ${gap.issue}, ${gap.what})`;
export const xpassLine = (caseId, text, gap) =>
  `  [XPASS] case ${caseId}: ${text} (held although ${gap.issue} is expected to fail it; remove the expected failure once ${gap.issue} is fixed)`;

/**
 * One line per known gap that a check of the run touched, from the counts of
 * its expected failures and of its checks that held: { [issue]: { expected,
 * unexpected } }.
 */
export function gapSummaries(counts, gaps = KNOWN_GAPS) {
  return gaps.filter(gap => counts[gap.issue]?.expected || counts[gap.issue]?.unexpected).map(gap => {
    const { expected = 0, unexpected = 0 } = counts[gap.issue];
    return `known gap ${gap.issue} (${gap.what}): ${expected} check(s) failed as expected${unexpected ? `, ${unexpected} held: remove the expected failure once ${gap.issue} is fixed` : ''}`;
  });
}
