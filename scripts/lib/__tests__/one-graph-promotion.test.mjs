import assert from 'node:assert/strict';
import test from 'node:test';
import {
  admissionPolicyProblem, countLogLines, durableStart, edgeTopologyProblems, inVerifiedScope, judgeGone, memberPublishOutcome,
  pairOutcome, parseAdmissions, profileStatusProblems, promotionOutcome, readOutcome, slotHolder, transferHeldAt, transferLifetime,
  transferOccupancy, verifiedScope, writeRetryable, busyReceiptOutcome,
} from '../qa/one-graph-promotion.mjs';
import { sharedMemoryScope } from '../qa/member-sharing.mjs';
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

test('a report has left a layer when no row of it carries the predicate', () => {
  assert.deepEqual(judgeGone([], { predicate: LABEL }), { gone: true, found: 0 });
  assert.deepEqual(judgeGone([{ p: 'urn:other', o: '"x"' }], { predicate: LABEL }), { gone: true, found: 0 });
  assert.deepEqual(judgeGone([{ p: `<${LABEL}>`, o: '"x"' }, { p: LABEL, o: '"y"' }], { predicate: LABEL }), { gone: false, found: 2 });
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

test('a report back in shared memory after it had left fails, at any reading or at the last; a reading that failed does not', () => {
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
  const unreadable = pairOf('gone', { view: 2000, partitions: 3000 }, { confirm: { view: { satisfied: false, error: 'HTTP 0 timeout' }, partitions: { satisfied: true } } });
  assert.equal(pairOutcome(unreadable, { boundMs: 60_000 }).outcome, 'pass');
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
  assert.equal(promotionOutcome({ status: 200, json: { status: 'confirmed', kaId: '7' } }, { authorAddress: author.agentAddress }).ok, true);
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
  assert.deepEqual(transferHeldAt(second33 + 3500, holding, admissions, isTransfer), { held: true, why: null });
  // No reading soon enough after the receipt.
  assert.match(transferHeldAt(second33 + 1500, holding, admissions, isTransfer).why, /no reading of the slot right after it/);
  // The admission in the slot started in the receipt's own second.
  assert.match(transferHeldAt(second33 - 200, [reading(second33 + 100, 20, [durable(700)])], admissions, isTransfer).why, /started only then/);
  // Control-plane work in the slot, or none.
  const second31 = new Date('2026-10-16T01:16:31.500').getTime();
  assert.match(transferHeldAt(second31 + 1000, [reading(second31 + 1200, 20, [durable(1200)])], admissions, isTransfer).why, /other work or none/);
  assert.match(transferHeldAt(second31 + 1000, [reading(second31 + 1200, 20, [])], admissions, isTransfer).why, /other work or none/);
  assert.match(transferHeldAt(second31, [{ at: second31 + 500, unreadable: 'HTTP 503' }], admissions, isTransfer).why, /could not be read/);
  assert.match(transferHeldAt(second33 + 3500, [reading(second33 + 4000, 600, [durable(4000)])], admissions, isTransfer).why, /could not tell/);
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
  const during = transferHeldAt(inside, [reading(inside + 300, 20, [durable(2100)])], admissions, isTransfer);
  assert.deepEqual(busyReceiptOutcome(held, { received: inside, life, held: during }),
    { outcome: 'pass', text: `${held.text}, while an admission of the transfer held the general slot` });
  // Every receipt between the two admissions (01:16:30 to 01:16:32), the slot free or holding other work:
  // the case cannot pass as exercised.
  for (const at of ['2026-10-16T01:16:30.100', '2026-10-16T01:16:31.600', '2026-10-16T01:16:32.900']) {
    const between = new Date(at).getTime();
    const evidence = transferHeldAt(between, [reading(between + 300, 20, [])], admissions, isTransfer);
    const verdict = busyReceiptOutcome(held, { received: between, life, held: evidence });
    assert.equal(verdict.outcome, 'fail', at);
    assert.match(verdict.text, /; not exercised: no reading shows the transfer holding the general slot at that moment \(the slot held other work or none\)$/);
  }
  // Slot evidence that cannot be read, or none at all, cannot pass either.
  const unread = transferHeldAt(inside, [{ at: inside + 300, unreadable: 'HTTP 503' }], admissions, isTransfer);
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
