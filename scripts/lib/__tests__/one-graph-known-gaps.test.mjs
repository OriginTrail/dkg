// Tests of the one-graph promotion suite's checks of promotions, publishes,
// subscriptions and sub-graph writes, and of the known gaps applied to them
// (scripts/lib/qa/known-gaps.mjs).

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catchupDataTriples, definitionInTime, heldAtSubscribe, memberPublishOutcome, postPromotionCheck, promotionOutcome, promotionResult,
  subGraphWriteResult, syncedAfterRemedyResult, syncedAtEndResult,
} from '../qa/one-graph-promotion.mjs';
import { freshSubscription, subscriptionResults } from '../qa/member-sharing.mjs';
import { classify, KNOWN_GAPS } from '../qa/known-gaps.mjs';
import { createReport } from '../member-sharing/report.mjs';
import { createReports } from '../one-graph/reports.mjs';
import { pollUntil } from '../one-graph/poll.mjs';
import { author, CG, LABEL, node } from './one-graph-fixtures.mjs';

test('a promotion counts once confirmed under its author\'s seal and bound to the graph', () => {
  const ok = { status: 200, json: { status: 'confirmed', ual: 'did:dkg:evm:31337/0x1/7', txHash: '0xt', authorAddress: author.agentAddress.toUpperCase().replace('0X', '0x') } };
  assert.deepEqual(promotionOutcome(ok, { authorAddress: author.agentAddress }), { ok: true, ual: 'did:dkg:evm:31337/0x1/7', txHash: '0xt' });
  assert.match(promotionOutcome({ ...ok, json: { ...ok.json, authorAddress: '0x00000000000000000000000000000000000000cc' } }, { authorAddress: author.agentAddress }).why, /under the seal of 0x0+cc, not of its author/);
  assert.equal(promotionOutcome({ status: 207, json: { status: 'confirmed', ual: 'u' }, text: '{"contextGraphError":"x"}' }, { authorAddress: author.agentAddress }).ok, false);
  assert.match(promotionOutcome({ status: 502, json: { status: 'tentative' }, text: 'did not confirm' }, { authorAddress: author.agentAddress }).why, /^HTTP 502 did not confirm/);
  assert.match(promotionOutcome({ status: 200, json: { status: 'confirmed' }, text: '{}' }, { authorAddress: author.agentAddress }).why, /without a UAL/);
  assert.equal(promotionOutcome({ status: 200, json: { status: 'confirmed', kaId: '7', authorAddress: author.agentAddress } }, { authorAddress: author.agentAddress }).ok, true);
  // An answer that names no author is no evidence of whose seal was published.
  for (const json of [{ status: 'confirmed', kaId: '7' }, { status: 'confirmed', ual: 'u', authorAddress: '' }, { status: 'confirmed', ual: 'u', authorAddress: null }]) {
    const outcome = promotionOutcome({ status: 200, json, text: JSON.stringify(json) }, { authorAddress: author.agentAddress });
    assert.equal(outcome.ok, false, JSON.stringify(json));
    assert.match(outcome.why, /^confirmed without the address of the author whose seal was published/);
  }
  assert.equal(promotionOutcome({ status: 0, json: null, text: 'fetch failed' }, { authorAddress: author.agentAddress }).ok, false);
});

test('a member\'s own publish passes the policy check only when the chain\'s publisher authorization refused it', () => {
  const denial = 'Configured publisherAddress 0x25078a933762e37E9773Cb092D8e4403f2954c95 is not authorized to publish to context graph 8.';
  assert.deepEqual(memberPublishOutcome({ status: 500, json: { error: denial } }), { verdict: 'refused', why: denial });
  // A failure for any other reason says nothing about the policy.
  for (const answer of [
    { status: 0, json: null, text: 'The operation was aborted due to timeout' },
    { status: 503, json: { code: 'CHAIN_RPC_UNAVAILABLE', error: 'all chain RPC endpoints failed', retryable: true } },
    { status: 500, json: { error: 'publish access-policy unknown' } },
    { status: 409, json: { code: 'VM_PUBLISH_PRECONDITION', error: 'No quads in shared memory for this assertion' } },
    { status: 409, json: { code: 'PUBLISH_NOT_FULL_SHARE', error: 'no complete share is resident' } },
    { status: 502, json: { status: 'tentative', error: 'VM publish did not confirm' } },
  ]) assert.equal(memberPublishOutcome(answer).verdict, 'unexercised', JSON.stringify(answer));
  assert.match(memberPublishOutcome({ status: 0, json: null, text: 'socket hang up' }).why, /^HTTP 0 socket hang up/);
  assert.equal(memberPublishOutcome({ status: 503, json: { code: 'CHAIN_RPC_UNAVAILABLE', error: 'down' } }).why, 'CHAIN_RPC_UNAVAILABLE: down');
  // A confirmed publish is the member's, whatever its HTTP status (and whatever it says).
  assert.equal(memberPublishOutcome({ status: 207, json: { status: 'confirmed', ual: 'u' } }).verdict, 'published');
  assert.equal(memberPublishOutcome({ status: 200, json: { status: 'confirmed', ual: 'u', error: denial } }).verdict, 'published');
});

const curatorNode = { label: 'node7 (curator)', agentAddress: '0x00000000000000000000000000000000000000cc' };

const subGraphRefusal = 'the author refused the asset: HTTP 500 {"error":"Sub-graph \\"reports\\" has not been registered in context graph \\"0xabc/one-graph-main-1\\". Register it first via DKGAgent.createSubGraph() or by inserting the sub-graph registration"}';

const serverRefusal = 'Sub-graph "reports" has not been registered in context graph "0xabc/one-graph-main-1". Register it first via DKGAgent.createSubGraph() or by inserting the sub-graph registration';

// A probe record as share() leaves it: the printed message, and the refusal's structured evidence.
const probeOf = (error, refusal = error ? { phase: 'create', status: 500, error: serverRefusal } : undefined) => ({
  author, graph: { key: 'main' }, sub: 'reports', value: 'edgeA write before its sub-graph (3)', error, ...(refusal ? { refusal } : {}),
});

const verdictOf = result => classify(result).verdict;

const gapOf = result => classify(result).gap?.issue ?? null;

test('#3293: a write into the sub-graph refused with HTTP 500 for the unregistered sub-graph is the known gap; anything else is not', () => {
  const refused = subGraphWriteResult({ node, graph: { key: 'main' }, record: probeOf(subGraphRefusal), listed: false });
  assert.equal(refused.check, 'sub-graph-write');
  assert.deepEqual(refused.evidence, { definitionHeld: true, subGraphListed: false, httpStatus: 500, unregisteredSubGraph: true });
  assert.match(refused.text, /^node9 \(edgeB\) could not write into main\/reports before registering the sub-graph itself \(its listing does not name it\): the author refused/);
  assert.deepEqual([verdictOf(refused), gapOf(refused)], ['xfail', '#3293']);
  // The sub-graph listed and the same refusal: not this gap.
  const listedRefused = subGraphWriteResult({ node, graph: { key: 'main' }, record: probeOf(subGraphRefusal), listed: true });
  assert.equal(verdictOf(listedRefused), 'fail');
  assert.match(classify(listedRefused).text, /the writer lists the sub-graph, so this is not #3293$/);
  // Another refusal: another status, a 500 that names no unregistered sub-graph, or a share job that failed.
  for (const [error, refusal] of [
    ['the author refused the asset: HTTP 404 {"code":"CONTEXT_GRAPH_NOT_FOUND"}', { phase: 'create', status: 404, error: 'Unknown contextGraphId', code: 'CONTEXT_GRAPH_NOT_FOUND' }],
    ['the author refused the asset: HTTP 500 {"error":"store unavailable"}', { phase: 'create', status: 500, error: 'store unavailable' }],
    ['the share job ended failed: null', { phase: 'share' }],
    // The printed message names the refusal, but the evidence does not: the message is never read.
    [subGraphRefusal, { phase: 'share' }],
  ]) assert.equal(verdictOf(subGraphWriteResult({ node, graph: { key: 'main' }, record: probeOf(error, refusal), listed: false })), 'fail', error);
  // The evidence decides, whatever the printed message looks like.
  const reworded = subGraphWriteResult({ node, graph: { key: 'main' }, record: probeOf('create refused (500)', { phase: 'create', status: 500, error: serverRefusal }), listed: false });
  assert.deepEqual([verdictOf(reworded), gapOf(reworded)], ['xfail', '#3293']);
  // The write went through: the gap's check held.
  const written = subGraphWriteResult({ node, graph: { key: 'main' }, record: probeOf(null), listed: false });
  assert.deepEqual([written.outcome, verdictOf(written), gapOf(written)], ['pass', 'xpass', '#3293']);
  // A writer that already listed the sub-graph (learned from shared-memory sync) never met the gap: a plain pass.
  const learned = subGraphWriteResult({ node, graph: { key: 'main' }, record: probeOf(null), listed: true });
  assert.deepEqual([learned.outcome, verdictOf(learned), gapOf(learned)], ['pass', 'pass', null]);
});

test('#3294: the curator\'s promotion of another Edge\'s report refused as not resident is the known gap only with the report in its shared memory', () => {
  const notResident = { status: 409, json: { code: 'ASSERTION_AUTHOR_NOT_RESIDENT', error: 'selected author 0xaa has no finalized knowledge asset with this name' }, text: '{}' };
  const memberReport = { author, graph: { key: 'main' }, sub: 'reports', value: 'edgeA report 1 (3)' };
  const refused = (heldByCurator, answer = notResident) => promotionResult({
    record: memberReport, curator: curatorNode, outcome: promotionOutcome(answer, { authorAddress: author.agentAddress }), answer, heldByCurator,
  });
  const gap = refused(true);
  assert.equal(gap.check, 'member-promotion');
  assert.deepEqual(gap.evidence, { authorIsCurator: false, heldByCurator: true, code: 'ASSERTION_AUTHOR_NOT_RESIDENT', httpStatus: 409 });
  assert.match(gap.text, /^the curator could not promote "edgeA report 1 \(3\)" by node8 \(edgeA\) in main\/reports: HTTP 409 /);
  assert.deepEqual([verdictOf(gap), gapOf(gap)], ['xfail', '#3294']);
  assert.match(classify(refused(false)).text, /the curator never held the report, so this is not #3294$/);
  assert.equal(verdictOf(refused(false)), 'fail');
  assert.equal(verdictOf(refused(true, { status: 502, json: { status: 'tentative' }, text: 'did not confirm' })), 'fail');
  // The same code with another status than the documented 409 is not the gap, nor is the share that depends on it.
  for (const status of [500, 400, 200]) {
    const odd = refused(true, { ...notResident, status });
    assert.equal(verdictOf(odd), 'fail', String(status));
    assert.match(classify(odd).text, new RegExp(`the refusal came with HTTP ${status}, not 409, so this is not #3294$`));
    const dependent = postPromotionCheck({ author, report: { ...memberReport, error: null }, promoted: false, promotion: odd });
    assert.equal(verdictOf(dependent), 'fail', String(status));
  }
  assert.deepEqual(verdictOf(postPromotionCheck({ author, report: { ...memberReport, error: null }, promoted: false, promotion: gap })), 'xfail');
  // A member's report promoted: the gap's check held.
  const confirmed = { status: 200, json: { status: 'confirmed', ual: 'did:dkg:evm:31337/0xaa/1', authorAddress: author.agentAddress } };
  const held = refused(true, confirmed);
  assert.deepEqual([held.outcome, verdictOf(held), gapOf(held)], ['pass', 'xpass', '#3294']);
  assert.equal(held.text, 'the curator promoted "edgeA report 1 (3)" by node8 (edgeA) in main/reports: did:dkg:evm:31337/0xaa/1');
  // The curator's own report is no member's: never this gap, either way.
  const own = { author: curatorNode, graph: { key: 'main' }, sub: 'reports', value: 'curator report 1 (1)' };
  const ownResult = answer => promotionResult({ record: own, curator: curatorNode, outcome: promotionOutcome(answer, { authorAddress: curatorNode.agentAddress }), answer, heldByCurator: true });
  assert.equal(ownResult(confirmed).check, 'curator-promotion');
  assert.equal(verdictOf(ownResult({ status: 200, json: { status: 'confirmed', ual: 'u', authorAddress: curatorNode.agentAddress } })), 'pass');
  assert.equal(verdictOf(ownResult(notResident)), 'fail');
});

test('#3264 covers this suite\'s subscription checks of a member that never obtains the definition', () => {
  const deadline = { readable: true, defined: false, entry: { id: 'g', subscribed: true, synced: false } };
  const observation = { ...freshSubscription(), atDefinitionDeadline: deadline, atSyncedDeadline: deadline, done: true };
  const { definition, synced } = subscriptionResults(observation, { registered: true, private: false, member: true, definitionMs: 90_000, syncedMs: 90_000 });
  assert.deepEqual([verdictOf(definition), gapOf(definition)], ['xfail', '#3264']);
  assert.deepEqual([verdictOf(synced), gapOf(synced)], ['xfail', '#3264']);
  // Held in time: the gap's check held.
  const timely = subscriptionResults({ ...freshSubscription(), definedAt: 2000, syncedAt: 3000, done: true }, { registered: true, private: false, member: true, definitionMs: 90_000, syncedMs: 90_000 });
  assert.equal(verdictOf(timely.definition), 'xpass');
  assert.ok(KNOWN_GAPS.every(gap => typeof gap.what === 'string' && gap.what.length > 0));
});

test('an expected failure of a known gap does not fail its case, and the summary names the gap', () => {
  const lines = [];
  const report = createReport({ 2: 'subscriptions', 4: 'promotion' }, { print: line => lines.push(line) });
  report.record(2, subGraphWriteResult({ node, graph: { key: 'main' }, record: probeOf(subGraphRefusal), listed: false }));
  report.pass(2, 'a report held');
  const answer = { status: 409, json: { code: 'ASSERTION_AUTHOR_NOT_RESIDENT', error: 'x' } };
  report.record(4, promotionResult({ record: { author, graph: { key: 'main' }, sub: 'reports', value: 'v' }, curator: curatorNode, outcome: promotionOutcome(answer, { authorAddress: author.agentAddress }), answer, heldByCurator: true }));
  assert.deepEqual(report.summary('Results'), []);
  assert.ok(lines.some(line => line.startsWith('  [XFAIL] case 2: node9 (edgeB) could not write into main/reports') && line.includes('expected failure: #3293')), lines.join('\n'));
  assert.ok(lines.some(line => line.startsWith('  [XFAIL] case 4: the curator could not promote') && line.includes('expected failure: #3294')), lines.join('\n'));
  assert.ok(lines.some(line => line.includes('known gap #3293') && line.includes('1 check(s) failed as expected')), lines.join('\n'));
  assert.ok(lines.some(line => line.includes('every case passed, apart from the expected failures of known gaps')), lines.join('\n'));
});

test('a refused create keeps its HTTP status and the server\'s own error, through createReports.share', async () => {
  const devnet = {
    api: async (_node, method, path) => (method === 'POST' && path === '/api/knowledge-assets'
      ? { status: 500, json: { error: serverRefusal }, text: JSON.stringify({ error: serverRefusal }) }
      : { status: 404, json: null, text: 'not used' }),
  };
  const io = createReports(devnet, { stamp: 'S', sub: 'reports', predicate: LABEL, type: 'urn:one-graph:Report', boundMs: 400, definitionMs: 1000, syncedMs: 1000, pollMs: 30 });
  const record = await io.share(author, { key: 'main', id: '0xabc/one-graph-main-1' }, 'edgeA write before its sub-graph');
  assert.match(record.error, /^the author refused the asset: HTTP 500 /);
  assert.deepEqual(record.refusal, { phase: 'create', status: 500, error: serverRefusal, code: undefined });
  assert.equal(verdictOf(subGraphWriteResult({ node, graph: { key: 'main' }, record, listed: false })), 'xfail');
});

test('case 5 runs only for an author whose report was promoted; a refused promotion leaves it not exercised', () => {
  const first = { author, graph: { key: 'main' }, sub: 'reports', value: 'edgeA report 1 (3)', error: null };
  assert.equal(postPromotionCheck({ author, report: first, promoted: true, promotion: undefined }), null);
  const refusedAnswer = { status: 409, json: { code: 'ASSERTION_AUTHOR_NOT_RESIDENT', error: 'x' } };
  const refused = promotionResult({ record: first, curator: curatorNode, outcome: promotionOutcome(refusedAnswer, { authorAddress: author.agentAddress }), answer: refusedAnswer, heldByCurator: true });
  const dependent = postPromotionCheck({ author, report: first, promoted: false, promotion: refused });
  assert.equal(dependent.check, 'post-promotion-share');
  assert.equal(dependent.outcome, 'fail');
  assert.match(dependent.text, /^node8 \(edgeA\): not exercised: its report was never promoted, so no share of it follows a promotion \(the curator could not promote/);
  assert.deepEqual([verdictOf(dependent), gapOf(dependent)], ['xfail', '#3294']);
  // A refusal for another reason, or no promotion at all: a failure, never a pass.
  const other = { status: 502, json: { status: 'tentative' }, text: 'did not confirm' };
  const failed = promotionResult({ record: first, curator: curatorNode, outcome: promotionOutcome(other, { authorAddress: author.agentAddress }), answer: other, heldByCurator: true });
  assert.equal(verdictOf(postPromotionCheck({ author, report: first, promoted: false, promotion: failed })), 'fail');
  assert.equal(verdictOf(postPromotionCheck({ author, report: { ...first, error: 'refused' }, promoted: false, promotion: undefined })), 'fail');
  // Through the report: with both authors' promotions refused, case 5 has no check that held.
  const lines = [];
  const caseReport = createReport({ 5: 'shares after promotion' }, { print: line => lines.push(line) });
  caseReport.record(5, dependent);
  caseReport.record(5, postPromotionCheck({ author: { label: 'node9 (edgeB)' }, report: first, promoted: false, promotion: failed }));
  assert.deepEqual(caseReport.summary('Results'), ['5']);
});

test('a definition shown only past its deadline does not count, however slowly the listing answered', () => {
  const from = 1_000_000;
  assert.deepEqual(definitionInTime({ ok: true, completedAt: from + 30_000 }, { from, boundMs: 90_000 }), { held: true, late: false, afterMs: 30_000 });
  // Asked at 89 s, answered at 95 s with the definition: past the 90 s.
  assert.deepEqual(definitionInTime({ ok: true, completedAt: from + 95_000 }, { from, boundMs: 90_000 }), { held: false, late: true, afterMs: 95_000 });
  assert.deepEqual(definitionInTime({ ok: true, completedAt: from + 90_000 }, { from, boundMs: 90_000 }), { held: true, late: false, afterMs: 90_000 });
  assert.deepEqual(definitionInTime({ ok: false, completedAt: from + 90_500 }, { from, boundMs: 90_000 }), { held: false, late: false, afterMs: 90_500 });
  assert.deepEqual(definitionInTime(undefined, { from, boundMs: 90_000 }), { held: false, late: false, afterMs: null });
});

// A late Edge's log around its second subscribe (run 6), with an earlier sync and another graph's beside.
const CATCHUP_LOG = [
  `[subscribe] contextGraph=${CG} includeSharedMemory=true syncMode=always-on forceCatchup=false`,
  `2026-10-16 14:49:14 sync f5ca [DKGAgent] Auto-registered sub-graph "reports" in context graph "${CG}" from SWM sync`,
  `2026-10-16 14:49:19 sync f5ca [DKGAgent] SWM sync for "${CG}": 18 data + 114 meta triples`,
  `[subscribe] contextGraph=${CG} includeSharedMemory=true syncMode=always-on forceCatchup=true`,
  `[2026-10-16T12:50:05.634Z] sync beb4 [DKGAgent] Catch-up for "${CG}": catalog-authoritative graph, legacy durable sync not attempted [DEBUG]`,
  `2026-10-16 14:50:11 sync 21c2 [DKGAgent] SWM sync for "${CG}": 0 data + 133 meta triples`,
  `2026-10-16 14:50:11 sync 21c2 [DKGAgent] SWM sync for "${CG}": materialized snapshot sha256:e9a6d9bc`,
  `2026-10-16 14:50:11 sync zzzz [DKGAgent] SWM sync for "0xabc/one-graph-large-1": 7 data + 3 meta triples`,
  `2026-10-16 14:50:12 sync c51d [DKGAgent] SWM sync for "${CG}": 0 data + 114 meta triples`,
  `2026-10-16 14:50:17 sync a2c6 [DKGAgent] Catch-up SWM pass loop for "${CG}" stopped after 1 pass(es): no-capable-peers; 7/7 snapshots from ...MBWbbV5g`,
].join('\n');

test('#3296: what a node\'s catch-up inserted after its last subscribe, from its log', () => {
  assert.deepEqual(catchupDataTriples(CATCHUP_LOG, CG), { passes: 2, data: 0 });
  assert.equal(catchupDataTriples(CATCHUP_LOG, '0xabc/never-subscribed'), null);
  assert.deepEqual(catchupDataTriples(`${CATCHUP_LOG}\n2026-10-16 14:50:20 sync b [DKGAgent] SWM sync for "${CG}": 3 data + 10 meta triples`, CG), { passes: 3, data: 3 });
  assert.deepEqual(catchupDataTriples(`[subscribe] contextGraph=${CG} includeSharedMemory=true`, CG), { passes: 0, data: 0 });
});

test('#3296: a node held the reports at its subscribe only when every read found them at its first try, right after it', () => {
  const from = 1_000_000;
  const found = sentAt => ({ lastMissSentAt: null, hit: { sentAt, completedAt: sentAt + 30 } });
  const pairAt = (dating, progress = { view: 30, partitions: 40 }) => ({ from, progress, dating });
  const prompt = pairAt({ view: found(from + 5), partitions: found(from + 6) });
  assert.equal(heldAtSubscribe([prompt, prompt]), true);
  assert.equal(heldAtSubscribe([]), false);
  assert.equal(heldAtSubscribe(undefined), false);
  // A read that missed first: the report came after the subscribe.
  assert.equal(heldAtSubscribe([prompt, pairAt({ view: { lastMissSentAt: from + 5, hit: { sentAt: from + 2005, completedAt: from + 2030 } }, partitions: found(from + 6) })]), false);
  // A first find sent long after the subscribe (the reads before it failed): not at the subscribe.
  assert.equal(heldAtSubscribe([pairAt({ view: found(from + 4000), partitions: found(from + 6) })]), false);
  // Sent 5 ms after the subscribe but answered 20 s later: the reports may have arrived meanwhile.
  assert.equal(heldAtSubscribe([pairAt({ view: { lastMissSentAt: null, hit: { sentAt: from + 5, completedAt: from + 20_000 } }, partitions: found(from + 6) })]), false);
  // A pair that never held.
  assert.equal(heldAtSubscribe([pairAt({ view: found(from + 5), partitions: { lastMissSentAt: null, hit: null } }, { view: 30, partitions: null })]), false);
});

test('#3296: a late Edge that held the reports at its subscribe, never marked synced while its catch-up inserted nothing, is the known gap', () => {
  const late = { label: 'node10 (late)' };
  const graph = { key: 'main' };
  const listed = (synced, defined = true) => ({ readable: true, entry: { subscribed: true, synced }, defined });
  const catchup = catchupDataTriples(CATCHUP_LOG, CG);
  const stuck = syncedAtEndResult({ node: late, graph, listed: listed(false), everSynced: false, heldAtSubscribe: true, catchup });
  assert.equal(stuck.text, 'node10 (late): lists main as subscribed=true synced=false at the end');
  assert.deepEqual([verdictOf(stuck), gapOf(stuck)], ['xfail', '#3296']);
  assert.match(classify(stuck).text, /; it held the graph's reports at its subscribe, and its catch-up's 2 shared-memory pass\(es\) inserted no data$/);
  // Without the gap's evidence: a plain failure.
  for (const [result, because] of [
    [syncedAtEndResult({ node: late, graph, listed: listed(false, false), everSynced: false, heldAtSubscribe: true, catchup }), /holds no definition of the graph, so this is not #3296$/],
    [syncedAtEndResult({ node: late, graph, listed: { readable: true, entry: { subscribed: false, synced: false }, defined: true }, everSynced: false, heldAtSubscribe: true, catchup }), /not subscribed to the graph, so this is not #3296$/],
    [syncedAtEndResult({ node: late, graph, listed: listed(false), everSynced: false, heldAtSubscribe: true, catchup: { passes: 2, data: 18 } }), /inserted 18 data triple\(s\), so this is not #3296$/],
    [syncedAtEndResult({ node: late, graph, listed: listed(false), everSynced: false, heldAtSubscribe: true, catchup: { passes: 0, data: 0 } }), /no shared-memory catch-up after its last subscribe/],
    [syncedAtEndResult({ node: late, graph, listed: listed(false), everSynced: false, heldAtSubscribe: true, catchup: null }), /no shared-memory catch-up after its last subscribe/],
  ]) {
    assert.equal(verdictOf(result), 'fail');
    assert.match(classify(result).text, because);
  }
  // A node listed as synced before, which lost it, is another failure; so is one whose history is not known.
  const lost = syncedAtEndResult({ node: late, graph, listed: listed(false), everSynced: true, heldAtSubscribe: true, catchup });
  assert.deepEqual([verdictOf(lost), gapOf(lost)], ['fail', null]);
  assert.match(classify(lost).text, /the node was listed as synced before and lost it, so this is not #3296$/);
  const unknown = syncedAtEndResult({ node: late, graph, listed: listed(false), everSynced: undefined, heldAtSubscribe: true, catchup });
  assert.match(classify(unknown).text, /it is not known whether the node was ever listed as synced, so this is not known to be #3296$/);
  assert.equal(verdictOf(unknown), 'fail');
  // A node that did not hold the reports at its subscribe is not in the gap's state: a plain pass or failure.
  const other = syncedAtEndResult({ node: late, graph, listed: listed(false), heldAtSubscribe: false, catchup: null });
  assert.deepEqual([verdictOf(other), gapOf(other)], ['fail', null]);
  const synced = syncedAtEndResult({ node: late, graph, listed: listed(true), heldAtSubscribe: false, catchup: null });
  assert.deepEqual([synced.text, verdictOf(synced), gapOf(synced)], ['node10 (late): lists main as synced at the end', 'pass', null]);
  // Synced in the gap's state: the gap's check held. Synced after a catch-up that inserted data: a plain pass.
  const fixed = syncedAtEndResult({ node: late, graph, listed: listed(true), everSynced: false, heldAtSubscribe: true, catchup });
  assert.deepEqual([verdictOf(fixed), gapOf(fixed)], ['xpass', '#3296']);
  assert.equal(verdictOf(syncedAtEndResult({ node: late, graph, listed: listed(true), everSynced: false, heldAtSubscribe: true, catchup: { passes: 2, data: 18 } })), 'pass');
  // A listing that cannot be read fails, whatever the node held.
  const unread = syncedAtEndResult({ node: late, graph, listed: { readable: false, why: 'HTTP 0 timeout' }, everSynced: false, heldAtSubscribe: true, catchup });
  assert.deepEqual([unread.text, verdictOf(unread)], ['node10 (late): its listing could not be read at the end (HTTP 0 timeout)', 'fail']);
  // Through the report: the expected failure does not fail case 8, and the gap is summed up.
  const lines = [];
  const caseReport = createReport({ 8: 'the synced flag of every Edge' }, { print: line => lines.push(line) });
  caseReport.record(8, stuck);
  caseReport.record(8, syncedAtEndResult({ node: { label: 'node8 (edgeA)' }, graph, listed: listed(true), heldAtSubscribe: false, catchup: null }));
  assert.deepEqual(caseReport.summary('Results'), []);
  assert.ok(lines.some(line => line.startsWith('  [XFAIL] case 8: node10 (late): lists main as subscribed=true synced=false at the end')), lines.join('\n'));
  assert.ok(lines.some(line => line.includes('known gap #3296') && line.includes('1 check(s) failed as expected')), lines.join('\n'));
});

test('#3296: snapshots a catch-up materialized are data it inserted, counted once a round; a recovery round counts too', () => {
  const op = 'f5cac4a3-28b6-4309-8e55-3458b4aba4a0';
  const materialized = [
    `[subscribe] contextGraph=${CG} includeSharedMemory=true syncMode=always-on forceCatchup=true`,
    `2026-10-16 14:50:11 sync ${op} [DKGAgent] SWM sync for "${CG}": materialized snapshot sha256:e9a6 as did:dkg:context-graph:${CG}/reports/_shared_memory/0xaa/1 (3 triples)`,
    `2026-10-16 14:50:11 sync ${op} [DKGAgent] SWM sync for "${CG}": materialized snapshot sha256:5df4 as did:dkg:context-graph:${CG}/reports/_shared_memory/0xaa/2 (3 triples)`,
    `2026-10-16 14:50:11 sync ${op} [DKGAgent] SWM sync for "${CG}": materialized 2 graph-scoped KA snapshot(s) totalling 6 triples`,
    `2026-10-16 14:50:11 sync ${op} [DKGAgent] SWM sync for "${CG}": 0 data + 114 meta triples`,
  ].join('\n');
  assert.deepEqual(catchupDataTriples(materialized, CG), { passes: 1, data: 6 });
  // The sum alone (snapshots of the exact-graph path log none each), or the snapshots alone (a round that failed before its sum).
  assert.deepEqual(catchupDataTriples(materialized.split('\n').filter((_, i) => i !== 1 && i !== 2).join('\n'), CG), { passes: 1, data: 6 });
  assert.deepEqual(catchupDataTriples(materialized.split('\n').filter((_, i) => i !== 3 && i !== 4).join('\n'), CG), { passes: 0, data: 6 });
  // A recovery round's data.
  const recovered = `${CATCHUP_LOG}\n2026-10-16 14:50:20 sync r1 [DKGAgent] SWM recovery for "${CG}" from 12D3KooWPeer: replaced 1 roots, 2 exact graphs, 4 data + 9 meta triples`;
  assert.deepEqual(catchupDataTriples(recovered, CG), { passes: 3, data: 4 });
  // The reviewer's case: snapshots totalling 3 triples, then a round of 0 data: not the gap.
  const late = { label: 'node10 (late)' };
  const listed = { readable: true, entry: { subscribed: true, synced: false }, defined: true };
  const withSnapshot = syncedAtEndResult({ node: late, graph: { key: 'main' }, listed, everSynced: false, heldAtSubscribe: true,
    catchup: catchupDataTriples(`${CATCHUP_LOG}\n2026-10-16 14:50:30 sync s1 [DKGAgent] SWM sync for "${CG}": materialized 1 graph-scoped KA snapshot(s) totalling 3 triples`, CG) });
  assert.equal(verdictOf(withSnapshot), 'fail');
  assert.match(classify(withSnapshot).text, /its catch-up inserted 3 data triple\(s\), so this is not #3296$/);
});

test('the synced flag after the remedy must show within its deadline, apart from the flag at the end', () => {
  const late = { label: 'node10 (late)' };
  const graph = { key: 'main' };
  const from = 2_000_000;
  const listed = synced => ({ readable: true, entry: { subscribed: true, synced }, defined: true });
  const catchup = catchupDataTriples(CATCHUP_LOG, CG);
  const judged = (seen, heldAtSubscribe = false) => syncedAfterRemedyResult({ node: late, graph, seen, from, boundMs: 90_000, everSynced: false, heldAtSubscribe, catchup: heldAtSubscribe ? catchup : null });
  const timely = judged({ ok: true, listed: listed(true), completedAt: from + 12_000 });
  assert.deepEqual([timely.check, timely.outcome, timely.text], ['synced-after-remedy', 'pass', 'node10 (late): lists main as synced 12 s after it subscribed again with forceCatchup']);
  // Recovery and writes went well, but the flag showed only after 120 s: a failure, whatever the node held.
  for (const held of [false, true]) {
    const slow = judged({ ok: true, listed: listed(true), completedAt: from + 120_000 }, held);
    assert.equal(slow.text, 'node10 (late): lists main as synced only 120 s after it subscribed again with forceCatchup, past the 90 s');
    assert.equal(verdictOf(slow), 'fail');
  }
  assert.match(classify(judged({ ok: true, listed: listed(true), completedAt: from + 120_000 }, true)).text, /marked synced, only late, so this is not #3296$/);
  // Never synced: #3296 with its evidence, a plain failure without.
  const never = judged({ ok: false, listed: listed(false), completedAt: from + 89_000 }, true);
  assert.equal(never.text, 'node10 (late): lists main as subscribed=true synced=false 90 s after it subscribed again with forceCatchup');
  assert.deepEqual([verdictOf(never), gapOf(never)], ['xfail', '#3296']);
  assert.deepEqual([verdictOf(judged({ ok: false, listed: listed(false), completedAt: from + 89_000 })), gapOf(judged({ ok: false, listed: listed(false), completedAt: from + 89_000 }))], ['fail', null]);
  assert.equal(verdictOf(judged({ ok: false, listed: { readable: false, why: 'HTTP 503' }, completedAt: from + 5000 }, true)), 'fail');
  // Through the report: a flag that came late fails case 8, though the flag at the end holds.
  const lines = [];
  const caseReport = createReport({ 8: 'the synced flag of every Edge' }, { print: line => lines.push(line) });
  caseReport.record(8, judged({ ok: true, listed: listed(true), completedAt: from + 120_000 }));
  caseReport.record(8, syncedAtEndResult({ node: late, graph, listed: listed(true), heldAtSubscribe: false, catchup: null }));
  assert.deepEqual(caseReport.summary('Results'), ['8']);
});

test('a deadline poll reads until just before its deadline, never a whole interval early', async () => {
  let start = Date.now();
  const sent = [];
  const missed = await pollUntil(async () => { sent.push(Date.now() - start); return { ok: false }; }, start + 500, 200, { leadMs: 50 });
  assert.equal(missed.ok, false);
  // Polls at 0, 200 and 400 ms, then once more at 450 ms, the last interval shortened to end 50 ms before the deadline.
  assert.ok(sent.length >= 4 && sent.at(-1) >= 430 && sent.at(-1) <= 500, JSON.stringify(sent));
  // What arrives in that last stretch is seen; a poll that stopped once another whole interval would pass the deadline (at 400 ms) would miss it.
  start = Date.now();
  const found = await pollUntil(async () => ({ ok: Date.now() - start >= 420, at: Date.now() - start }), start + 500, 200, { leadMs: 50 });
  assert.equal(found.ok, true, JSON.stringify(found));
  // The first poll is made even when the deadline has passed.
  let polls = 0;
  await pollUntil(async () => { polls += 1; return { ok: false }; }, Date.now() - 1000, 200);
  assert.equal(polls, 1);
});

test('#3296: snapshots a recovery committed are data it inserted, even when the recovery then stopped incomplete', () => {
  const op = '7b1c0d2e-recovery';
  const incomplete = [
    `[subscribe] contextGraph=${CG} includeSharedMemory=true syncMode=always-on forceCatchup=true`,
    `2026-10-16 14:50:11 sync s0 [DKGAgent] SWM sync for "${CG}": 0 data + 114 meta triples`,
    `2026-10-16 14:50:12 sync ${op} [DKGAgent] SWM recovery for "${CG}": committed verified snapshot sha256:aa01 as did:dkg:context-graph:${CG}/reports/_shared_memory/0xaa/1 (3 triples)`,
    `2026-10-16 14:50:13 sync ${op} [DKGAgent] SWM recovery for "${CG}" from 12D3KooWPeer: graph-scoped public snapshot fetch incomplete — skipped, will retry`,
  ].join('\n');
  assert.deepEqual(catchupDataTriples(incomplete, CG), { passes: 1, data: 3 });
  const late = { label: 'node10 (late)' };
  const listed = { readable: true, entry: { subscribed: true, synced: false }, defined: true };
  const stuck = syncedAtEndResult({ node: late, graph: { key: 'main' }, listed, everSynced: false, heldAtSubscribe: true, catchup: catchupDataTriples(incomplete, CG) });
  assert.equal(verdictOf(stuck), 'fail');
  assert.match(classify(stuck).text, /its catch-up inserted 3 data triple\(s\), so this is not #3296$/);
  // A recovery that commits its snapshots and completes counts them once, beside its summary.
  const completed = [
    `[subscribe] contextGraph=${CG} includeSharedMemory=true syncMode=always-on forceCatchup=true`,
    `2026-10-16 14:50:12 sync ${op} [DKGAgent] SWM recovery for "${CG}": committed verified snapshot sha256:aa01 as did:dkg:context-graph:${CG}/reports/_shared_memory/0xaa/1 (3 triples)`,
    `2026-10-16 14:50:12 sync ${op} [DKGAgent] SWM recovery for "${CG}": committed verified snapshot sha256:aa02 as did:dkg:context-graph:${CG}/reports/_shared_memory/0xaa/2 (3 triples)`,
    `2026-10-16 14:50:13 sync ${op} [DKGAgent] SWM recovery for "${CG}" from 12D3KooWPeer: replaced 0 roots, 2 exact graphs, 6 data + 10 meta triples`,
  ].join('\n');
  assert.deepEqual(catchupDataTriples(completed, CG), { passes: 1, data: 6 });
});
