import assert from 'node:assert/strict';
import test from 'node:test';
import {
  admissionPolicyProblem, countLogLines, durableStart, edgeTopologyProblems, identifyTransfer, inVerifiedScope, judgeGone,
  memberPublishOutcome, pairOutcome, parseAdmissions, profileStatusProblems, promotionOutcome, readOutcome, receivedWhileHeld,
  sameTransfer, transferHeldThrough, verifiedScope,
} from '../qa/one-graph-promotion.mjs';
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
    /: left shared memory 9 s after the promotion$/);
  assert.match(pairOutcome(pairOf('unpublished', { view: 100, partitions: 100 }, { fromWhat: 'refused publish', confirm: { view: { satisfied: true }, partitions: { satisfied: true } } }), { boundMs: 60_000 }).text,
    /: not in Verified Memory 60 s after the refused publish$/);
  assert.match(pairOutcome(pairOf('absent', { view: 100, partitions: 300 }, { fromWhat: 'check', boundMs: 30_000, confirm: { view: { satisfied: true }, partitions: { satisfied: true } } }), { boundMs: 60_000 }).text,
    /: not in shared memory 30 s after the check$/);
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

test('a report back in shared memory after it had left fails; a check that could not be read does not', () => {
  const back = pairOf('gone', { view: 2000, partitions: 3000 }, { fromWhat: 'promotion', confirm: { view: { satisfied: false, found: 1 }, partitions: { satisfied: true } } });
  const result = pairOutcome(back, { boundMs: 60_000 });
  assert.equal(result.outcome, 'fail');
  assert.match(result.text, /left shared memory 3 s after the promotion, but then in the shared-working-memory view of reports \(1 row\(s\) of it\) within the bound$/);
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

test('a member\'s own publish is refused unless it was confirmed, whatever the HTTP status', () => {
  assert.deepEqual(memberPublishOutcome({ status: 500, json: { error: 'publish access-policy denied' } }), { refused: true, why: 'publish access-policy denied' });
  assert.deepEqual(memberPublishOutcome({ status: 409, json: { code: 'VM_PUBLISH_PRECONDITION', error: 'x' } }), { refused: true, why: 'VM_PUBLISH_PRECONDITION: x' });
  assert.match(memberPublishOutcome({ status: 0, json: null, text: 'socket hang up' }).why, /^HTTP 0 socket hang up/);
  assert.equal(memberPublishOutcome({ status: 207, json: { status: 'confirmed', ual: 'u' } }).refused, false);
  assert.equal(memberPublishOutcome({ status: 200, json: { status: 'confirmed', ual: 'u' } }).refused, false);
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

// A transfer admitted in the second 01:16:26 (log), read 2.5 s later.
const T0 = new Date('2026-10-16T01:16:26.300').getTime();
const reading = (sentAt, latency, operations) => ({ sentAt, at: sentAt + latency, operations });
const durable = age => ({ lane: 'durable', operation: 'durable:catchup-foreground', oldestAgeMs: age });
const isTransfer = admission => admission.label.startsWith('durable:0xabc/one-graph-large-1:');

test('a reading dates the running durable work; shared-memory work beside it is not the transfer', () => {
  assert.equal(durableStart(reading(T0 + 2500, 20, [{ operation: 'shared-memory:sync-on-connect', oldestAgeMs: 900 }])), null);
  assert.equal(durableStart({ at: T0, unreadable: 'HTTP 503' }), null);
  assert.deepEqual(durableStart(reading(T0 + 2500, 20, [durable(2500), { operation: 'shared-memory:x', oldestAgeMs: 100 }])), { from: T0 - 1, to: T0 + 20, age: 2500 });
});

test('the transfer is identified only when the log ties the running durable work to it and to nothing else', () => {
  const admissions = parseAdmissions(LOG);
  const found = identifyTransfer(reading(T0 + 2500, 20, [durable(2500)]), admissions, isTransfer);
  assert.equal(found.transfer.label, 'durable:0xabc/one-graph-large-1:QP4sWZbL');
  assert.deepEqual([found.transfer.limit, found.transfer.queueLimit], [1, 0]);
  assert.match(identifyTransfer(undefined, admissions, isTransfer).why, /no reading/);
  assert.match(identifyTransfer({ at: T0, unreadable: 'HTTP 0' }, admissions, isTransfer).why, /could not be read/);
  assert.match(identifyTransfer(reading(T0 + 2500, 20, []), admissions, isTransfer).why, /no durable work/);
  assert.match(identifyTransfer(reading(T0 + 2500, 400, [durable(2500)]), admissions, isTransfer).why, /soon enough/);
  assert.match(identifyTransfer(reading(T0 + 500, 20, [durable(500)]), admissions, isTransfer).why, /less than 1 s/);
  assert.match(identifyTransfer(reading(T0 + 9000, 20, [durable(1500)]), admissions, isTransfer).why, /no durable admission/);
  // Other durable work admitted in the same second: nothing is identified.
  const rival = [...admissions, { ...admissions[0], label: 'durable:control-plane', ctx: 'x' }];
  assert.match(identifyTransfer(reading(T0 + 2500, 20, [durable(2500)]), rival, isTransfer).why, /cannot tell/);
  const other = [{ ...admissions[0], label: 'durable:0xabc/one-graph-main-1:QP4sWZbL' }];
  assert.match(identifyTransfer(reading(T0 + 2500, 20, [durable(2500)]), other, isTransfer).why, /held by other work \(durable:0xabc\/one-graph-main-1/);
  // A reserved shared-memory admission is never the slot's durable holder.
  const reserved = [{ ...admissions[0], reserved: true }];
  assert.match(identifyTransfer(reading(T0 + 2500, 20, [durable(2500)]), reserved, isTransfer).why, /no durable admission/);
});

test('a later reading shows the same transfer, other work, or too little to tell', () => {
  const { transfer } = identifyTransfer(reading(T0 + 2500, 20, [durable(2500)]), parseAdmissions(LOG), isTransfer);
  assert.equal(sameTransfer(reading(T0 + 30_000, 30, [durable(30_000)]), transfer), 'same');
  assert.equal(sameTransfer(reading(T0 + 30_000, 30, [durable(10_000)]), transfer), 'other');
  assert.equal(sameTransfer(reading(T0 + 30_000, 30, []), transfer), 'other');
  assert.equal(sameTransfer(reading(T0 + 30_000, 600, [durable(30_000)]), transfer), 'unclear');
});

test('the transfer holds the slot through a window only with readings of it all the way', () => {
  const { transfer } = identifyTransfer(reading(T0 + 2500, 20, [durable(2500)]), parseAdmissions(LOG), isTransfer);
  const from = T0 + 3000;
  const until = T0 + 8000;
  const series = (count, step = 1000, start = from, make = t => [durable(t - T0)]) => Array.from({ length: count }, (_, i) => reading(start + i * step, 20, make(start + i * step)));
  const through = transferHeldThrough({ transfer, readings: series(7), from, until });
  assert.deepEqual(through, { held: true, provenUntil: T0 + 8000 });
  assert.equal(receivedWhileHeld(T0 + 7000, through), true);
  // The transfer left the slot at the fourth reading.
  const left = transferHeldThrough({ transfer, readings: series(7, 1000, from, t => (t >= from + 3000 ? [] : [durable(t - T0)])), from, until });
  assert.deepEqual(left, { held: false, reason: 'the transfer had left the slot', provenUntil: from + 2000 });
  assert.equal(receivedWhileHeld(from + 2500, left), false);
  assert.equal(receivedWhileHeld(from + 2000, left), true);
  // Other durable work in the slot.
  const other = transferHeldThrough({ transfer, readings: series(7, 1000, from, t => [durable(t >= from + 2000 ? 100 : t - T0)]), from, until });
  assert.equal(other.reason, 'the slot was held by other durable work');
  // A gap in the readings ends the evidence.
  const gap = transferHeldThrough({ transfer, readings: [reading(from + 500, 20, [durable(from + 500 - T0)]), reading(from + 7000, 20, [durable(from + 7000 - T0)])], from, until });
  assert.match(gap.reason, /no reading of the sync slot for 7 s/);
  // An unreadable reading ends it; a slow one proves nothing but does not end it.
  const unreadable = transferHeldThrough({ transfer, readings: [reading(from, 20, [durable(from - T0)]), { at: from + 1000, unreadable: 'HTTP 503' }], from, until });
  assert.equal(unreadable.reason, 'the sync slot could not be read (HTTP 503)');
  const slow = [...series(2), reading(from + 2000, 900, [durable(from + 2000 - T0)]), ...series(4, 1000, from + 3000)];
  assert.deepEqual(transferHeldThrough({ transfer, readings: slow, from, until }), { held: true, provenUntil: T0 + 8000 });
  // No reading at or after the window's end.
  assert.equal(transferHeldThrough({ transfer, readings: series(5), from, until }).reason, 'no reading was taken at or after the end of the window');
  assert.deepEqual(transferHeldThrough({ transfer: undefined, readings: [], from, until }), { held: false, reason: 'no transfer of it was identified in a sync slot', provenUntil: null });
  assert.equal(receivedWhileHeld(from, { provenUntil: null }), false);
});
