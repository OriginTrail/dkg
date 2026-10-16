import assert from 'node:assert/strict';
import test from 'node:test';
import {
  admissionPolicyProblem, countLogLines, durableStart, edgeTopologyProblems, inVerifiedScope, judgeGone, memberPublishOutcome,
  pairOutcome, parseAdmissions, profileStatusProblems, promotionOutcome, readOutcome, slotHolder, transferHeldThrough, transferLifetime,
  transferOccupancy, verifiedScope, writeRetryable, busyReceiptOutcome, promotionResult, subGraphWriteResult, transferContended, postPromotionCheck,
  arrivalWindow, definitionInTime, judgeReport,
} from '../qa/one-graph-promotion.mjs';
import { freshSubscription, sharedMemoryScope, subscriptionResults } from '../qa/member-sharing.mjs';
import { classify, KNOWN_GAPS } from '../qa/known-gaps.mjs';
import { createReport } from '../member-sharing/report.mjs';
import { createReports } from '../one-graph/reports.mjs';
import { DEAD_DIRECT_ADDRESS, edgeEnv, edgeOverrides, inheritedDkgEnv, OVERRIDE_ENV, PROFILE_CONFIG, PROFILE_ENV, PROFILE_NAMES } from '../one-graph/profile.mjs';

const LABEL = 'urn:one-graph:label';
const CG = '0xabc/one-graph-main-20261016T120000Z-1';
const RELAY1 = '/ip4/127.0.0.1/tcp/10001/p2p/12D3KooWRelayOne';
const RELAY2 = '/ip4/127.0.0.1/tcp/10002/p2p/12D3KooWRelayTwo';

test('an Edge runs the whole profile, reserves on every relay and announces only circuits through them', () => {
  const overrides = edgeOverrides([RELAY1, RELAY2]);
  for (const [key, value] of Object.entries(PROFILE_CONFIG)) assert.equal(overrides[key], value, key);
  assert.equal(overrides.relay, RELAY1);
  assert.deepEqual(overrides.preferredRelays, [RELAY2]);
  assert.deepEqual(overrides.announceAddresses, [DEAD_DIRECT_ADDRESS, `${RELAY1}/p2p-circuit`, `${RELAY2}/p2p-circuit`]);
  assert.equal('preferredRelays' in edgeOverrides([RELAY1]), false);
  for (const relays of [[], undefined, [''], [RELAY1, null]]) assert.throws(() => edgeOverrides(relays), /at least one relay/);
});

test('an Edge gets the profile\'s variables, and every variable that would override its config empty', () => {
  const env = edgeEnv();
  for (const [name, value] of Object.entries(PROFILE_ENV)) assert.equal(env[name], value, name);
  for (const name of OVERRIDE_ENV) assert.equal(env[name], '', name);
  // An emptied variable never shadows one the profile sets.
  assert.equal(OVERRIDE_ENV.some(name => name in PROFILE_ENV), false);
  assert.deepEqual(PROFILE_NAMES, [...Object.keys(PROFILE_CONFIG), ...Object.keys(PROFILE_ENV)]);
});

test('the run names the inherited DKG variables the profile neither sets nor empties', () => {
  assert.deepEqual(inheritedDkgEnv({
    DKG_AUTH: 't', DKG_STORE_QUEUE_LIMIT: '9', DKG_SYNC_GLOBAL_MAX_INFLIGHT: '8', DKG_NETWORK: 'x', DKG_A: '1', PATH: '/bin', DEVNET_DIR: '/d',
  }), ['DKG_A', 'DKG_NETWORK']);
  assert.deepEqual(inheritedDkgEnv(undefined), []);
});

test('Verified Memory of a sub-graph is its content graph and the per-asset graphs below it, nothing else', () => {
  const scope = verifiedScope(CG, 'reports');
  const base = `did:dkg:context-graph:${CG}`;
  for (const graph of [`${base}/reports`, `<${base}/reports>`, `${base}/reports/_verifiable_memory/0xauthor/7`, { type: 'uri', value: `${base}/reports/_verifiable_memory/x` }]) {
    assert.equal(inVerifiedScope(graph, scope), true, JSON.stringify(graph));
  }
  for (const graph of [
    base, `${base}/reports/_shared_memory`, `${base}/reports/_shared_memory/0xauthor/7`, `${base}/reports/_working_memory/0xa/1`,
    `${base}/reports/assertion/0xa/name`, `${base}/reports/_meta`, `${base}/_verifiable_memory/0xa/1`, `${base}/reportsX`, `${base}/reports_verifiable_memory/x`,
  ]) assert.equal(inVerifiedScope(graph, scope), false, graph);
  const root = verifiedScope(CG);
  assert.equal(inVerifiedScope(base, root), true);
  assert.equal(inVerifiedScope(`${base}/_verifiable_memory/0xa/1`, root), true);
  assert.equal(inVerifiedScope(`${base}/reports/_verifiable_memory/0xa/1`, root), false);
});

test('a report has left a layer only when no triple of its subject is left there', () => {
  assert.deepEqual(judgeGone([]), { gone: true, found: 0 });
  // Its value gone, its body or its class still there: it has not left.
  assert.deepEqual(judgeGone([{ p: 'urn:one-graph:ReportBody', o: '"x"' }]), { gone: false, found: 1 });
  assert.deepEqual(judgeGone([{ p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'urn:one-graph:Report' }]), { gone: false, found: 1 });
  assert.deepEqual(judgeGone([{ p: `<${LABEL}>`, o: '"x"' }, { p: LABEL, o: '"y"' }]), { gone: false, found: 2 });
});

test('a read that failed satisfies no pair, not even one waiting for absence', () => {
  assert.deepEqual(readOutcome('gone', { error: 'HTTP 503' }), { satisfied: false, error: 'HTTP 503' });
  assert.deepEqual(readOutcome('unpublished', { error: 'x' }), { satisfied: false, error: 'x' });
  assert.deepEqual(readOutcome('gone', { gone: true, found: 0 }), { satisfied: true, found: 0 });
  assert.deepEqual(readOutcome('gone', { gone: false, found: 1 }), { satisfied: false, found: 1 });
  assert.deepEqual(readOutcome('vm', { held: true }), { satisfied: true });
  assert.deepEqual(readOutcome('swm', { held: false, different: '"z"' }), { satisfied: false, different: '"z"' });
  assert.throws(() => readOutcome('nowhere', { held: true }), /unknown pair kind/);
});

const author = { label: 'node8 (edgeA)', agentAddress: '0x00000000000000000000000000000000000000aa' };
const record = { author, graph: { key: 'main' }, sub: 'reports', value: 'edgeA report 1 (1)', error: null };
const node = { label: 'node9 (edgeB)' };
const pairOf = (kind, progress, extra = {}) => ({ record, node, kind, boundMs: 60_000, progress, last: { view: null, partitions: null }, ...extra });

test('a pair holds once both reads showed it, and says where and when', () => {
  assert.deepEqual(pairOutcome(pairOf('swm', { view: 1200, partitions: 2600 }), { boundMs: 60_000 }),
    { outcome: 'pass', text: '"edgeA report 1 (1)" by node8 (edgeA) in main/reports at node9 (edgeB): in shared memory 3 s after the share' });
  assert.match(pairOutcome(pairOf('vm', { view: 4000, partitions: 5000 }, { fromWhat: 'promotion' }), { boundMs: 60_000 }).text,
    /: in Verified Memory 5 s after the promotion$/);
  assert.match(pairOutcome(pairOf('gone', { view: 7000, partitions: 9000 }, { fromWhat: 'promotion', confirm: { view: { satisfied: true }, partitions: { satisfied: true } } }), { boundMs: 60_000 }).text,
    /: left shared memory 9 s after the promotion, and out of it to the end of the 60 s$/);
  assert.match(pairOutcome(pairOf('unpublished', { view: 100, partitions: 100 }, { fromWhat: 'refused publish', confirm: { view: { satisfied: true }, partitions: { satisfied: true } } }), { boundMs: 60_000 }).text,
    /: absent from Verified Memory 0 s after the refused publish, and out of it to the end of the 60 s$/);
  assert.match(pairOutcome(pairOf('absent', { view: 100, partitions: 300 }, { fromWhat: 'check', boundMs: 30_000, confirm: { view: { satisfied: true }, partitions: { satisfied: true } } }), { boundMs: 60_000 }).text,
    /: absent from shared memory 0 s after the check, and out of it to the end of the 30 s$/);
});

test('a pair that did not hold names each read that missed it and what that read last saw', () => {
  const missed = pairOf('vm', { view: 3000, partitions: null }, { fromWhat: 'promotion', last: { view: { satisfied: true }, partitions: { satisfied: false, error: 'HTTP 503 busy' } } });
  const result = pairOutcome(missed, { boundMs: 60_000 });
  assert.equal(result.outcome, 'fail');
  assert.equal(result.text, '"edgeA report 1 (1)" by node8 (edgeA) in main/reports at node9 (edgeB): NOT in Verified Memory: not in the cross-partition read (HTTP 503 busy) 60 s after the promotion (shown by the view after 3 s)');
  const still = pairOf('gone', { view: null, partitions: null }, { fromWhat: 'promotion', last: { view: { satisfied: false, found: 1 }, partitions: { satisfied: false, found: 2 } } });
  assert.equal(pairOutcome(still, { boundMs: 60_000 }).text,
    '"edgeA report 1 (1)" by node8 (edgeA) in main/reports at node9 (edgeB): STILL in the shared-working-memory view of reports (1 row(s) of it) and in the cross-partition read (2 row(s) of it) 60 s after the promotion');
  const found = pairOf('absent', { view: null, partitions: 1000 }, { fromWhat: 'late Edge subscribed', boundMs: 90_000, last: { view: { satisfied: false, found: 1 }, partitions: { satisfied: true } } });
  assert.equal(pairOutcome(found, { boundMs: 60_000 }).text,
    '"edgeA report 1 (1)" by node8 (edgeA) in main/reports at node9 (edgeB): FOUND in the shared-working-memory view of reports (1 row(s) of it) 90 s after the late Edge subscribed (absent from the cross-partition read after 1 s)');
  const inVm = pairOf('unpublished', { view: null, partitions: null }, { fromWhat: 'own publish', last: { view: { satisfied: false, found: 1 }, partitions: { satisfied: false, found: 1 } } });
  assert.match(pairOutcome(inVm, { boundMs: 60_000 }).text, /: FOUND in the verifiable-memory view of reports \(1 row\(s\) of it\) and in the cross-partition read \(1 row\(s\) of it\) 60 s after the own publish$/);
  const different = pairOf('swm', { view: null, partitions: null }, { last: { view: { satisfied: false, different: '"other"' }, partitions: null } });
  assert.match(pairOutcome(different, { boundMs: 60_000 }).text, /holds another value: "other"\) nor in the cross-partition read \(never read\) 60 s after the share$/);
});

test('a report back in shared memory after it had left fails, at any reading or at the last, and so does a last check that could not be read', () => {
  const back = pairOf('gone', { view: 2000, partitions: 3000 }, { fromWhat: 'promotion', confirm: { view: { satisfied: false, found: 1 }, partitions: { satisfied: true } } });
  const result = pairOutcome(back, { boundMs: 60_000 });
  assert.equal(result.outcome, 'fail');
  assert.match(result.text, /left shared memory 3 s after the promotion, then was in the shared-working-memory view of reports \(1 row\(s\) of it\) again when the 60 s had passed$/);
  const between = pairOf('gone', { view: 2000, partitions: 3000 }, {
    fromWhat: 'promotion', reappeared: { read: 'partitions', age: 10_400, seen: { satisfied: false, found: 2 } },
    confirm: { view: { satisfied: true }, partitions: { satisfied: true } },
  });
  assert.equal(pairOutcome(between, { boundMs: 60_000 }).text,
    '"edgeA report 1 (1)" by node8 (edgeA) in main/reports at node9 (edgeB): left shared memory 3 s after the promotion, then was in the cross-partition read (2 row(s) of it) again 10 s after it');
  const unreadable = pairOf('gone', { view: 2000, partitions: 3000 }, { fromWhat: 'promotion', confirm: { view: { satisfied: false, error: 'HTTP 0 timeout' }, partitions: { satisfied: true } } });
  assert.deepEqual(pairOutcome(unreadable, { boundMs: 60_000 }), {
    outcome: 'fail',
    text: '"edgeA report 1 (1)" by node8 (edgeA) in main/reports at node9 (edgeB): left shared memory 3 s after the promotion, but the shared-working-memory view of reports (HTTP 0 timeout) could not be read when the 60 s had passed, so the absence to the end is not known',
  });
  // No check after the bound at all (the watch was cancelled): not known either.
  assert.equal(pairOutcome(pairOf('gone', { view: 2000, partitions: 3000 }), { boundMs: 60_000 }).outcome, 'fail');
});

test('a report that was never written fails each pair of it', () => {
  const unwritten = { ...pairOf('swm', { view: null, partitions: null }), record: { ...record, error: 'the author refused the asset: HTTP 400' } };
  assert.deepEqual(pairOutcome(unwritten, { boundMs: 60_000 }), {
    outcome: 'fail', text: '"edgeA report 1 (1)" by node8 (edgeA) in main/reports at node9 (edgeB): not written, the author refused the asset: HTTP 400',
  });
});

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

test('a create refused because the graph is not ready for writes yet is retried; any other refusal is not', () => {
  for (const code of ['CONTEXT_GRAPH_NOT_WRITABLE', 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE', 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE']) {
    assert.equal(writeRetryable({ error: 'refused', code }), true, code);
  }
  for (const outcome of [{ error: 'refused', code: 'CONTEXT_GRAPH_NOT_FOUND' }, { error: 'refused' }, { error: 'job failed', code: undefined }, { doneAt: 1 }, null]) {
    assert.equal(writeRetryable(outcome), false, JSON.stringify(outcome));
  }
});

/**
 * createReports over a node whose query route answers from `present(age,
 * body)`: whether the report's subject is in the asked layer at that age (ms
 * since the start). The partitions read gets a row in the sub-graph's shared
 * memory, the view read a row of its own.
 */
function scriptedReports(present) {
  const started = Date.now();
  const cg = '0xabc/one-graph-main-1';
  const devnet = {
    api: async (_node, _method, _path, body) => {
      const rows = present(Date.now() - started, body)
        ? [{ ...(body.includeContextGraphPartitions ? { g: `${sharedMemoryScope(cg, 'reports')}/0xaa/1` } : {}), p: LABEL, o: '"r (1)"' }]
        : [];
      return { status: 200, json: null, text: JSON.stringify({ result: { type: 'bindings', bindings: rows } }) };
    },
  };
  const io = createReports(devnet, {
    stamp: 'S', sub: 'reports', predicate: LABEL, type: 'urn:one-graph:Report', boundMs: 600, definitionMs: 1000, syncedMs: 1000, pollMs: 40,
  });
  const report = { author, graph: { key: 'main', id: cg, resolved: cg }, sub: 'reports', subject: 'urn:one-graph:S:1', value: 'r (1)', doneAt: started, error: null };
  return { io, report, started };
}

test('an absence watch reads through its whole bound, and a report back in the layer before the last check fails', async () => {
  // Gone at once, back from 150 ms to 350 ms, gone again well before the bound of 600 ms ends.
  const { io, report, started } = scriptedReports(age => age >= 150 && age < 350);
  const handle = io.watch(io.pairs(4, report, [node], 'gone', { from: started, fromWhat: 'promotion', bound: 600 }));
  await handle.done;
  const [pair] = handle.pairs;
  assert.deepEqual([pair.confirm.view.satisfied, pair.confirm.partitions.satisfied], [true, true]);
  const result = pairOutcome(pair, { boundMs: 600 });
  assert.equal(result.outcome, 'fail');
  assert.match(result.text, /: left shared memory 0 s after the promotion, then was in the (shared-working-memory view of reports|cross-partition read) \(1 row\(s\) of it\) again 0 s after it$/);
});

test('an absence watch passes a report that left the layer within the bound and stayed out, and keeps its first absence', async () => {
  const { io, report, started } = scriptedReports(age => age < 200);
  const handle = io.watch(io.pairs(4, report, [node], 'gone', { from: started, fromWhat: 'promotion', bound: 600 }));
  await handle.done;
  const [pair] = handle.pairs;
  assert.equal(pair.reappeared, undefined);
  assert.ok(pair.progress.view >= 200 && pair.progress.partitions >= 200, JSON.stringify(pair.progress));
  assert.deepEqual(pairOutcome(pair, { boundMs: 600 }).outcome, 'pass');
  // A report that never left within the bound fails as still there.
  const stuck = scriptedReports(() => true);
  const kept = stuck.io.watch(stuck.io.pairs(4, stuck.report, [node], 'gone', { from: stuck.started, fromWhat: 'promotion', bound: 300 }));
  await kept.done;
  assert.match(pairOutcome(kept.pairs[0], { boundMs: 300 }).text, /: STILL in the shared-working-memory view of reports \(1 row\(s\) of it\) and in the cross-partition read \(1 row\(s\) of it\) 0 s after the promotion$/);
});

test('Edges reach each other through relays only, each reaches a Core, and none a stranger', () => {
  const edges = [
    { number: 7, label: 'node7 (curator)', peerId: 'P7' }, { number: 8, label: 'node8 (edgeA)', peerId: 'P8' },
    { number: 9, label: 'node9 (edgeB)', peerId: 'P9' }, { number: 10, label: 'node10 (late)', peerId: null },
  ];
  const corePeers = new Set(['C1', 'C2']);
  const known = new Set(['C1', 'C2', 'P7', 'P8', 'P9', 'E5']);
  const observations = new Map([
    [7, { readable: true, connections: [{ peerId: 'C1', transport: 'direct' }, { peerId: 'P8', transport: 'relayed' }] }],
    [8, { readable: true, connections: [{ peerId: 'C2', transport: 'direct' }, { peerId: 'P7', transport: 'relayed' }, { peerId: 'E5', transport: 'direct' }] }],
    [9, { readable: true, connections: [{ peerId: 'C1', transport: 'direct' }] }],
  ]);
  assert.deepEqual(edgeTopologyProblems({ observations, edges: edges.slice(0, 3), corePeers, known }),
    { problems: [], relayedPairs: ['node7 (curator) and node8 (edgeA)'] });
  observations.set(9, { readable: true, connections: [{ peerId: 'P8', transport: 'direct' }, { peerId: 'P8', transport: 'relayed' }, { peerId: 'X1234567890', transport: 'direct' }] });
  observations.set(7, { readable: false });
  assert.deepEqual(edgeTopologyProblems({ observations, edges: edges.slice(0, 3), corePeers, known }).problems, [
    'the connections of node7 (curator) could not be read',
    'node9 (edgeB) holds a direct connection to node8 (edgeA)',
    'node9 (edgeB) holds no connection to a Core',
    'node9 (edgeB) is connected to 1 peer(s) that are no node of this devnet (34567890)',
  ]);
});

test('an Edge\'s status shows the profile\'s switches as the node honours them', () => {
  assert.deepEqual(profileStatusProblems({ syncLifecycle: { syncReconcilerEnabled: false, vmReconcilerEnabled: true } }), []);
  assert.deepEqual(profileStatusProblems({ syncLifecycle: { syncReconcilerEnabled: true, vmReconcilerEnabled: false } }),
    ['its peer reconciler is on, not off', 'its VM reconciliation is off, not on']);
  assert.deepEqual(profileStatusProblems({ syncLifecycle: {} }), ['its peer reconciler is unknown, not off', 'its VM reconciliation is unknown, not on']);
  assert.deepEqual(profileStatusProblems({}), ['its status reports no sync switches']);
  assert.deepEqual(profileStatusProblems(null), ['its status reports no sync switches']);
});

const LOG = [
  '2026-10-16 01:16:26 sync e511bfb0-f48c [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:QP4sWZbL (global inflight=1/1, queued=0/0)',
  '2026-10-16 01:16:26 sync e511bfb0-f48c [DKGAgent] Syncing context graph "0xabc/one-graph-large-1" from 12D3KooW',
  '2026-10-16 01:16:27 sync 996f2627-208d [DKGAgent] Sync backpressure running shared-memory:0xabc/one-graph-main-1:cazF6csu in a reserved shared-memory slot (global inflight=1/1, queued=2/0, reserved shared-memory inflight=1/1, queued=2/16)',
  '2026-10-16 01:16:28 sync 97d57fec-bf5b [DKGAgent] Sync backpressure rejected durable:control-plane (global inflight=1/1, queued=0/0)',
  'not a log line Sync backpressure running x (global inflight=1/1, queued=0/0)',
  '2026-10-16 01:16:40 sync 11111111-2222 [DKGAgent] Sync backpressure running durable:control-plane (global inflight=1/3, queued=0/6)',
].join('\n');

test('a node log names each admission with its operation, whether it holds a reserved slot, and the general policy', () => {
  const admissions = parseAdmissions(LOG);
  assert.deepEqual(admissions.map(({ label, ctx, reserved, limit, queueLimit }) => ({ label, ctx, reserved, limit, queueLimit })), [
    { label: 'durable:0xabc/one-graph-large-1:QP4sWZbL', ctx: 'e511bfb0-f48c', reserved: false, limit: 1, queueLimit: 0 },
    { label: 'shared-memory:0xabc/one-graph-main-1:cazF6csu', ctx: '996f2627-208d', reserved: true, limit: 1, queueLimit: 0 },
    { label: 'durable:control-plane', ctx: '11111111-2222', reserved: false, limit: 3, queueLimit: 6 },
  ]);
  assert.equal(admissions[0].at, new Date('2026-10-16T01:16:26').getTime());
  assert.deepEqual(parseAdmissions(''), []);
  assert.equal(admissionPolicyProblem(admissions[0]), null);
  assert.equal(admissionPolicyProblem(admissions[2]), 'it runs 3 general sync slot(s), not one');
  assert.equal(admissionPolicyProblem({ limit: 1, queueLimit: 4 }), 'it queues up to 4 sync job(s), not none');
  assert.equal(admissionPolicyProblem({ limit: null }), 'its log names no sync policy');
  assert.equal(admissionPolicyProblem(undefined), 'its log names no sync policy');
});

test('log lines are counted within a window, each with its whole second', () => {
  const at = text => new Date(text).getTime();
  assert.equal(countLogLines(LOG, 'Sync backpressure rejected ', { from: at('2026-10-16T01:16:28.500'), until: at('2026-10-16T01:16:30') }), 1);
  assert.equal(countLogLines(LOG, 'Sync backpressure rejected ', { from: at('2026-10-16T01:16:29'), until: at('2026-10-16T01:16:30') }), 0);
  assert.equal(countLogLines(LOG, 'Sync backpressure running ', { from: 0, until: at('2026-10-16T01:16:27') }), 2);
});

// A transfer admission in the log second 01:16:26, its work dated by readings.
const T0 = new Date('2026-10-16T01:16:26.300').getTime();
const reading = (sentAt, latency, operations) => ({ sentAt, at: sentAt + latency, operations });
const durable = age => ({ lane: 'durable', operation: 'durable:catchup-foreground', oldestAgeMs: age });
const isTransfer = admission => admission.label.startsWith('durable:0xabc/one-graph-large-1:');
// A receipt dated to one moment: the window of its arrival opens and closes there.
const moment = at => ({ after: at, by: at });

test('a reading dates the running durable work; shared-memory work beside it is not the transfer', () => {
  assert.equal(durableStart(reading(T0 + 2500, 20, [{ operation: 'shared-memory:sync-on-connect', oldestAgeMs: 900 }])), null);
  assert.equal(durableStart({ at: T0, unreadable: 'HTTP 503' }), null);
  assert.deepEqual(durableStart(reading(T0 + 2500, 20, [durable(2500), { operation: 'shared-memory:x', oldestAgeMs: 100 }])), { from: T0 - 1, to: T0 + 20, age: 2500 });
});

test('a reading shows the transfer in the slot only when the log ties its durable work to the transfer and nothing else', () => {
  const admissions = parseAdmissions(LOG);
  const shown = slotHolder(reading(T0 + 2500, 20, [durable(2500)]), admissions, isTransfer);
  assert.equal(shown.state, 'transfer');
  assert.equal(shown.admission.label, 'durable:0xabc/one-graph-large-1:QP4sWZbL');
  assert.equal(slotHolder(undefined, admissions, isTransfer).state, 'unreadable');
  assert.equal(slotHolder({ at: T0, unreadable: 'HTTP 0' }, admissions, isTransfer).state, 'unreadable');
  assert.equal(slotHolder(reading(T0 + 2500, 20, []), admissions, isTransfer).state, 'other');
  assert.equal(slotHolder(reading(T0 + 2500, 400, [durable(2500)]), admissions, isTransfer).state, 'unclear');
  // Durable work the log names no admission for (its line not written yet).
  assert.equal(slotHolder(reading(T0 + 9000, 20, [durable(1500)]), admissions, isTransfer).state, 'unclear');
  // Other durable work admitted in the same second: nothing is told.
  const rival = [...admissions, { ...admissions[0], label: 'durable:control-plane', ctx: 'x' }];
  assert.equal(slotHolder(reading(T0 + 2500, 20, [durable(2500)]), rival, isTransfer).state, 'unclear');
  const other = [{ ...admissions[0], label: 'durable:0xabc/one-graph-main-1:QP4sWZbL' }];
  assert.equal(slotHolder(reading(T0 + 2500, 20, [durable(2500)]), other, isTransfer).state, 'other');
  // A reserved shared-memory admission never holds the general slot.
  assert.equal(slotHolder(reading(T0 + 2500, 20, [durable(2500)]), [{ ...admissions[0], reserved: true }], isTransfer).state, 'unclear');
});

const TRANSFER_LOG = [
  '2026-10-16 01:16:26 sync aaaa [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:QP4sWZbL (global inflight=1/1, queued=0/0)',
  '2026-10-16 01:16:29 sync aaaa [DKGAgent] Sync complete: 3011 verified triples from 12D3KooW',
  '2026-10-16 01:16:31 sync bbbb [DKGAgent] Sync backpressure running durable:control-plane (global inflight=1/1, queued=0/0)',
  '2026-10-16 01:16:33 sync cccc [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:EJfXkbMM (global inflight=1/1, queued=0/0)',
  '[2026-10-16T01:16:40.000Z] sync cccc [DKGAgent] Sync page timing (a debug line in another form) [DEBUG]',
  '2026-10-16 01:16:37 sync cccc [DKGAgent]   data: 3000 triples fetched',
  '2026-10-16 01:16:50 sync dddd [DKGAgent] unrelated work',
].join('\n');

test('the transfer lives from its first admission to the last line of its admissions\' work', () => {
  const admissions = parseAdmissions(TRANSFER_LOG);
  assert.deepEqual(transferLifetime(TRANSFER_LOG, admissions, isTransfer), {
    from: new Date('2026-10-16T01:16:26').getTime(), to: new Date('2026-10-16T01:16:37').getTime() + 999, admissions: 2,
  });
  assert.equal(transferLifetime(TRANSFER_LOG, admissions, () => false), null);
  assert.equal(transferLifetime('', [], isTransfer), null);
});

test('a receipt counts as made while the transfer held the slot only with a reading right after it that shows an older admission of it', () => {
  const admissions = parseAdmissions(TRANSFER_LOG);
  const second33 = new Date('2026-10-16T01:16:33.400').getTime();
  const holding = [reading(second33 + 4000, 20, [durable(4000)])];
  assert.deepEqual(transferHeldThrough(moment(second33 + 3500), holding, admissions, isTransfer), { held: true, why: null });
  // No reading soon enough after the receipt.
  assert.match(transferHeldThrough(moment(second33 + 1500), holding, admissions, isTransfer).why, /no reading of the slot right after it/);
  // The reading dates the running admission at 33.3 s, after the receipt at 33.2 s: not proven.
  assert.match(transferHeldThrough(moment(second33 - 200), [reading(second33 + 100, 20, [durable(200)])], admissions, isTransfer).why, /may have started after the report arrived/);
  // Dated at 32.8 s, before it (its log line came within the log lag): proven.
  assert.deepEqual(transferHeldThrough(moment(second33 - 200), [reading(second33 + 100, 20, [durable(700)])], admissions, isTransfer), { held: true, why: null });
  // Control-plane work in the slot, or none.
  const second31 = new Date('2026-10-16T01:16:31.500').getTime();
  assert.match(transferHeldThrough(moment(second31 + 1000), [reading(second31 + 1200, 20, [durable(1200)])], admissions, isTransfer).why, /other work or none/);
  assert.match(transferHeldThrough(moment(second31 + 1000), [reading(second31 + 1200, 20, [])], admissions, isTransfer).why, /other work or none/);
  assert.match(transferHeldThrough(moment(second31), [{ at: second31 + 500, unreadable: 'HTTP 503' }], admissions, isTransfer).why, /could not be read/);
  assert.match(transferHeldThrough(moment(second33 + 3500), [reading(second33 + 4000, 600, [durable(4000)])], admissions, isTransfer).why, /could not tell/);
});

test('the window\'s readings are counted by whether they show the transfer in the general slot', () => {
  const admissions = parseAdmissions(TRANSFER_LOG);
  const second26 = new Date('2026-10-16T01:16:26.400').getTime();
  const readings = [
    reading(second26 + 1000, 20, [durable(1000)]),
    reading(second26 + 2000, 20, [durable(2000)]),
    reading(second26 + 5500, 20, []),
    reading(second26 + 9000, 20, [durable(2000)]),
  ];
  assert.deepEqual(transferOccupancy({ readings, admissions, isTransfer, from: second26, until: second26 + 9100 }), { transfer: 3, total: 4 });
  assert.deepEqual(transferOccupancy({ readings, admissions, isTransfer, from: second26 + 3000, until: second26 + 6000 }), { transfer: 0, total: 1 });
});

test('a busy Edge\'s receipt passes only while an admission of the transfer held its slot', () => {
  const admissions = parseAdmissions(TRANSFER_LOG);
  const life = transferLifetime(TRANSFER_LOG, admissions, isTransfer);
  const held = { outcome: 'pass', text: '"r (1)" by node8 (edgeA) in main/reports at node9 (edgeB): in shared memory 1 s after the share' };
  // Inside the second admission (01:16:33), with a reading right after that shows it.
  const inside = new Date('2026-10-16T01:16:35.200').getTime();
  const during = transferHeldThrough(moment(inside), [reading(inside + 300, 20, [durable(2100)])], admissions, isTransfer);
  assert.deepEqual(busyReceiptOutcome(held, { received: inside, life, held: during }),
    { outcome: 'pass', text: `${held.text}, while an admission of the transfer held the general slot` });
  // Every receipt between the two admissions (01:16:30 to 01:16:32), the slot free or holding other work:
  // the case cannot pass as exercised.
  for (const at of ['2026-10-16T01:16:30.100', '2026-10-16T01:16:31.600', '2026-10-16T01:16:32.900']) {
    const between = new Date(at).getTime();
    const evidence = transferHeldThrough(moment(between), [reading(between + 300, 20, [])], admissions, isTransfer);
    const verdict = busyReceiptOutcome(held, { received: between, life, held: evidence });
    assert.equal(verdict.outcome, 'fail', at);
    assert.match(verdict.text, /; not exercised: no reading shows the transfer holding the general slot throughout the moments the report can have arrived \(the slot held other work or none\)$/);
  }
  // Slot evidence that cannot be read, or none at all, cannot pass either.
  const unread = transferHeldThrough(moment(inside), [{ at: inside + 300, unreadable: 'HTTP 503' }], admissions, isTransfer);
  assert.match(busyReceiptOutcome(held, { received: inside, life, held: unread }).text, /not exercised: .*could not be read/);
  assert.match(busyReceiptOutcome(held, { received: inside, life, held: undefined }).text, /not exercised: .*\(no reading\)$/);
  // After the transfer ended, or with no transfer at all.
  assert.match(busyReceiptOutcome(held, { received: life.to + 1, life, held: during }).text, /not exercised: the transfer of the large graph had ended by then$/);
  assert.match(busyReceiptOutcome(held, { received: inside, life: null, held: during }).text, /had ended by then$/);
  // A failed check, or a pair never received, stays as it is.
  const missed = { outcome: 'fail', text: 'NOT in shared memory' };
  assert.equal(busyReceiptOutcome(missed, { received: inside, life, held: during }), missed);
  assert.equal(busyReceiptOutcome(held, { received: null, life, held: during }), held);
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

test('a promotion\'s delivery to the busy Edge counts once the transfer held the slot between the promotion and the receipt', () => {
  const admissions = parseAdmissions(TRANSFER_LOG);
  const life = transferLifetime(TRANSFER_LOG, admissions, isTransfer);
  const promotedAt = new Date('2026-10-16T01:16:30.000').getTime();
  const receivedAt = new Date('2026-10-16T01:16:36.800').getTime();
  // The slot held by the second admission at 35.5, between the promotion and the receipt; the receipt itself
  // right after edgeB's own sync work (other durable work, or none).
  const readings = [
    reading(promotedAt + 500, 20, []),
    reading(new Date('2026-10-16T01:16:35.500').getTime(), 20, [durable(2100)]),
    reading(receivedAt + 300, 20, []),
  ];
  const contended = transferContended(promotedAt, receivedAt, readings, admissions, isTransfer);
  assert.deepEqual(contended, { held: true, why: null });
  const result = { outcome: 'pass', text: '"c (2)" by node7 (curator) in main/reports at node9 (edgeB): in Verified Memory 7 s after the promotion' };
  assert.deepEqual(busyReceiptOutcome(result, { received: receivedAt, life, held: contended, delivery: true }),
    { outcome: 'pass', text: `${result.text}, after contending with the transfer for the general slot` });
  // At the receipt itself the slot was not the transfer's: the strict rule would not have counted it.
  assert.equal(transferHeldThrough(moment(receivedAt), readings, admissions, isTransfer).held, false);
  // No reading in the window shows the transfer: not exercised.
  const idle = transferContended(promotedAt, promotedAt + 2000, readings, admissions, isTransfer);
  assert.deepEqual(idle, { held: false, why: 'none of the 1 reading(s) between them shows the transfer in the slot' });
  assert.match(busyReceiptOutcome(result, { received: promotedAt + 2000, life, held: idle, delivery: true }).text,
    /; not exercised: the transfer never held the general slot between the promotion and the delivery \(none of the 1 reading\(s\) between them shows the transfer in the slot\)$/);
  assert.deepEqual(transferContended(promotedAt, promotedAt + 100, readings, admissions, isTransfer), { held: false, why: 'no reading was taken between them' });
  // After the transfer's life, even with contention before.
  assert.match(busyReceiptOutcome(result, { received: life.to + 5, life, held: contended, delivery: true }).text, /had ended by then$/);
});

test('successive transfer admissions around a receipt: the reading must date the running one before the receipt', () => {
  // Two admissions of the transfer in the log seconds 0 and 1 (relative), a receipt at 1.1 s.
  const base = new Date('2026-10-16T01:20:00').getTime();
  const log = [
    '2026-10-16 01:20:00 sync aaaa [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:QP4sWZbL (global inflight=1/1, queued=0/0)',
    '2026-10-16 01:20:01 sync bbbb [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:EJfXkbMM (global inflight=1/1, queued=0/0)',
  ].join('\n');
  const admissions = parseAdmissions(log);
  const receivedAt = base + 1100;
  // Sent at 2.0 s, answered at 2.2 s, age 1000 ms: the running admission started between 1.0 and 1.2 s,
  // which both log lines match, and the later one may have started after the receipt.
  const straddling = reading(base + 2000, 200, [durable(1000)]);
  assert.equal(slotHolder(straddling, admissions, isTransfer).candidates.length, 2);
  assert.deepEqual(transferHeldThrough(moment(receivedAt), [straddling], admissions, isTransfer), { held: false, why: 'the transfer\'s admission in the slot may have started after the report arrived (its arrival is dated to the 0 ms before a read found it)' });
  // A reading that dates the running admission wholly before the receipt proves it.
  const before = reading(base + 2000, 20, [durable(1600)]);
  assert.deepEqual(transferHeldThrough(moment(receivedAt), [before], admissions, isTransfer), { held: true, why: null });
});

test('an absence watch fails a report whose value left the layer but whose body is still there', async () => {
  const started = Date.now();
  const cg = '0xabc/one-graph-main-1';
  const devnet = {
    api: async (_node, _method, _path, body) => {
      const rows = [{ ...(body.includeContextGraphPartitions ? { g: `${sharedMemoryScope(cg, 'reports')}/0xaa/1` } : {}), p: 'urn:one-graph:ReportBody', o: '"report 1"' }];
      return { status: 200, json: null, text: JSON.stringify({ result: { type: 'bindings', bindings: rows } }) };
    },
  };
  const io = createReports(devnet, { stamp: 'S', sub: 'reports', predicate: LABEL, type: 'urn:one-graph:Report', boundMs: 300, definitionMs: 1000, syncedMs: 1000, pollMs: 40 });
  const report = { author, graph: { key: 'main', id: cg, resolved: cg }, sub: 'reports', subject: 'urn:one-graph:S:1', value: 'r (1)', doneAt: started, error: null };
  const handle = io.watch(io.pairs(4, report, [node], 'gone', { from: started, fromWhat: 'promotion', bound: 300 }));
  await handle.done;
  assert.match(pairOutcome(handle.pairs[0], { boundMs: 300 }).text, /: STILL in the shared-working-memory view of reports \(1 row\(s\) of it\) and in the cross-partition read \(1 row\(s\) of it\) 0 s after the promotion$/);
});

test('an absence watch whose reads fail after the first absence does not pass', async () => {
  const started = Date.now();
  const cg = '0xabc/one-graph-main-1';
  const devnet = {
    api: async () => (Date.now() - started < 60
      ? { status: 200, json: null, text: JSON.stringify({ result: { type: 'bindings', bindings: [] } }) }
      : { status: 503, json: { error: 'store unavailable' }, text: '{"error":"store unavailable"}' }),
  };
  const io = createReports(devnet, { stamp: 'S', sub: 'reports', predicate: LABEL, type: 'urn:one-graph:Report', boundMs: 400, definitionMs: 1000, syncedMs: 1000, pollMs: 30 });
  const report = { author, graph: { key: 'main', id: cg, resolved: cg }, sub: 'reports', subject: 'urn:one-graph:S:1', value: 'r (1)', doneAt: started, error: null };
  const handle = io.watch(io.pairs(4, report, [node], 'gone', { from: started, fromWhat: 'promotion', bound: 400 }));
  await handle.done;
  const [pair] = handle.pairs;
  assert.notEqual(pair.progress.view, null);
  const result = pairOutcome(pair, { boundMs: 400 });
  assert.equal(result.outcome, 'fail');
  assert.match(result.text, /could not be read when the 0 s had passed, so the absence to the end is not known$/);
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

test('a quiet admission the readings show at work keeps the transfer alive; a transfer that ended does not', () => {
  // One admission at 01:16:26, no later line of its work; readings show it in the slot until 01:16:40.
  const log = '2026-10-16 01:16:26 sync aaaa [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:QP4sWZbL (global inflight=1/1, queued=0/0)';
  const admissions = parseAdmissions(log);
  const start = new Date('2026-10-16T01:16:26.300').getTime();
  const quiet = [10_000, 14_000].map(age => reading(start + age, 20, [durable(age)]));
  const byLog = transferLifetime(log, admissions, isTransfer);
  assert.equal(byLog.to, new Date('2026-10-16T01:16:26').getTime() + 999);
  const alive = transferLifetime(log, admissions, isTransfer, quiet);
  assert.equal(alive.to, start + 14_000);
  // Received a second before the last reading, as the suite reads the slot every second.
  const receivedAt = start + 13_000;
  const held = transferHeldThrough(moment(receivedAt), quiet, admissions, isTransfer);
  const result = { outcome: 'pass', text: 'r at node9 (edgeB): in shared memory 1 s after the share' };
  assert.equal(busyReceiptOutcome(result, { received: receivedAt, life: alive, held }).outcome, 'pass');
  // Judged by its log alone, the same receipt would have been called after the transfer.
  assert.match(busyReceiptOutcome(result, { received: receivedAt, life: byLog, held }).text, /had ended by then$/);
  // After the last reading of it the transfer is over: a later receipt is not exercised.
  assert.match(busyReceiptOutcome(result, { received: start + 20_000, life: alive, held }).text, /had ended by then$/);
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

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const BODY = 'urn:one-graph:ReportBody';

test('a report is held only whole: its class, its value and its body, each with the written object', () => {
  const expected = [
    { name: 'class', predicate: RDF_TYPE, iri: 'urn:one-graph:Report' },
    { name: 'value', predicate: LABEL, text: 'r (1)' },
    { name: 'body', predicate: BODY, text: 'report 1 of run S: payload' },
  ];
  const whole = [{ p: RDF_TYPE, o: 'urn:one-graph:Report' }, { p: LABEL, o: '"r (1)"' }, { p: BODY, o: '"report 1 of run S: payload"' }];
  assert.deepEqual(judgeReport(whole, expected), { held: true });
  // SPARQL-results cells, a bracketed IRI, and another predicate of the subject beside: held.
  assert.deepEqual(judgeReport([
    { p: `<${RDF_TYPE}>`, o: { type: 'uri', value: 'urn:one-graph:Report' } }, { p: { type: 'uri', value: LABEL }, o: { type: 'literal', value: 'r (1)' } },
    whole[2], { p: 'urn:x:other', o: '"x"' },
  ], expected), { held: true });
  // The value alone: the class and the body were lost.
  assert.deepEqual(judgeReport([whole[1]], expected), { held: false, missing: ['class', 'body'] });
  assert.deepEqual(judgeReport([], expected), { held: false, missing: ['class', 'value', 'body'] });
  // An altered body, a class given as a text, a second value beside the written one.
  assert.deepEqual(judgeReport([whole[0], whole[1], { p: BODY, o: '"report 1 of run S: pay"' }], expected), { held: false, different: 'its body "report 1 of run S: pay"' });
  assert.deepEqual(judgeReport([{ p: RDF_TYPE, o: '"urn:one-graph:Report"' }, whole[1], whole[2]], expected), { held: false, different: 'its class "urn:one-graph:Report"' });
  assert.deepEqual(judgeReport([...whole, { p: LABEL, o: '"r (2)"' }], expected), { held: false, different: 'its value "r (2)"' });
  assert.deepEqual(readOutcome('vm', judgeReport([whole[1]], expected)), { satisfied: false, missing: ['class', 'body'] });
});

// A node whose layers hold what `layers()` answers ({ swm, vm }: quads as written, or null), behind the create and share routes.
function layeredNode(cg, layers) {
  const written = [];
  const rowsOf = (quads, graph) => (quads ?? []).map(quad => ({ ...(graph ? { g: graph } : {}), p: quad.predicate, o: quad.object }));
  const api = async (_node, method, path, body) => {
    if (method === 'POST' && path === '/api/knowledge-assets') {
      written.push(...body.quads);
      return { status: 200, json: {}, text: '{}' };
    }
    if (method === 'POST' && path.endsWith('/swm/share-async')) return { status: 200, json: { jobId: 'j1' }, text: '{"jobId":"j1"}' };
    if (method === 'GET' && path.startsWith('/api/knowledge-assets/swm/share-jobs/')) return { status: 200, json: { state: 'succeeded' }, text: '{"state":"succeeded"}' };
    if (path !== '/api/query') return { status: 404, json: null, text: 'not used' };
    const { swm, vm } = layers();
    const rows = body.view === 'shared-working-memory' ? rowsOf(swm)
      : body.view === 'verifiable-memory' ? rowsOf(vm)
        : [...rowsOf(swm, `${sharedMemoryScope(cg, 'reports')}/0xaa/1`), ...rowsOf(vm, `did:dkg:context-graph:${cg}/reports/_verifiable_memory/1`)];
    return { status: 200, json: null, text: JSON.stringify({ result: { type: 'bindings', bindings: rows } }) };
  };
  return { written, api };
}

test('a placement check needs the whole report in the layer, as share() wrote it: class, value and body', async () => {
  const cg = '0xabc/one-graph-main-1';
  let layers = { swm: null, vm: null };
  const stub = layeredNode(cg, () => layers);
  const io = createReports({ api: stub.api }, { stamp: 'S', sub: 'reports', predicate: LABEL, type: 'urn:one-graph:Report', boundMs: 300, definitionMs: 1000, syncedMs: 1000, pollMs: 30 });
  const record = await io.share(author, { key: 'main', id: cg, resolved: cg }, 'r');
  assert.equal(record.error, null);
  assert.deepEqual(stub.written.map(quad => quad.predicate), [RDF_TYPE, LABEL, BODY]);
  const whole = stub.written;
  const placed = async kind => {
    const handle = io.watch(io.pairs(4, record, [node], kind, { from: Date.now(), bound: 300 }));
    await handle.done;
    return pairOutcome(handle.pairs[0], { boundMs: 300 });
  };
  layers = { swm: whole, vm: null };
  assert.equal((await placed('swm')).outcome, 'pass');
  // Only the value in shared memory: its class and body were lost.
  layers = { swm: whole.filter(quad => quad.predicate === LABEL), vm: null };
  const partial = await placed('swm');
  assert.equal(partial.outcome, 'fail');
  assert.match(partial.text, /NOT in shared memory: not in the shared-working-memory view of reports \(without its class and its body\) nor in the cross-partition read \(without its class and its body\)/);
  // Verified Memory with an altered body, then whole.
  layers = { swm: null, vm: whole.map(quad => (quad.predicate === BODY ? { ...quad, object: '"report 1 of run S: cut"' } : quad)) };
  const altered = await placed('vm');
  assert.equal(altered.outcome, 'fail');
  assert.match(altered.text, /NOT in Verified Memory: not in the verifiable-memory view of reports \(holds another value: its body "report 1 of run S: cut"\)/);
  layers = { swm: null, vm: whole.filter(quad => quad.predicate !== RDF_TYPE) };
  assert.match((await placed('vm')).text, /\(without its class\)/);
  layers = { swm: null, vm: whole };
  assert.equal((await placed('vm')).outcome, 'pass');
});

test('a report\'s arrival is dated between the last read that missed it and the first that found it', () => {
  assert.equal(arrivalWindow(null), null);
  assert.equal(arrivalWindow({ view: { lastMissSentAt: 100, hit: null }, partitions: { lastMissSentAt: 100, hit: null } }), null);
  const view = { lastMissSentAt: 1000, hit: { sentAt: 1250, completedAt: 1300 } };
  assert.deepEqual(arrivalWindow({ view, partitions: { lastMissSentAt: 1100, hit: { sentAt: 1350, completedAt: 1400 } } }), { after: 1000, by: 1300 });
  // A read that lags still missed it after the other found it: the window keeps the earlier miss.
  assert.deepEqual(arrivalWindow({ view, partitions: { lastMissSentAt: 1350, hit: { sentAt: 1600, completedAt: 1650 } } }), { after: 1000, by: 1300 });
  // Found at a read's first try, with no miss before: the window has no opening.
  assert.deepEqual(arrivalWindow({ view, partitions: { lastMissSentAt: null, hit: { sentAt: 1250, completedAt: 1290 } } }), { after: null, by: 1290 });
  assert.match(transferHeldThrough({ after: null, by: 1290 }, [], [], isTransfer).why, /could not be dated/);
  assert.match(transferHeldThrough(null, [], [], isTransfer).why, /never dated/);
});

// The local log stamp of a moment, as the daemon writes it (`YYYY-MM-DD HH:MM:SS`).
const pad = n => String(n).padStart(2, '0');
const logStamp = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

test('a report read only once an admission had started is not evidence of the busy slot: its arrival is dated by the reads around it', async () => {
  // The report is in edgeB's shared memory from 300 ms on. Each query is answered as of 20 ms after it was
  // sent and comes back 180 ms after it was sent, so the first read that finds it completes well after 300 ms.
  const cg = '0xabc/one-graph-main-1';
  let t0 = 0;
  const arrival = () => t0 + 300;
  const devnet = {
    api: async (_node, _method, _path, body) => {
      const seenAt = Date.now() + 20;
      await new Promise(resolve => setTimeout(resolve, 180));
      const present = seenAt >= arrival();
      const rows = present ? [
        { p: RDF_TYPE, o: 'urn:one-graph:Report' }, { p: LABEL, o: '"r (1)"' }, { p: BODY, o: '"report 1 of run S: payload"' },
      ].map(row => ({ ...(body.includeContextGraphPartitions ? { g: `${sharedMemoryScope(cg, 'reports')}/0xaa/1` } : {}), ...row })) : [];
      return { status: 200, json: null, text: JSON.stringify({ result: { type: 'bindings', bindings: rows } }) };
    },
  };
  const io = createReports(devnet, { stamp: 'S', sub: 'reports', predicate: LABEL, type: 'urn:one-graph:Report', boundMs: 2000, definitionMs: 1000, syncedMs: 1000, pollMs: 30 });
  const report = {
    author, graph: { key: 'main', id: cg, resolved: cg }, sub: 'reports', subject: 'urn:one-graph:S:1', value: 'r (1)', doneAt: null, error: null,
    triples: [
      { name: 'class', predicate: RDF_TYPE, iri: 'urn:one-graph:Report' }, { name: 'value', predicate: LABEL, text: 'r (1)' },
      { name: 'body', predicate: BODY, text: 'report 1 of run S: payload' },
    ],
  };
  t0 = Date.now();
  const window = arrivalWindow(await io.dateArrival(node, report, 'swm', { everyMs: 50, untilMs: 3000 }).done);
  assert.ok(window.after < arrival() && arrival() <= window.by, JSON.stringify({ window, arrival: arrival() }));
  assert.ok(window.by >= arrival() + 160, 'the read that found it completed long after the arrival');
  // The transfer's admission started at 350 ms, after the report arrived and before the read completed;
  // a reading right after the read shows it running.
  const startedAt = t0 + 350;
  const admissions = parseAdmissions(`${logStamp(startedAt)} sync aaaa [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:QP4sWZbL (global inflight=1/1, queued=0/0)`);
  const after = reading(window.by + 100, 20, [durable(window.by + 100 - startedAt)]);
  assert.equal(slotHolder(after, admissions, isTransfer).state, 'transfer');
  // Dated by the read's completion alone, the receipt would have counted; dated by the reads around it, it does not.
  assert.deepEqual(transferHeldThrough(moment(window.by), [after], admissions, isTransfer), { held: true, why: null });
  const evidence = transferHeldThrough(window, [after], admissions, isTransfer);
  assert.equal(evidence.held, false);
  assert.match(evidence.why, /may have started after the report arrived/);
  // An admission that was running before the reads could have missed the report holds the slot throughout.
  const earlier = t0 - 500;
  const longAdmission = parseAdmissions(`${logStamp(earlier)} sync bbbb [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:EJfXkbMM (global inflight=1/1, queued=0/0)`);
  assert.deepEqual(transferHeldThrough(window, [reading(window.by + 100, 20, [durable(window.by + 100 - earlier)])], longAdmission, isTransfer), { held: true, why: null });
});

test('a promotion\'s delivery contended with the transfer only on readings answered before the last read that missed it', () => {
  const admissions = parseAdmissions(TRANSFER_LOG);
  const promotedAt = new Date('2026-10-16T01:16:30.000').getTime();
  const busy = reading(new Date('2026-10-16T01:16:35.500').getTime(), 20, [durable(2100)]);
  // The last read that missed the delivery was sent at 35.0 s: the reading at 35.5 s may show the slot after it.
  assert.deepEqual(transferContended(promotedAt, new Date('2026-10-16T01:16:35.000').getTime(), [busy], admissions, isTransfer), { held: false, why: 'no reading was taken between them' });
  assert.deepEqual(transferContended(promotedAt, new Date('2026-10-16T01:16:36.000').getTime(), [busy], admissions, isTransfer), { held: true, why: null });
  // A reading sent before the promotion does not count either; a delivery never dated has no evidence.
  assert.deepEqual(transferContended(busy.sentAt + 1, busy.at + 1000, [busy], admissions, isTransfer), { held: false, why: 'no reading was taken between them' });
  assert.match(transferContended(promotedAt, null, [busy], admissions, isTransfer).why, /could not be dated/);
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
