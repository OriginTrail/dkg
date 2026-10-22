import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphScenario } from '../member-sharing/graph-scenario.mjs';
import { createGraphs } from '../member-sharing/graphs.mjs';
import { createReport } from '../member-sharing/report.mjs';

const owner = { number: 7, role: 'owner', label: 'node7 (owner)' };
const member1 = { number: 8, role: 'member1', label: 'node8 (member1)' };
const member2 = { number: 9, role: 'member2', label: 'node9 (member2)' };
const members = [member1, member2];
const PUBLIC_CASES = { history: 3, owner: 1, member: 2, definition: 3 };
const OTHER_CASES = { history: 7, owner: 7, member: 7, definition: 7 };

// The suite's I/O, recorded: each subscribe answers at the next tick of a
// clock, and every watch and observer stays pending until it is cancelled or
// the test ends it.
function fakeIo({ refuse = () => null } = {}) {
  let clock = 1000;
  const events = [];
  const pending = handle => {
    let end;
    handle.done = new Promise(resolve => { end = resolve; });
    handle.cancelled = false;
    handle.cancel = () => { handle.cancelled = true; end(handle.whenCancelled); };
    handle.finish = value => end(value);
    return handle;
  };
  const io = {
    events,
    handles: [],
    evidence: [],
    async write(author, graph, sub, what) {
      events.push(`write ${graph.key} ${what} by ${author.role}`);
      return { author, graph, sub, what };
    },
    async subscribe(node, graph) {
      const refusal = refuse(node, graph);
      events.push(`subscribe ${node.role} ${graph.key}${refusal ? ' refused' : ''}`);
      if (refusal) throw new Error(refusal);
      clock += 1000;
      return clock;
    },
    watch(pairs) {
      events.push(`watch ${pairs.map(pair => `${pair.record.graph.key}:${pair.record.sub ?? 'root'}@${pair.node.role} case ${pair.caseId} from ${pair.from}`).join(', ')}`);
      const handle = pending({ pairs, whenCancelled: undefined });
      io.handles.push(handle);
      return handle;
    },
    observeSubscription(node, graph, from) {
      events.push(`observe ${node.role} ${graph.key} from ${from}`);
      const handle = pending({ node, graph, whenCancelled: null });
      io.handles.push(handle);
      return handle;
    },
    async writeAndWatch(caseId, author, graph, sub, what, nodes, evidence) {
      events.push(`case ${caseId}: ${what} by ${author.role} in ${graph.key}${sub ? `/${sub}` : ''} -> ${nodes.map(node => node.role).join(', ')}`);
      io.evidence.push([author.role, sub, evidence]);
      return { caseId, author, nodes };
    },
  };
  return io;
}

test('a graph a member cannot join is dropped with everything pending on it, and the other graphs go on', async () => {
  const io = fakeIo({ refuse: (node, graph) => (node === member2 && graph.key === 'registered' ? 'node9 (member2) could not subscribe to registered: HTTP 503' : null) });
  const pub = new GraphScenario({ key: 'public' }, { cases: PUBLIC_CASES, authors: members, required: true, sub: 's' });
  const registered = new GraphScenario({ key: 'registered' }, { cases: OTHER_CASES, authors: [member1], sub: 's' });
  for (const scenario of [pub, registered]) await scenario.writeHistory(io, owner);
  assert.equal(await pub.subscribeMembers(io, members), null);
  assert.equal(await registered.subscribeMembers(io, members), 'node9 (member2) could not subscribe to registered: HTTP 503');
  // Each member's watch and observer start at once, at its own subscribe: member 1's before member 2 subscribes.
  assert.deepEqual(io.events, [
    'write public history root by owner',
    'write public history sub-graph by owner',
    'write registered history root by owner',
    'write registered history sub-graph by owner',
    'subscribe member1 public',
    'watch public:root@member1 case 3 from 2000, public:s@member1 case 3 from 2000',
    'observe member1 public from 2000',
    'subscribe member2 public',
    'watch public:root@member2 case 3 from 3000, public:s@member2 case 3 from 3000',
    'observe member2 public from 3000',
    'subscribe member1 registered',
    'watch registered:root@member1 case 7 from 4000, registered:s@member1 case 7 from 4000',
    'observe member1 registered from 4000',
    'subscribe member2 registered refused',
  ]);
  // Member 1's watch and observer of the dropped graph are cancelled; nothing of the public graph is.
  assert.equal(registered.active, false);
  assert.deepEqual(registered.watches.map(handle => handle.cancelled), [true]);
  assert.deepEqual(registered.observers.map(handle => handle.cancelled), [true]);
  assert.equal(pub.active, true);
  assert.deepEqual([...pub.watches, ...pub.observers].map(handle => handle.cancelled), [false, false, false, false]);
  // The dropped graph reports nothing, and no later case writes into it.
  assert.deepEqual(await registered.observedSubscriptions(), []);
  assert.deepEqual(await registered.historyWatches(), []);
  // The public graph reports its members in the order they subscribed, once their observations settle.
  pub.observers.forEach((handle, i) => handle.finish({ observed: i }));
  pub.watches.forEach(handle => handle.finish());
  assert.deepEqual((await pub.observedSubscriptions()).map(({ node, graph, observation }) => [node.role, graph.key, observation]),
    [['member1', 'public', { observed: 0 }], ['member2', 'public', { observed: 1 }]]);
  assert.equal((await pub.historyWatches()).length, 2);
  assert.deepEqual([...pub.subscribedAt.entries()].map(([node, at]) => [node.role, at]), [['member1', 2000], ['member2', 3000]]);
});

test('the graph that carries cases 1 to 6 is never dropped: a member that cannot join it stops the run', async () => {
  const io = fakeIo({ refuse: node => (node === member2 ? 'node9 (member2) could not subscribe to public: HTTP 503' : null) });
  const pub = new GraphScenario({ key: 'public' }, { cases: PUBLIC_CASES, authors: members, required: true, sub: 's' });
  await pub.writeHistory(io, owner);
  await assert.rejects(pub.subscribeMembers(io, members), /could not subscribe to public: HTTP 503/);
  assert.equal(pub.active, true);
});

test('each graph routes its live writes to its own cases and authors', async () => {
  const io = fakeIo();
  const pub = new GraphScenario({ key: 'public' }, { cases: PUBLIC_CASES, authors: members, required: true, sub: 's' });
  const registered = new GraphScenario({ key: 'registered' }, { cases: OTHER_CASES, authors: [member1], sub: 's' });
  const hidden = new GraphScenario({ key: 'private' }, { cases: OTHER_CASES, authors: [], sub: 's' });
  for (const scenario of [pub, registered, hidden]) await scenario.ownerWrites(io, owner, members);
  for (const scenario of [pub, registered, hidden]) await scenario.memberWrites(io, owner, members);
  assert.deepEqual(io.events, [
    'case 1: owner live root by owner in public -> member1, member2',
    'case 1: owner live sub-graph by owner in public/s -> member1, member2',
    'case 7: owner live root by owner in registered -> member1, member2',
    'case 7: owner live sub-graph by owner in registered/s -> member1, member2',
    'case 7: owner live root by owner in private -> member1, member2',
    'case 7: owner live sub-graph by owner in private/s -> member1, member2',
    'case 2: member1 live root by member1 in public -> owner, member2',
    'case 2: member2 live root by member2 in public -> owner, member1',
    'case 2: member1 live sub-graph by member1 in public/s -> owner, member2',
    'case 2: member2 live sub-graph by member2 in public/s -> owner, member1',
    'case 7: member1 live root by member1 in registered -> owner, member2',
    'case 7: member1 live sub-graph by member1 in registered/s -> owner, member2',
  ]);
});

test('a graph records as facts whether it is registered on chain and whether it is private', async () => {
  const devnet = {
    async api(node, method, path, body) {
      const json = path === '/api/context-graph/create'
        ? { created: body.id, registered: body.register === true, ...(body.register ? { onChainId: '7' } : {}) }
        : { created: body.subGraphName, contextGraphId: body.contextGraphId };
      return { status: 200, json, text: JSON.stringify(json) };
    },
  };
  const graphs = createGraphs(devnet, { owner: { number: 7, agentAddress: '0xowner' }, isTemporary: () => false }, { stamp: 'S', sub: 's', say: () => {} });
  const facts = async (key, body) => {
    const graph = await graphs.createGraph(key, body);
    return { private: graph.private, registered: graph.registered };
  };
  assert.deepEqual(await facts('public', { accessPolicy: 0, publishPolicy: 1, register: false }), { private: false, registered: false });
  assert.deepEqual(await facts('registered', { accessPolicy: 0, publishPolicy: 1, register: true }), { private: false, registered: true });
  // Whether a known gap applies to a registered private graph is the known gaps' decision, not this record's.
  assert.deepEqual(await facts('private', { accessPolicy: 1, publishPolicy: 0, register: true }), { private: true, registered: true });
});

test('a member\'s own writes carry its history with the definition, which they also add to', async () => {
  const io = fakeIo();
  const registered = new GraphScenario({ key: 'registered' }, { cases: OTHER_CASES, authors: members, sub: 's' });
  await registered.writeHistory(io, owner);
  assert.equal(await registered.subscribeMembers(io, members), null);
  // Not known before the subscriptions settled.
  await registered.memberWrites(io, owner, members);
  assert.deepEqual(io.evidence.map(([role, , evidence]) => [role, evidence.definitionHistory.seen]),
    [['member1', undefined], ['member2', undefined], ['member1', undefined], ['member2', undefined]]);
  // Member 1 held the definition 4 s after it subscribed; member 2 never did.
  registered.observers[0].finish({ definedAt: 4_000 });
  registered.observers[1].finish({ definedAt: null });
  await registered.observedSubscriptions();
  assert.deepEqual([registered.historyOf(member1).seen, registered.historyOf(member2).seen], [true, false]);
  // One history per member, shared by all of its writes: what is seen later reaches the earlier writes' judgement too.
  assert.equal(io.evidence[0][2].definitionHistory, registered.historyOf(member1));
  assert.equal(io.evidence[1][2].definitionHistory, registered.historyOf(member2));
});

test('a definition obtained after the subscription was observed and then lost is not #3264 (the example of the review)', async () => {
  // Neither member held the definition while its subscription was observed. Member 1 then obtains it: the node
  // accepts its root write. It loses it before its sub-graph write, which is refused as a write to an unknown graph.
  // Member 2 never obtains it: both its writes are refused.
  const graph = { key: 'registered', registered: true, private: false };
  const authors = [{ ...member1, member: true }, { ...member2, member: true }];
  const accepted = { member1: { root: true, s: false }, member2: { root: false, s: false } };
  const io = fakeIo();
  io.writeAndWatch = async (caseId, author, writtenTo, sub, what, nodes, evidence) => {
    const ok = accepted[author.role][sub ?? 'root'];
    const record = {
      author, graph: writtenTo, sub, value: `${what} (1)`, definitionHistory: evidence.definitionHistory,
      error: ok ? null : 'the author refused the asset: HTTP 404', errorCode: ok ? undefined : 'CONTEXT_GRAPH_NOT_FOUND', definitionHeld: ok ? undefined : false,
    };
    return { pairs: nodes.map(node => ({ caseId, record, node, from: 0, progress: { view: 1_000, partitions: 1_000 }, last: {} })), done: Promise.resolve() };
  };
  const scenario = new GraphScenario(graph, { cases: OTHER_CASES, authors, sub: 's' });
  await scenario.writeHistory(io, owner);
  assert.equal(await scenario.subscribeMembers(io, authors), null);
  scenario.observers.forEach(handle => handle.finish({ definedAt: null }));
  await scenario.observedSubscriptions();
  const handles = await scenario.memberWrites(io, owner, authors);
  const lines = [];
  const report = createReport({ 7: 'registered' }, { print: line => lines.push(line) });
  for (const pair of handles.flatMap(handle => handle.pairs)) report.reportPair(pair, { boundMs: 60_000 });
  const verdicts = lines.map(line => /^ {2}\[(\w+)\] case 7: "(\w+) live (root|sub-graph) \(1\)" by \S+ \S+ in \S+(?: root)? at node(\d)/.exec(line)?.slice(1)).filter(Boolean);
  assert.deepEqual(verdicts.filter(([, author]) => author === 'member1').map(([verdict, , scope]) => [verdict, scope]),
    [['PASS', 'root'], ['PASS', 'root'], ['FAIL', 'sub-graph'], ['FAIL', 'sub-graph']], lines.join('\n'));
  assert.ok(lines.filter(line => line.includes('"member1 live sub-graph (1)"')).every(line => line.endsWith('the author held the definition before and lost it, so this is not #3264')), lines.join('\n'));
  assert.deepEqual(verdicts.filter(([, author]) => author === 'member2').map(([verdict]) => verdict), ['XFAIL', 'XFAIL', 'XFAIL', 'XFAIL'], lines.join('\n'));
});
