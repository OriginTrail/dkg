import assert from 'node:assert/strict';
import test from 'node:test';
import { KNOWN_GAPS, classify, gapSummaries, xfailLine, xpassLine } from '../qa/known-gaps.mjs';
import { foldSubscription, freshSubscription, listingObservation, subscriptionResults } from '../qa/member-sharing.mjs';
import { createReport } from '../member-sharing/report.mjs';

const GAP = KNOWN_GAPS.find(gap => gap.issue === '#3264');
// A failed check of the kind the gap covers, with the evidence it was judged on.
const failed = (check, evidence) => classify({ check, outcome: 'fail', text: 'seen', evidence });
// A member that was never seen holding the definition, on a public graph, unless said
// otherwise: #3264 is about members of registered public graphs that never obtain it.
const registeredGapVerdict = ({ registered, definitionHeld, private: isPrivate = false, member = true, definitionSeen = false }) => {
  const verdicts = ['definition', 'synced'].map(check => failed(check, { registered, private: isPrivate, member, definitionHeld, definitionSeen }).verdict);
  assert.equal(verdicts[0], verdicts[1], 'the definition and the synced flag are judged alike');
  return verdicts[0];
};
const refusedWriteVerdict = ({ errorCode, registered, definitionHeld, private: isPrivate = false, member = true, definitionSeen = false }) =>
  failed('write-refused', { registered, private: isPrivate, member, definitionHeld, definitionSeen, errorCode }).verdict;

test('a missed check on a registered graph is the known gap only when the member is shown to lack the definition', () => {
  assert.equal(registeredGapVerdict({ registered: true, definitionHeld: false }), 'xfail');
  // A member that holds the definition and still never syncs, or cannot write, has another defect.
  assert.equal(registeredGapVerdict({ registered: true, definitionHeld: true }), 'fail');
  // No evidence either way (the listing could not be read) is no exemption.
  assert.equal(registeredGapVerdict({ registered: true, definitionHeld: undefined }), 'fail');
  // Not a registered graph: the gap does not apply.
  assert.equal(registeredGapVerdict({ registered: false, definitionHeld: false }), 'fail');
});

test('a refused write is judged by its structured code, not by the wording of its message', () => {
  const gap = { registered: true, definitionHeld: false };
  assert.equal(refusedWriteVerdict({ errorCode: 'CONTEXT_GRAPH_NOT_FOUND', ...gap }), 'xfail');
  // Another code fails, whatever its message says.
  assert.equal(refusedWriteVerdict({ errorCode: 'WRITE_FORBIDDEN', ...gap }), 'fail');
  assert.equal(refusedWriteVerdict({ errorCode: undefined, ...gap }), 'fail');
  // The gap's code still needs the evidence and the registered graph.
  assert.equal(refusedWriteVerdict({ errorCode: 'CONTEXT_GRAPH_NOT_FOUND', registered: true, definitionHeld: true }), 'fail');
  assert.equal(refusedWriteVerdict({ errorCode: 'CONTEXT_GRAPH_NOT_FOUND', registered: false, definitionHeld: false }), 'fail');
});

test('the gap is applied once, to ordinary results, and says why in the line it prints', () => {
  const registered = { registered: true, private: false, member: true, definitionHeld: false, definitionSeen: false };
  // A check the gap does not cover is reported as it is.
  assert.deepEqual(classify({ check: 'held', outcome: 'pass', text: 'held 3 s after the share' }), { verdict: 'pass', text: 'held 3 s after the share', gap: null });
  assert.deepEqual(classify({ check: 'held', outcome: 'fail', text: 'NOT in the view', evidence: registered }), { verdict: 'fail', text: 'NOT in the view', gap: null });
  // A quiet pass (a precondition that held) prints nothing; on the registered graph the definition is the gap itself.
  const definition = { check: 'definition', outcome: 'pass', quiet: true, text: 'holds the definition 4 s after it subscribed' };
  assert.equal(classify({ ...definition, evidence: { registered: false, definitionHeld: true } }).verdict, 'quiet');
  assert.deepEqual(classify({ ...definition, evidence: { registered: true, private: false, member: true, definitionHeld: true, definitionSeen: true } }), { verdict: 'xpass', text: definition.text, gap: GAP });
  // A synced flag that held on the registered graph is an ordinary pass: only the definition is the gap.
  assert.equal(classify({ check: 'synced', outcome: 'pass', text: 'lists it as synced 8 s after it subscribed', evidence: { registered: true, private: false, member: true } }).verdict, 'pass');
  // The reason travels with the line.
  assert.equal(failed('synced', registered).text, 'seen; it holds no definition of the graph');
  assert.equal(failed('write-refused', { ...registered, errorCode: 'CONTEXT_GRAPH_NOT_FOUND' }).text, 'seen; the author holds no definition of the graph');
  assert.equal(failed('definition', registered).text, 'seen');
  assert.equal(failed('synced', { registered: true, private: false, member: true, definitionHeld: true }).text, 'seen; it holds the definition, so this is not #3264');
  assert.equal(failed('synced', { registered: true, private: false, member: true, definitionHeld: undefined }).text, 'seen');
  assert.equal(xfailLine(7, 'node8 (member1), registered: seen', GAP),
    `  [XFAIL] case 7: node8 (member1), registered: seen (expected failure: #3264, ${GAP.what})`);
  assert.equal(xpassLine(7, 'node8 (member1), registered: held', GAP),
    '  [XPASS] case 7: node8 (member1), registered: held (held although #3264 is expected to fail it; remove the expected failure once #3264 is fixed)');
  assert.deepEqual(gapSummaries({ '#3264': { expected: 5, unexpected: 1 } }),
    [`known gap #3264 (${GAP.what}): 5 check(s) failed as expected, 1 held: remove the expected failure once #3264 is fixed`]);
  assert.deepEqual(gapSummaries({}), []);
});

test('retiring the gap is removing its entry: every check is then reported as it is', () => {
  assert.deepEqual(classify({ check: 'synced', outcome: 'fail', text: 'seen', evidence: { registered: true, definitionHeld: false } }, []),
    { verdict: 'fail', text: 'seen', gap: null });
  assert.deepEqual(classify({ check: 'definition', outcome: 'pass', quiet: true, text: 'held', evidence: { registered: true, definitionHeld: true } }, []),
    { verdict: 'quiet', text: 'held', gap: null });
  assert.deepEqual(gapSummaries({ '#3264': { expected: 5, unexpected: 0 } }, []), []);
});

// What the report prints for a member's subscription, from the raw answers of
// its listing (GET /api/context-graph/list) at each poll: the listing parser,
// the observation, the checks and the gap, as the suite composes them.
const ID = '0xabc/issue-3251-registered-1';
const DEADLINES = { definitionMs: 90_000, syncedMs: 90_000 };
function classified(answers, { registered = true, isPrivate = false } = {}) {
  let observation = freshSubscription();
  for (const [age, httpStatus, body] of answers) {
    const seen = listingObservation(httpStatus, body, ID);
    observation = foldSubscription(observation, seen.readable ? seen : { readable: false, why: seen.reason }, age, DEADLINES);
  }
  const results = subscriptionResults(observation, { registered, private: isPrivate, member: true, ...DEADLINES });
  return Object.fromEntries(Object.entries(results).map(([kind, result]) => [kind, classify(result)]));
}
const printed = (answers, options) => Object.fromEntries(Object.entries(classified(answers, options)).map(([kind, { verdict }]) => [kind, verdict]));
const listing = (...graphs) => JSON.stringify({ contextGraphs: graphs });
const entry = fields => ({ id: ID, subscribed: true, synced: false, ...fields });

test('raw listing answers decide the gap: only a readable listing without the definition is the expected failure', () => {
  const at = body => [[30_000, 200, body], [90_000, 200, body]];
  // No access policy for the graph: the definition never arrived. #3264.
  assert.deepEqual(printed(at(listing(entry({})))), { definition: 'xfail', synced: 'xfail' });
  // An empty access policy is no definition either; nor is a listing that does not name the graph.
  assert.deepEqual(printed(at(listing(entry({ accessPolicy: '' })))), { definition: 'xfail', synced: 'xfail' });
  assert.deepEqual(printed(at(listing({ id: 'another-graph', subscribed: true, synced: true, accessPolicy: 'public' }))), { definition: 'xfail', synced: 'xfail' });
  // The definition held (accessPolicy "public") and never synced: another defect, not #3264.
  assert.deepEqual(printed(at(listing(entry({ accessPolicy: 'public' })))), { definition: 'xpass', synced: 'fail' });
  // An answer that is not a listing is no evidence: it fails, on the registered graph too.
  for (const [httpStatus, body] of [[503, '{"error":"busy"}'], [200, 'not json'], [200, '{"graphs":[]}'], [200, listing({ subscribed: true })], [0, '']]) {
    assert.deepEqual(printed([[30_000, httpStatus, body], [90_000, httpStatus, body]]), { definition: 'fail', synced: 'fail' }, `${httpStatus} ${body}`);
  }
  // A listing readable early and unreadable at the deadline: the deadline's answer decides.
  assert.deepEqual(printed([[30_000, 200, listing(entry({}))], [90_000, 503, '{"error":"busy"}']]), { definition: 'fail', synced: 'fail' });
  // On a graph that is not registered, a missing definition fails like any other check.
  assert.deepEqual(printed(at(listing(entry({}))), { registered: false }), { definition: 'fail', synced: 'fail' });
  // Held in time: the definition is a quiet precondition on such a graph, the synced flag a pass.
  assert.deepEqual(printed([[5_000, 200, listing(entry({ accessPolicy: 'public', synced: true }))]], { registered: false }), { definition: 'quiet', synced: 'pass' });
});

test('the gap covers registered public graphs only: on a registered private graph every check is ordinary', () => {
  const lacking = { registered: true, private: true, member: true, definitionHeld: false, definitionSeen: false };
  assert.deepEqual(failed('synced', lacking), { verdict: 'fail', text: 'seen', gap: null });
  assert.deepEqual(failed('definition', lacking), { verdict: 'fail', text: 'seen', gap: null });
  assert.equal(failed('write-refused', { ...lacking, errorCode: 'CONTEXT_GRAPH_NOT_FOUND' }).verdict, 'fail');
  assert.equal(classify({ check: 'definition', outcome: 'pass', quiet: true, text: 'held', evidence: { registered: true, private: true, definitionHeld: true } }).verdict, 'quiet');
  // The same failures on a registered public graph are #3264.
  assert.equal(failed('synced', { ...lacking, private: false }).verdict, 'xfail');
  assert.equal(failed('write-refused', { ...lacking, private: false, errorCode: 'CONTEXT_GRAPH_NOT_FOUND' }).verdict, 'xfail');
  // Evidence that does not say whether the graph is private is no exemption.
  assert.equal(failed('synced', { registered: true, definitionHeld: false }).verdict, 'fail');
  // Through the listing parser and the checks, as the report composes them.
  const missing = [[30_000, 200, listing(entry({}))], [90_000, 200, listing(entry({}))]];
  assert.deepEqual(printed(missing, { isPrivate: true }), { definition: 'fail', synced: 'fail' });
  assert.deepEqual(printed(missing), { definition: 'xfail', synced: 'xfail' });
  assert.deepEqual(printed([[5_000, 200, listing(entry({ accessPolicy: 'private', synced: true }))]], { isPrivate: true }), { definition: 'quiet', synced: 'pass' });
});

test('only a member\'s refused write is #3264: the owner\'s refusal with the same code fails its case', () => {
  const lines = [];
  const report = createReport({ 1: 'owner writes', 2: 'member writes' }, { print: line => lines.push(line) });
  const graph = { key: 'registered', registered: true, private: false };
  const refused = (caseId, author) => ({
    caseId, node: { label: 'node9 (member2)' },
    record: {
      author, graph, sub: null, value: `${author.role} live root (1)`,
      error: 'the author refused the asset: HTTP 404', errorCode: 'CONTEXT_GRAPH_NOT_FOUND', definitionHeld: false, definitionHistory: { seen: false },
    },
  });
  // Through pairResult, the known gaps and the case verdicts, as the suite reports them.
  report.reportPair(refused(1, { role: 'owner', label: 'node7 (owner)', member: false }), { boundMs: 60_000 });
  report.reportPair(refused(2, { role: 'member1', label: 'node8 (member1)', member: true }), { boundMs: 60_000 });
  assert.deepEqual(report.summary('Results'), ['1']);
  assert.ok(lines.includes('  [FAIL] case 1: "owner live root (1)" by node7 (owner) in registered root at node9 (member2): not written, the author refused the asset: HTTP 404'), lines.join('\n'));
  assert.ok(lines.some(line => line.startsWith('  [XFAIL] case 2: "member1 live root (1)" by node8 (member1) in registered root at node9 (member2): not written,')), lines.join('\n'));
  // A refusal whose author is not known to be a member is no exemption either.
  assert.equal(classify({ check: 'write-refused', outcome: 'fail', text: 'seen', evidence: { registered: true, private: false, definitionHeld: false, definitionSeen: false, errorCode: 'CONTEXT_GRAPH_NOT_FOUND' } }).verdict, 'fail');
});

test('a definition lost is not #3264, only one never obtained', () => {
  // The example of the review: the definition at 5 s (accessPolicy "public"), gone and unsynced at 90 s.
  const lost = classified([[5_000, 200, listing(entry({ accessPolicy: 'public' }))], [90_000, 200, listing(entry({}))]]);
  assert.deepEqual([lost.definition.verdict, lost.synced.verdict], ['xpass', 'fail']);
  assert.equal(lost.synced.text, 'lists it as subscribed=true synced=false 90 s after it subscribed; it held the definition before and lost it, so this is not #3264');
  // Never obtained: #3264.
  assert.deepEqual(printed([[5_000, 200, listing(entry({}))], [90_000, 200, listing(entry({}))]]), { definition: 'xfail', synced: 'xfail' });
  // A definition that arrived only after the synced flag's deadline was not lost by then.
  const late = subscriptionResults({ definedAt: 75_000, syncedAt: null, atDefinitionDeadline: null, atSyncedDeadline: { readable: true, defined: false, entry: entry({}) }, done: true },
    { registered: true, private: false, member: true, definitionMs: 90_000, syncedMs: 60_000 });
  assert.deepEqual([classify(late.definition).verdict, classify(late.synced).verdict], ['xpass', 'xfail']);
  // A member's write refused after it was seen holding the definition, or with no known history, fails.
  const write = definitionSeen => failed('write-refused', { registered: true, private: false, member: true, definitionHeld: false, definitionSeen, errorCode: 'CONTEXT_GRAPH_NOT_FOUND' });
  assert.deepEqual(write(true), { verdict: 'fail', text: 'seen; the author held the definition before and lost it, so this is not #3264', gap: null });
  assert.deepEqual(write(undefined), { verdict: 'fail', text: 'seen', gap: null });
  assert.equal(write(false).verdict, 'xfail');
});
