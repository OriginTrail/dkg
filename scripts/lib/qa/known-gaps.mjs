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
 * None is open. The last, #3264 (a member of a registered graph that reaches
 * only the owner never obtained the graph's definition), was retired once its
 * checks held in every run: the member now takes the definition from a Core
 * that hosts the graph, or from the chain.
 */
export const KNOWN_GAPS = [];

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
