import assert from 'node:assert/strict';
import test from 'node:test';
import { KNOWN_GAPS, classify, gapSummaries, xfailLine, xpassLine } from '../qa/known-gaps.mjs';
import { foldSubscription, freshSubscription, listingObservation, subscriptionResults } from '../qa/member-sharing.mjs';
import { createReport } from '../member-sharing/report.mjs';

// A gap of the kind the suite records: it covers some checks, and explains a failure of one only with evidence of
// its cause.
const SAMPLE = {
  issue: '#1',
  what: 'a sample defect',
  covers: ({ check, evidence }) => evidence?.sample === true && ['definition', 'synced'].includes(check),
  isTheGap: ({ check }) => check === 'definition',
  failure: ({ evidence }) => (evidence.caused ? { expected: true, because: 'its cause was seen' } : { expected: false, because: 'its cause was not seen' }),
};

test('a gap turns the failures it explains into expected ones and its own check holding into XPASS', () => {
  const caused = { sample: true, caused: true };
  assert.deepEqual(classify({ check: 'synced', outcome: 'fail', text: 'seen', evidence: caused }, [SAMPLE]), { verdict: 'xfail', text: 'seen; its cause was seen', gap: SAMPLE });
  assert.deepEqual(classify({ check: 'synced', outcome: 'fail', text: 'seen', evidence: { ...caused, caused: false } }, [SAMPLE]),
    { verdict: 'fail', text: 'seen; its cause was not seen', gap: null });
  assert.deepEqual(classify({ check: 'definition', outcome: 'pass', quiet: true, text: 'held', evidence: caused }, [SAMPLE]), { verdict: 'xpass', text: 'held', gap: SAMPLE });
  // A pass the gap is not about, or a check it does not cover, is reported as it is.
  assert.deepEqual(classify({ check: 'synced', outcome: 'pass', text: 'synced', evidence: caused }, [SAMPLE]), { verdict: 'pass', text: 'synced', gap: null });
  assert.deepEqual(classify({ check: 'held', outcome: 'fail', text: 'NOT in the view', evidence: caused }, [SAMPLE]), { verdict: 'fail', text: 'NOT in the view', gap: null });
  assert.deepEqual(classify({ check: 'definition', outcome: 'pass', quiet: true, text: 'held' }, [SAMPLE]), { verdict: 'quiet', text: 'held', gap: null });
  assert.equal(xfailLine(7, 'node8 (member1), registered: seen', SAMPLE), '  [XFAIL] case 7: node8 (member1), registered: seen (expected failure: #1, a sample defect)');
  assert.equal(xpassLine(7, 'node8 (member1), registered: held', SAMPLE),
    '  [XPASS] case 7: node8 (member1), registered: held (held although #1 is expected to fail it; remove the expected failure once #1 is fixed)');
  assert.deepEqual(gapSummaries({ '#1': { expected: 5, unexpected: 1 } }, [SAMPLE]),
    ['known gap #1 (a sample defect): 5 check(s) failed as expected, 1 held: remove the expected failure once #1 is fixed']);
  assert.deepEqual(gapSummaries({ '#1': { expected: 2, unexpected: 0 } }, [SAMPLE]), ['known gap #1 (a sample defect): 2 check(s) failed as expected']);
  assert.deepEqual(gapSummaries({}, [SAMPLE]), []);
});

test('no gap covers a member of a registered graph: every such check is reported as it is (#3264 retired)', () => {
  // The open gaps are the one-graph promotion suite's; none covers these checks.
  assert.deepEqual(KNOWN_GAPS.map(gap => gap.issue), ['#3293', '#3294', '#3296']);
  const lacking = { registered: true, private: false, member: true, definitionHeld: false, definitionSeen: false };
  for (const check of ['definition', 'synced']) {
    assert.deepEqual(classify({ check, outcome: 'fail', text: 'seen', evidence: lacking }), { verdict: 'fail', text: 'seen', gap: null });
  }
  assert.deepEqual(classify({ check: 'write-refused', outcome: 'fail', text: 'seen', evidence: { ...lacking, errorCode: 'CONTEXT_GRAPH_NOT_FOUND' } }),
    { verdict: 'fail', text: 'seen', gap: null });
  // The definition held is a quiet precondition again, not an XPASS.
  assert.deepEqual(classify({ check: 'definition', outcome: 'pass', quiet: true, text: 'held', evidence: { ...lacking, definitionHeld: true, definitionSeen: true } }),
    { verdict: 'quiet', text: 'held', gap: null });
  assert.deepEqual(gapSummaries({ '#3264': { expected: 0, unexpected: 2 } }), []);
});

// What the report prints for a member's subscription, from the raw answers of
// its listing (GET /api/context-graph/list) at each poll: the listing parser,
// the observation and the checks, as the suite composes them.
const ID = '0xabc/issue-3251-registered-1';
const DEADLINES = { definitionMs: 90_000, syncedMs: 90_000 };
function printed(answers, { registered = true, isPrivate = false } = {}) {
  let observation = freshSubscription();
  for (const [age, httpStatus, body] of answers) {
    const seen = listingObservation(httpStatus, body, ID);
    observation = foldSubscription(observation, seen.readable ? seen : { readable: false, why: seen.reason }, age, DEADLINES);
  }
  const results = subscriptionResults(observation, { registered, private: isPrivate, member: true, ...DEADLINES });
  return Object.fromEntries(Object.entries(results).map(([kind, result]) => [kind, classify(result).verdict]));
}
const listing = (...graphs) => JSON.stringify({ contextGraphs: graphs });
const entry = fields => ({ id: ID, subscribed: true, synced: false, ...fields });

test('raw listing answers decide a member\'s definition and synced checks, on registered and other graphs alike', () => {
  const at = body => [[30_000, 200, body], [90_000, 200, body]];
  // No access policy for the graph, an empty one, or a listing that does not name the graph: no definition.
  for (const body of [listing(entry({})), listing(entry({ accessPolicy: '' })), listing({ id: 'another-graph', subscribed: true, synced: true, accessPolicy: 'public' })]) {
    assert.deepEqual(printed(at(body)), { definition: 'fail', synced: 'fail' }, body);
    assert.deepEqual(printed(at(body), { registered: false }), { definition: 'fail', synced: 'fail' }, body);
  }
  // The definition held (accessPolicy "public") and never synced: the synced check fails.
  assert.deepEqual(printed(at(listing(entry({ accessPolicy: 'public' })))), { definition: 'quiet', synced: 'fail' });
  // An answer that is not a listing is no evidence: it fails.
  for (const [httpStatus, body] of [[503, '{"error":"busy"}'], [200, 'not json'], [200, '{"graphs":[]}'], [200, listing({ subscribed: true })], [0, '']]) {
    assert.deepEqual(printed([[30_000, httpStatus, body], [90_000, httpStatus, body]]), { definition: 'fail', synced: 'fail' }, `${httpStatus} ${body}`);
  }
  // A listing readable early and unreadable at the deadline: the deadline's answer decides.
  assert.deepEqual(printed([[30_000, 200, listing(entry({}))], [90_000, 503, '{"error":"busy"}']]), { definition: 'fail', synced: 'fail' });
  // Held in time: the definition is a quiet precondition, the synced flag a pass; private graphs too.
  for (const [accessPolicy, options] of [['public', {}], ['public', { registered: false }], ['private', { isPrivate: true }]]) {
    assert.deepEqual(printed([[5_000, 200, listing(entry({ accessPolicy, synced: true }))]], options), { definition: 'quiet', synced: 'pass' });
  }
});

test('a refused write fails its case, the owner\'s and a member\'s alike', () => {
  const lines = [];
  const report = createReport({ 1: 'owner writes', 2: 'member writes' }, { print: line => lines.push(line) });
  const graph = { key: 'registered', registered: true, private: false };
  const refused = (caseId, author) => ({
    caseId, node: { label: 'node9 (member2)' },
    record: {
      author, graph, sub: null, value: `${author.role} live root (1)`,
      error: 'the author refused the asset: HTTP 404', errorCode: 'CONTEXT_GRAPH_NOT_FOUND', definitionHeld: false,
    },
  });
  report.reportPair(refused(1, { role: 'owner', label: 'node7 (owner)', member: false }), { boundMs: 60_000, definitionSeen: false });
  report.reportPair(refused(2, { role: 'member1', label: 'node8 (member1)', member: true }), { boundMs: 60_000, definitionSeen: false });
  assert.deepEqual(report.summary('Results'), ['1', '2']);
  assert.ok(lines.includes('  [FAIL] case 1: "owner live root (1)" by node7 (owner) in registered root at node9 (member2): not written, the author refused the asset: HTTP 404'), lines.join('\n'));
  assert.ok(lines.includes('  [FAIL] case 2: "member1 live root (1)" by node8 (member1) in registered root at node9 (member2): not written, the author refused the asset: HTTP 404'), lines.join('\n'));
  assert.ok(!lines.some(line => line.includes('known gap')), lines.join('\n'));
});
