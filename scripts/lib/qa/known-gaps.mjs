// The known gaps of the devnet suites devnet-test-issue-3251-member-sharing.mjs
// and devnet-test-one-graph-promotion.mjs, in one place.
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
 * #3264: a member of a registered public graph never obtains the graph's
 * definition: only the owner holds the declaration, and a member asks only
 * the peers it is connected to for it. A member that reaches only the owner
 * (member-sharing), or that reaches the network through relays and never the
 * owner (one-graph promotion), is left without it. It covers checks of a
 * member, never of the owner, on a graph that is registered on chain and
 * public: the member's definition (the gap itself), its `synced` flag, and
 * its own writes into the graph. On a private graph the member joins through the signed request flow,
 * which #3264 is not about. A failure of one is the gap only with evidence of
 * the gap's state and of what preceded it: the member lacked the definition
 * (in the same listing, or right after its write was refused, which also
 * takes the refusal's structured code, never the wording of its message), and
 * it was never seen holding it before. A member that holds the definition,
 * that held it and lost it, or whose state is not known, fails.
 */
const REGISTERED_DEFINITION = {
  issue: '#3264',
  what: 'a member of a registered public graph never obtains the graph\'s definition from the peers it reaches',
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

/**
 * #3293: an Edge that holds a registered graph's definition does not know the
 * graph's sub-graphs (the declaration it pulls carries no sub-graph
 * registration), and its first write into a sub-graph fails with HTTP 500
 * (`Sub-graph "…" has not been registered in context graph "…"`). It covers
 * the one-graph promotion suite's write before the writer registers the
 * sub-graph itself (`sub-graph-write`). A failure is the gap only with
 * evidence: the writer held the definition, its listing did not name the
 * sub-graph, and the write was refused with HTTP 500 naming the unregistered
 * sub-graph (the refusal carries no code, so its wording is the evidence).
 */
const SUB_GRAPH_UNREGISTERED = {
  issue: '#3293',
  what: 'an Edge holding a registered graph\'s definition does not know its sub-graph, and its first write there fails with HTTP 500',
  covers: ({ check }) => check === 'sub-graph-write',
  // A write that went through says #3293 is fixed only from a writer that did not list the sub-graph:
  // one that had learned it (from shared-memory sync, say) never met the gap.
  isTheGap: ({ check, evidence }) => check === 'sub-graph-write' && evidence?.subGraphListed === false,
  failure({ evidence }) {
    if (evidence?.definitionHeld !== true) return { expected: false, because: 'the writer held no definition, so this is not #3293' };
    if (evidence.subGraphListed === false && evidence.httpStatus === 500 && evidence.unregisteredSubGraph === true) {
      return { expected: true, because: 'the writer holds the definition but not the sub-graph' };
    }
    return { expected: false, because: evidence.subGraphListed === true ? 'the writer lists the sub-graph, so this is not #3293' : undefined };
  },
};

/**
 * #3294: the curator cannot promote a report another Edge authored: the
 * author's seal never reaches the curator, so the publish route answers HTTP
 * 409 ASSERTION_AUTHOR_NOT_RESIDENT although the report is in the curator's
 * shared memory. It covers the one-graph promotion suite's promotion of a
 * report whose author is not the curator (`member-promotion`), and the check
 * that depends on it, the author sharing again after that promotion
 * (`post-promotion-share`, not exercised without it). A failure is the gap
 * only with evidence: that refusal (HTTP 409 with that code), and the curator
 * holding the report in its shared memory before the promotion.
 */
const MEMBER_PROMOTION = {
  issue: '#3294',
  what: 'the curator cannot promote a report another Edge authored: the author\'s seal never reaches it',
  covers: ({ check, evidence }) => ['member-promotion', 'post-promotion-share'].includes(check) && evidence?.authorIsCurator === false,
  isTheGap: ({ check }) => check === 'member-promotion',
  failure({ evidence }) {
    if (evidence.heldByCurator !== true) return { expected: false, because: 'the curator never held the report, so this is not #3294' };
    if (evidence.code !== 'ASSERTION_AUTHOR_NOT_RESIDENT') return { expected: false, because: undefined };
    if (evidence.httpStatus !== 409) return { expected: false, because: `the refusal came with HTTP ${evidence.httpStatus ?? 'no status'}, not 409, so this is not #3294` };
    return { expected: true, because: 'the curator holds the report but not its author\'s seal' };
  },
};

/**
 * #3296: a node that already holds a graph's data when its catch-up runs is
 * never marked synced. A catch-up marks a graph synced only when one of its
 * planes inserted data triples; the node's shared-memory passes insert none,
 * and the durable plane of a catalog-authoritative graph is not attempted.
 * It covers the one-graph promotion suite's synced flag of a node in that
 * state, within its deadline after the client remedy's subscribe
 * (`synced-after-remedy`) and at the end of the run (`synced-at-end`): one
 * that held every report it should, in its layer, at the first reads after
 * its last subscribe was accepted (`heldAtSubscribe`). A failure is the gap
 * only with evidence: the node holds the graph's definition and is
 * subscribed, no listing of it ever showed the graph synced (`everSynced`
 * false: a node that was synced and lost it is another failure), and its log
 * shows shared-memory catch-up passes after that subscribe, none of which
 * inserted data (rows or snapshots). The flag holding on such a node is the
 * gap's check holding.
 */
const caughtUpOnNothing = evidence => evidence?.catchupPasses > 0 && evidence?.catchupDataTriples === 0;
const SYNCED_CHECKS = ['synced-after-remedy', 'synced-at-end'];
const HELD_DATA_NEVER_SYNCED = {
  issue: '#3296',
  what: 'a node that already holds a graph\'s data is never marked synced: its catch-up inserts no data, and only inserted data marks a graph synced',
  covers: ({ check, evidence }) => SYNCED_CHECKS.includes(check) && evidence?.heldAtSubscribe === true,
  isTheGap: ({ check, evidence }) => SYNCED_CHECKS.includes(check) && evidence?.heldAtSubscribe === true && caughtUpOnNothing(evidence),
  failure({ evidence }) {
    if (evidence.definitionHeld !== true) return { expected: false, because: 'the node holds no definition of the graph, so this is not #3296' };
    if (evidence.subscribed !== true) return { expected: false, because: 'the node is not subscribed to the graph, so this is not #3296' };
    if (evidence.synced === true) return { expected: false, because: 'the node was marked synced, only late, so this is not #3296' };
    if (evidence.everSynced !== false) {
      return { expected: false, because: evidence.everSynced === true ? 'the node was listed as synced before and lost it, so this is not #3296' : 'it is not known whether the node was ever listed as synced, so this is not known to be #3296' };
    }
    if (!(evidence.catchupPasses > 0)) return { expected: false, because: 'its log shows no shared-memory catch-up after its last subscribe, so this is not known to be #3296' };
    if (evidence.catchupDataTriples !== 0) return { expected: false, because: `its catch-up inserted ${evidence.catchupDataTriples} data triple(s), so this is not #3296` };
    return { expected: true, because: `it held the graph's reports at its subscribe, and its catch-up's ${evidence.catchupPasses} shared-memory pass(es) inserted no data` };
  },
};

export const KNOWN_GAPS = [REGISTERED_DEFINITION, SUB_GRAPH_UNREGISTERED, MEMBER_PROMOTION, HELD_DATA_NEVER_SYNCED];

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
