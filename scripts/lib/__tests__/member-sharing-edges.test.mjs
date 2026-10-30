import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeLargeGraph } from '../member-sharing/busy-member.mjs';
import { openDevnet } from '../member-sharing/devnet.mjs';
import { createGraphs } from '../member-sharing/graphs.mjs';
import { auditFeederIsolation } from '../member-sharing/feeder-isolation.mjs';
import { TemporaryEdges } from '../member-sharing/temporary-edges.mjs';

const MARK = '.issue-3251-member-sharing';

/**
 * A devnet folder whose devnet.sh is a fake that does what addnode does: it
 * refuses a folder that exists, creates the folder with one mkdir, writes the
 * caller's mark into it first, and then starts the node. `duringAddnode` runs
 * at the start of each addnode, as another suite might; `readiness(number)`
 * says how the start ends: 'ready', 'failed', or 'hang' (until it is
 * cancelled); `stopStatus(number)` is the exit status of an asynchronous
 * stop-node (0). Every call is kept.
 */
function fakeDevnet(t, { duringAddnode = () => {}, readiness = () => 'ready', stopStatus = () => 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-edges-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const nodeDir = node => join(dir, `node${typeof node === 'object' ? node.number : node}`);
  return {
    dir, calls, nodeDir,
    async devnetSh(args, env = {}, timeoutMs, { signal } = {}) {
      calls.push(args.join(' '));
      if (args[0] === 'stop-node') return { status: stopStatus(Number(args[1])), output: '' };
      if (args[0] !== 'addnode') return { status: 0, output: '' };
      const number = Number(args[1]);
      duringAddnode(number);
      try { mkdirSync(nodeDir(number)); } catch { return { status: 1, output: `[devnet] node${number} already exists` }; }
      if (env.DEVNET_ADDNODE_MARK_NAME) writeFileSync(join(nodeDir(number), env.DEVNET_ADDNODE_MARK_NAME), `${env.DEVNET_ADDNODE_MARK_TEXT}\n`);
      writeFileSync(join(nodeDir(number), 'config.json'), '{"ours":true}');
      const end = readiness(number);
      if (end === 'failed') return { status: 1, output: `[devnet] node${number} did not become ready` };
      if (end === 'hang') {
        return new Promise(resolve => {
          signal?.addEventListener('abort', () => { calls.push(`cancelled addnode ${number}`); resolve({ status: null, output: 'killed' }); }, { once: true });
        });
      }
      return { status: 0, output: '' };
    },
    devnetShSync(args) { calls.push(args.join(' ')); return { status: 0, output: '' }; },
    listening: () => false,
    nodePorts: () => [],
    async api(node) { return { status: 200, json: { peerId: `peer-${node.number}`, agentAddress: `0x${node.number}` }, text: '' }; },
    logFile: node => join(nodeDir(node), 'daemon.log'),
  };
}
const foreign = (devnet, number) => {
  mkdirSync(devnet.nodeDir(number));
  writeFileSync(join(devnet.nodeDir(number), 'config.json'), '{"theirs":true}');
};
const untouched = (devnet, number) => existsSync(devnet.nodeDir(number))
  && readFileSync(join(devnet.nodeDir(number), 'config.json'), 'utf8') === '{"theirs":true}'
  && !existsSync(join(devnet.nodeDir(number), MARK));

test('a fourth free node number is kept for the feeder of case 6\'s later attempts, which runs only while it is needed', async t => {
  const log = { say() {}, note() {} };
  const devnet = fakeDevnet(t);
  const edges = new TemporaryEdges(devnet, { stamp: 'S', log });
  assert.deepEqual(edges.allocate({ relay1: 'r1', relay2: 'r2' }), { taken: [] });
  assert.deepEqual([edges.owner, edges.member1, edges.member2, edges.feeder].map(node => node.number), [7, 8, 9, 10]);
  // Until it is started the owner writes the large graphs, as before.
  assert.equal(edges.largeAuthor, edges.owner);
  for (const node of edges.nodes) await edges.start(node);
  assert.ok(!devnet.calls.includes('addnode 10 edge'));
  await edges.prepareLargeGraphAuthor(2, async () => {});
  assert.ok(devnet.calls.includes('addnode 10 edge') && edges.feederUp);
  assert.equal(edges.largeAuthor, edges.feeder);
  await edges.finishFeeder(async () => {}, error => { throw error; });
  assert.ok(devnet.calls.includes('stop-node 10') && !edges.feederUp);
  assert.equal(edges.largeAuthor, edges.owner);
  // The cleanup removes it with the others.
  edges.cleanup({ keep: false, failed: false });
  assert.ok(!existsSync(devnet.nodeDir(10)));
  // It reserves on member 2's relay and announces only that circuit: member 2 reaches it as it reaches the owner.
  assert.deepEqual({ label: edges.feeder.label, relay: edges.feeder.relay, member: edges.feeder.member, overrides: edges.feeder.overrides }, {
    label: 'node10 (feeder)', relay: 'r2', member: false, overrides: { relay: 'r2', announceAddresses: ['/ip4/127.0.0.1/tcp/9', 'r2/p2p-circuit'] },
  });
  // It is a temporary node, but no participant of the other cases' graphs.
  assert.ok(!edges.isTemporary(10) && !edges.nodes.includes(edges.feeder), 'a reserved number without a claim is not excluded');
  assert.deepEqual([edges.owner, edges.member1, edges.member2].map(node => node.member), [false, true, true]);
  // Node 10 taken by another suite: no feeder, the owner holds the large graphs.
  const crowded = fakeDevnet(t);
  foreign(crowded, 10);
  const without = new TemporaryEdges(crowded, { stamp: 'S', log });
  assert.deepEqual(without.allocate({ relay1: 'r1', relay2: 'r2' }), { taken: ['node10: its folder exists'] });
  assert.equal(without.feeder, null);
  assert.equal(without.largeAuthor, without.owner);
  // A feeder whose start fails leaves the owner to write the large graphs.
  const failing = fakeDevnet(t, { readiness: number => (number === 10 ? 'failed' : 'ready') });
  const fallback = new TemporaryEdges(failing, { stamp: 'S', log });
  fallback.allocate({ relay1: 'r1', relay2: 'r2' });
  assert.equal(await fallback.prepareLargeGraphAuthor(2, async () => {}), fallback.owner);
  assert.equal(fallback.largeAuthor, fallback.owner);
  // One that started but that member 2 cannot dial is stopped again.
  const undialable = fakeDevnet(t);
  const dialFails = new TemporaryEdges(undialable, { stamp: 'S', log });
  dialFails.allocate({ relay1: 'r1', relay2: 'r2' });
  dialFails.dial = async () => { throw new Error('node9 (member2) could not dial the feeder through the relay: HTTP 0 refused'); };
  assert.equal(await dialFails.prepareLargeGraphAuthor(2, async () => {}), dialFails.owner);
  assert.ok(undialable.calls.includes('stop-node 10') && !dialFails.feederUp && !dialFails.feederRunning);
  assert.equal(dialFails.largeAuthor, dialFails.owner);
  // A stop that fails leaves the feeder marked running, and a second stopFeeder stops it.
  let stops = 0;
  const stubborn = fakeDevnet(t, { stopStatus: number => (number === 10 && ++stops === 1 ? 1 : 0) });
  const once = new TemporaryEdges(stubborn, { stamp: 'S', log });
  once.allocate({ relay1: 'r1', relay2: 'r2' });
  await once.prepareLargeGraphAuthor(2, async () => {});
  await once.finishFeeder(async () => {}, error => { throw error; });
  assert.deepEqual(stubborn.calls.filter(call => call === 'stop-node 10'), ['stop-node 10', 'stop-node 10']);
  assert.ok(!once.feederRunning && !once.feederUp);
  assert.equal(once.largeAuthor, once.owner);
  // MEMBER_SHARING_NODES names three numbers, or four with the feeder's.
  const three = new TemporaryEdges(fakeDevnet(t), { stamp: 'S', log });
  assert.deepEqual(three.allocate({ explicit: '10,9,8', relay1: 'r1', relay2: 'r2' }), { taken: [] });
  assert.deepEqual([three.owner.number, three.feeder], [10, null]);
  const four = new TemporaryEdges(fakeDevnet(t), { stamp: 'S', log });
  assert.deepEqual(four.allocate({ explicit: '10,9,8,7', relay1: 'r1', relay2: 'r2' }), { taken: [] });
  assert.equal(four.feeder.number, 7);
  assert.match(new TemporaryEdges(fakeDevnet(t), { stamp: 'S', log }).allocate({ explicit: '7,8', relay1: 'r1', relay2: 'r2' }).problem,
    /MEMBER_SHARING_NODES must name three or four/);
});

test('each later attempt of case 6 gets a fresh feeder: the one that ran is stopped and its folder removed before a new one starts', async t => {
  const log = { say() {}, note() {} };
  const devnet = fakeDevnet(t);
  const edges = new TemporaryEdges(devnet, { stamp: 'S', log });
  edges.allocate({ relay1: 'r1', relay2: 'r2' });
  await edges.prepareLargeGraphAuthor(2, async () => {});
  writeFileSync(join(devnet.nodeDir(10), 'held-large-graph'), 'the large graph of the attempt before');
  const stopsBefore = devnet.calls.filter(call => call === 'stop-node 10').length;
  assert.equal(await edges.prepareLargeGraphAuthor(3, async () => {}), edges.feeder);
  assert.equal(devnet.calls.filter(call => call === 'stop-node 10').length, stopsBefore + 1, 'renewal stops exactly once');
  assert.deepEqual(devnet.calls.filter(call => /^(addnode|stop-node) 10/.test(call)), ['addnode 10 edge', 'stop-node 10', 'addnode 10 edge']);
  assert.ok(!existsSync(join(devnet.nodeDir(10), 'held-large-graph')), 'the new feeder holds nothing of the old one');
  assert.ok(edges.feederRunning && edges.feederUp && edges.feeder.peerId === 'peer-10');
  assert.equal(edges.largeAuthor, edges.feeder);
  // A feeder that cannot be stopped is not replaced.
  let stops = 0;
  const stuck = fakeDevnet(t, { stopStatus: () => (++stops >= 1 ? 1 : 0) });
  const stubborn = new TemporaryEdges(stuck, { stamp: 'S', log });
  stubborn.allocate({ relay1: 'r1', relay2: 'r2' });
  await stubborn.prepareLargeGraphAuthor(2, async () => {});
  assert.equal(await stubborn.prepareLargeGraphAuthor(3, async () => {}), stubborn.owner);
  assert.equal(stuck.calls.filter(call => call === 'addnode 10 edge').length, 1);
  assert.ok(stubborn.feederRunning);
});

test('a number another suite took while the feeder was replaced is left to that suite: the cleanup neither stops nor removes its node', async t => {
  const says = [];
  // Another suite's addnode takes node 10 after the old feeder's folder was removed, before the new feeder's addnode.
  let adds = 0;
  const devnet = fakeDevnet(t, { duringAddnode: number => { if (number === 10 && ++adds === 2) foreign(devnet, 10); } });
  const edges = new TemporaryEdges(devnet, { stamp: 'S', log: { say: line => says.push(line), note() {} } });
  edges.allocate({ relay1: 'r1', relay2: 'r2' });
  for (const node of edges.nodes) await edges.start(node);
  await edges.prepareLargeGraphAuthor(2, async () => {});
  assert.equal(await edges.prepareLargeGraphAuthor(3, async () => {}), edges.owner);
  assert.ok(!edges.started.includes(edges.feeder) && !edges.feederRunning && !edges.feederUp);
  assert.equal(edges.largeAuthor, edges.owner);
  // Nor does the cleanup take a folder for this run's that lost its claim some other way (removed from outside, and taken).
  rmSync(devnet.nodeDir(9), { recursive: true, force: true });
  foreign(devnet, 9);
  const before = devnet.calls.length;
  edges.cleanup({ keep: false, failed: true });
  assert.ok(untouched(devnet, 10) && untouched(devnet, 9));
  assert.deepEqual(devnet.calls.slice(before), ['stop-node 7', 'stop-node 7', 'stop-node 8', 'stop-node 8']);
  assert.ok(!existsSync(devnet.nodeDir(7)) && !existsSync(devnet.nodeDir(8)));
  assert.deepEqual(says, ['node9 is not this run\'s any more; it is left as it is']);
});

test('a node another suite took after it was picked is left untouched, and the cleanup removes only nodes this run added', async t => {
  const devnet = fakeDevnet(t);
  const edges = new TemporaryEdges(devnet, { stamp: 'S', log: { say() {}, note() {} } });
  assert.deepEqual(edges.allocate({ relay1: 'r1', relay2: 'r2' }), { taken: [] });
  await edges.start(edges.owner);
  await edges.start(edges.member1);
  // Another suite creates node 9 while this one starts its earlier nodes.
  foreign(devnet, 9);
  await assert.rejects(edges.start(edges.member2), /node9 was taken after it was picked: its folder exists, and it is left as it is/);
  assert.ok(!devnet.calls.includes('addnode 9 edge'));
  edges.cleanup({ keep: false, failed: true });
  assert.ok(untouched(devnet, 9));
  assert.ok(!devnet.calls.some(call => call === 'stop-node 9'), devnet.calls.join(', '));
  assert.ok(!existsSync(devnet.nodeDir(7)) && !existsSync(devnet.nodeDir(8)));
});

test('a node another suite created while addnode ran is left untouched: a refused addnode marks nothing', async t => {
  const devnet = fakeDevnet(t, { duringAddnode: number => { if (number === 9) foreign(devnet, 9); } });
  const edges = new TemporaryEdges(devnet, { stamp: 'S', log: { say() {}, note() {} } });
  edges.allocate({ relay1: 'r1', relay2: 'r2' });
  await edges.start(edges.owner);
  await edges.start(edges.member1);
  await assert.rejects(edges.start(edges.member2), /temporary node 9 could not be added \(its folder, if any, is left as it is\): \[devnet\] node9 already exists/);
  assert.deepEqual(edges.started.map(node => node.number), [7, 8]);
  // The next run's reclaim of its own leftovers does not take it for one either.
  edges.reclaimLeftovers();
  edges.cleanup({ keep: false, failed: false });
  assert.ok(untouched(devnet, 9));
  assert.ok(!devnet.calls.some(call => call === 'stop-node 9'), devnet.calls.join(', '));
  // The nodes this run added were marked as its own only once their addnode succeeded.
  assert.ok(!existsSync(devnet.nodeDir(7)) && !existsSync(devnet.nodeDir(8)));
});

test('a start interrupted while the node comes up is cancelled, and the cleanup removes that node and no other', async t => {
  const devnet = fakeDevnet(t, { readiness: number => (number === 9 ? 'hang' : 'ready') });
  const edges = new TemporaryEdges(devnet, { stamp: 'S', log: { say() {}, note() {} } });
  edges.allocate({ relay1: 'r1', relay2: 'r2' });
  await edges.start(edges.owner);
  await edges.start(edges.member1);
  // Another suite's node beside them.
  foreign(devnet, 10);
  const starting = edges.start(edges.member2);
  for (let i = 0; i < 100 && !existsSync(join(devnet.nodeDir(9), MARK)); i++) await new Promise(resolve => { setTimeout(resolve, 10); });
  // Before the daemon was up, addnode had marked the folder as this run's, in its starting state.
  assert.equal(readFileSync(join(devnet.nodeDir(9), MARK), 'utf8'), 'S member2 starting\n');
  // The signal handler's cleanup, while node 9 is still coming up.
  edges.cleanup({ keep: false, failed: false });
  assert.ok(devnet.calls.includes('cancelled addnode 9'), devnet.calls.join(', '));
  assert.ok(devnet.calls.includes('stop-node 9'), devnet.calls.join(', '));
  assert.ok(!existsSync(devnet.nodeDir(9)) && !existsSync(devnet.nodeDir(7)) && !existsSync(devnet.nodeDir(8)));
  assert.ok(untouched(devnet, 10));
  assert.ok(!devnet.calls.includes('stop-node 10'), devnet.calls.join(', '));
  await assert.rejects(starting, /temporary node 9 could not be added \(it is removed at the cleanup\)/);
});

test('a node whose start failed after addnode created it is removed; a later run reclaims one a killed run left starting', async t => {
  const devnet = fakeDevnet(t, { readiness: number => (number === 8 ? 'failed' : 'ready') });
  const edges = new TemporaryEdges(devnet, { stamp: 'S', log: { say() {}, note() {} } });
  edges.allocate({ relay1: 'r1', relay2: 'r2' });
  await edges.start(edges.owner);
  await assert.rejects(edges.start(edges.member1), /temporary node 8 could not be added \(it is removed at the cleanup\): \[devnet\] node8 did not become ready/);
  assert.deepEqual(edges.started.map(node => node.number), [7, 8]);
  edges.cleanup({ keep: false, failed: false });
  assert.ok(!existsSync(devnet.nodeDir(7)) && !existsSync(devnet.nodeDir(8)));
  // A run killed outright (no cleanup) left node 9 in its starting state, next to another suite's node 10.
  mkdirSync(devnet.nodeDir(9));
  writeFileSync(join(devnet.nodeDir(9), MARK), 'EARLIER member2 starting\n');
  foreign(devnet, 10);
  const next = new TemporaryEdges(devnet, { stamp: 'NEXT', log: { say() {}, note() {} } });
  next.reclaimLeftovers();
  assert.ok(!existsSync(devnet.nodeDir(9)));
  assert.ok(untouched(devnet, 10));
});

test('cancelling the real devnet.sh call stops the script while the node comes up: its later steps never run', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dkg-devnet-sh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.devnet');
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(dir, 'node8'), { recursive: true });
  writeFileSync(join(dir, 'node8', 'config.json'), '{"theirs":true}');
  // A stand-in for addnode: it claims and marks the folder, waits while the node comes up, then records the start.
  writeFileSync(join(root, 'scripts', 'devnet.sh'), [
    'set -e',
    'mkdir "$DEVNET_DIR/node$2"',
    `echo "$DEVNET_ADDNODE_MARK_TEXT" > "$DEVNET_DIR/node$2/${MARK}"`,
    'sleep 3 > /dev/null 2>&1',
    'echo up > "$DEVNET_DIR/node$2/started"',
  ].join('\n'));
  const devnet = openDevnet({ repoRoot: root, dir, apiPortBase: 9201, libp2pPortBase: 10001, adminToken: 'token' });
  const cancel = new AbortController();
  const began = Date.now();
  const adding = devnet.devnetSh(['addnode', '7', 'edge'], { DEVNET_ADDNODE_MARK_TEXT: 'S member2 starting' }, 30_000, { signal: cancel.signal });
  for (let i = 0; i < 200 && !existsSync(join(dir, 'node7', MARK)); i++) await new Promise(resolve => { setTimeout(resolve, 10); });
  assert.equal(readFileSync(join(dir, 'node7', MARK), 'utf8'), 'S member2 starting\n');
  cancel.abort();
  const added = await adding;
  assert.notEqual(added.status, 0);
  assert.ok(Date.now() - began < 2_000, `the call ended ${Date.now() - began} ms after it began: it was waited for, not stopped`);
  await new Promise(resolve => { setTimeout(resolve, 3_500 - (Date.now() - began)); });
  assert.equal(existsSync(join(dir, 'node7', 'started')), false, 'the step after the wait ran: the script was not stopped');
  assert.equal(readFileSync(join(dir, 'node8', 'config.json'), 'utf8'), '{"theirs":true}');
});

test('case 6 preparation owns author selection, audits before renewal and stops before later cases', async t => {
  const devnet = fakeDevnet(t);
  const edges = new TemporaryEdges(devnet, { stamp: 'S', log: { say() {}, note() {} } });
  edges.allocate({ relay1: 'r1', relay2: 'r2' });
  const audit = async () => { devnet.calls.push('audit feeder'); };
  assert.equal(await edges.prepareLargeGraphAuthor(1, audit), edges.owner);
  assert.equal(devnet.calls.length, 0, 'first-attempt success needs no feeder');
  assert.equal(await edges.prepareLargeGraphAuthor(2, audit), edges.feeder);
  assert.equal(await edges.prepareLargeGraphAuthor(3, audit), edges.feeder);
  assert.ok(devnet.calls.indexOf('audit feeder') < devnet.calls.indexOf('stop-node 10'));
  const events = [];
  await edges.finishFeeder(async () => { events.push('audit'); }, () => events.push('failed'));
  events.push('case 5');
  assert.deepEqual(events, ['audit', 'case 5']);
  assert.equal(edges.feederRunning, false);
});

/**
 * What writeLargeGraph asks of the nodes, against the real TemporaryEdges on a
 * fake devnet: `refuses(author)` says whether a node refuses every asset it is
 * asked to write, as a feeder that died does. `created` keeps which node created
 * which graph, `written` how many assets of how many triples each graph got, and
 * `audits` when the feeder was checked out of the public graph.
 */
function largeGraphFixture(t, { refuses = () => false, stopStatus } = {}) {
  const devnet = fakeDevnet(t, { stopStatus });
  const notes = [];
  const edges = new TemporaryEdges(devnet, { stamp: 'S', log: { say() {}, note: text => notes.push(text) } });
  edges.allocate({ relay1: 'r1', relay2: 'r2' });
  const created = [];
  const written = [];
  const audits = [];
  const ctx = {
    edges, stamp: 'S', say() {}, audit: async when => { audits.push(when); },
    graphs: {
      async createGraph(key, body, { by }) { created.push([key, by.role]); return { key, id: `${by.role}/${key}` }; },
      async keepCoresOut() {},
    },
    io: {
      async createAndShare(author, { contextGraphId, quads }) {
        if (refuses(author)) return { error: 'the author refused the asset: HTTP 0 fetch failed' };
        const last = written.at(-1);
        if (last?.graph === contextGraphId) last.assets += 1;
        else written.push({ graph: contextGraphId, assets: 1, triples: quads.length });
        return {};
      },
    },
  };
  return { devnet, edges, ctx, notes, created, written, audits };
}

test('case 6: the owner writes the first large graph as asked; a later one comes whole from a fresh feeder', async t => {
  const { devnet, edges, ctx, created, written, audits } = largeGraphFixture(t);
  // The first is what the suite was asked for, even when a later graph on the owner would be cut to less.
  const first = await writeLargeGraph(ctx, 1, { assets: 20, triples: 8000 });
  assert.deepEqual(first, { key: 'large', id: 'owner/large', size: { assets: 20, triples: 8000 } });
  assert.ok(!devnet.calls.includes('addnode 10 edge'), 'the first attempt needs no feeder');
  const second = await writeLargeGraph(ctx, 2, { assets: 3, triples: 100 });
  assert.deepEqual(second, { key: 'large2', id: 'feeder/large2', size: { assets: 3, triples: 100 } });
  assert.ok(devnet.calls.includes('addnode 10 edge'));
  assert.deepEqual(audits, [], 'nothing to audit before the first feeder');
  await writeLargeGraph(ctx, 3, { assets: 4, triples: 100 });
  assert.deepEqual(audits, ['before attempt 3 of case 6']);
  assert.deepEqual(created, [['large', 'owner'], ['large2', 'feeder'], ['large3', 'feeder']]);
  assert.deepEqual(written, [
    { graph: 'owner/large', assets: 20, triples: 8000 }, { graph: 'feeder/large2', assets: 3, triples: 100 }, { graph: 'feeder/large3', assets: 4, triples: 100 },
  ]);
  assert.equal(edges.largeAuthor, edges.feeder);
});

test('case 6: a feeder that fails while it writes the large graph is given up, unaudited, and the owner writes the graph, no larger than it can take', async t => {
  const fixture = largeGraphFixture(t, {
    refuses: author => {
      if (author.role !== 'feeder') return false;
      writeFileSync(join(fixture.devnet.nodeDir(10), 'console.log'), 'what it could not log itself\n');
      writeFileSync(join(fixture.devnet.nodeDir(10), 'daemon.log'), 'its last log line\n');
      return true;
    },
  });
  const { devnet, edges, ctx, notes, created, written, audits } = fixture;
  const graph = await writeLargeGraph(ctx, 2, { assets: 26, triples: 9847 });
  assert.deepEqual(graph, { key: 'large2', id: 'owner/large2', size: { assets: 12, triples: 9847 } });
  assert.deepEqual(created, [['large2', 'feeder'], ['large2', 'owner']]);
  assert.deepEqual(written, [{ graph: 'owner/large2', assets: 12, triples: 9847 }]);
  // No write is made while a large graph is written, so the feeder has carried none.
  assert.deepEqual(audits, []);
  assert.match(notes.at(-1), /^the feeder failed while it wrote a large graph \(asset 0 of the large2 graph: the author refused the asset: HTTP 0 fetch failed\): the owner writes/);
  assert.deepEqual(devnet.calls.filter(call => /^(addnode|stop-node) 10/.test(call)), ['addnode 10 edge', 'stop-node 10']);
  assert.ok(!edges.feederRunning && !edges.feederUp);
  // Its logs outlast its folder, also when the run passes: nothing else tells why it failed.
  const kept = join(devnet.dir, 'issue-3251-member-sharing', 'S');
  assert.ok(notes.at(-1).endsWith(`its logs are kept in ${kept}`), notes.at(-1));
  assert.equal(readFileSync(join(kept, 'node10-feeder.console.log'), 'utf8'), 'what it could not log itself\n');
  assert.equal(readFileSync(join(kept, 'node10-feeder.daemon.log'), 'utf8'), 'its last log line\n');
  // The next attempt goes to the owner too, and no feeder is started again.
  const next = await writeLargeGraph(ctx, 3, { assets: 26, triples: 9847 });
  assert.deepEqual(next.size, { assets: 12, triples: 9847 });
  assert.deepEqual(devnet.calls.filter(call => /^(addnode|stop-node) 10/.test(call)), ['addnode 10 edge', 'stop-node 10']);
  // After case 6 nothing is left to audit or to stop, so case 2 is not failed for a feeder that cannot answer.
  await edges.finishFeeder(async () => { audits.push('after case 6'); }, () => assert.fail('there is nothing to stop'));
  assert.deepEqual(audits, []);
});

test('case 6: a given-up feeder that cannot be stopped stays for the stop after case 6', async t => {
  let refuse = true;
  const { edges, ctx, audits } = largeGraphFixture(t, { refuses: author => author.role === 'feeder', stopStatus: () => (refuse ? 1 : 0) });
  assert.equal((await writeLargeGraph(ctx, 2, { assets: 1, triples: 100 })).id, 'owner/large2');
  assert.equal(edges.feederRunning, true);
  assert.equal(edges.largeAuthor, edges.owner);
  // It is still running beside the cases to come, so it is audited as any feeder that ran.
  refuse = false;
  await edges.finishFeeder(async () => { audits.push('after case 6'); }, () => assert.fail('shutdown must recover'));
  assert.deepEqual(audits, ['after case 6']);
  assert.equal(edges.feederRunning, false);
});

test('case 6: the owner failing to write a large graph is reported to the case', async t => {
  const { ctx, created } = largeGraphFixture(t, { refuses: () => true });
  await assert.rejects(writeLargeGraph(ctx, 2, { assets: 1, triples: 100 }), /asset 0 of the large2 graph: the author refused the asset/);
  assert.deepEqual(created, [['large2', 'feeder'], ['large2', 'owner']]);
  await assert.rejects(writeLargeGraph(ctx, 1, { assets: 1, triples: 100 }), /asset 0 of the large graph/);
});

test('failed renewal selects the owner permanently while shutdown remains retryable', async t => {
  let refuse = true;
  const devnet = fakeDevnet(t, { stopStatus: () => refuse ? 1 : 0 });
  const edges = new TemporaryEdges(devnet, { stamp: 'S', log: { say() {}, note() {} } });
  edges.allocate({ relay1: 'r1', relay2: 'r2' });
  assert.equal(await edges.prepareLargeGraphAuthor(2, async () => {}), edges.feeder);
  assert.equal(await edges.prepareLargeGraphAuthor(3, async () => {}), edges.owner);
  assert.equal(edges.feederRunning, true);
  assert.equal(edges.largeAuthor, edges.owner);
  const adds = devnet.calls.filter(call => call.startsWith('addnode')).length;
  assert.equal(await edges.prepareLargeGraphAuthor(4, async () => {}), edges.owner);
  assert.equal(devnet.calls.filter(call => call.startsWith('addnode')).length, adds);
  const failures = [];
  await edges.finishFeeder(async () => {}, error => failures.push(error.message));
  assert.equal(failures.length, 1, 'two rejected stops must report failed isolation');
  assert.equal(edges.feederRunning, true);
  refuse = false;
  await edges.finishFeeder(async () => {}, () => assert.fail('shutdown must recover'));
  assert.equal(edges.feederRunning, false);
});

test('partial startup is rolled back, failed rollback stays tracked, and foreign claims are untouched', async t => {
  let refuse = true;
  const devnet = fakeDevnet(t, { stopStatus: () => refuse ? 1 : 0 });
  const edges = new TemporaryEdges(devnet, { stamp: 'S', log: { say() {}, note() {} } });
  edges.allocate({ relay1: 'r1', relay2: 'r2' });
  edges.identify = async () => { throw new Error('identity failed after launch'); };
  assert.equal(await edges.prepareLargeGraphAuthor(2, async () => {}), edges.owner);
  assert.ok(devnet.calls.includes('stop-node 10'));
  assert.equal(edges.feederRunning, true);
  assert.equal(edges.feederUp, false);
  refuse = false;
  await edges.finishFeeder(async () => {}, () => assert.fail('shutdown must recover'));
  assert.equal(edges.feederRunning, false);
  const rival = fakeDevnet(t);
  const foreignEdges = new TemporaryEdges(rival, { stamp: 'S', log: { say() {}, note() {} } });
  foreignEdges.allocate({ relay1: 'r1', relay2: 'r2' });
  foreign(rival, 10);
  assert.equal(await foreignEdges.prepareLargeGraphAuthor(2, async () => {}), foreignEdges.owner);
  assert.ok(untouched(rival, 10));
  assert.ok(!rival.calls.includes('stop-node 10'));
});

test('an isolation audit error still shuts down its owned feeder', async t => {
  const devnet = fakeDevnet(t);
  const edges = new TemporaryEdges(devnet, { stamp: 'S', log: { say() {}, note() {} } });
  edges.allocate({ relay1: 'r1', relay2: 'r2' });
  await edges.prepareLargeGraphAuthor(2, async () => {});
  await assert.rejects(edges.finishFeeder(async () => { throw new Error('unknown membership'); }, () => {}), /unknown membership/);
  assert.equal(edges.feederRunning, false);
});

for (const state of ['following', 'unknown', 'not-following']) {
  test(`outgoing feeder ${state} is audited before replacement and shutdown`, async t => {
    const devnet = fakeDevnet(t);
    const edges = new TemporaryEdges(devnet, { stamp: 'S', log: { say() {}, note() {} } });
    edges.allocate({ relay1: 'r1', relay2: 'r2' });
    const failures = [];
    const feederOutOf = (graph, when) => auditFeederIsolation({ edges,
      graphs: { following: async () => { devnet.calls.push('audit'); return { state }; } },
      fail: (id, message) => { failures.push([id, message]); devnet.calls.push('verdict'); },
    }, graph, when, { boundMs: 0 });
    const audit = () => feederOutOf('public', 'before removal');
    await edges.prepareLargeGraphAuthor(2, audit);
    await edges.prepareLargeGraphAuthor(3, audit);
    assert.ok(devnet.calls.indexOf('audit') < devnet.calls.indexOf('stop-node 10'));
    if (state !== 'not-following') assert.ok(devnet.calls.indexOf('verdict') < devnet.calls.indexOf('stop-node 10'));
    await edges.finishFeeder(audit, () => assert.fail('stop succeeds'));
    assert.equal(failures.length, state === 'not-following' ? 0 : 2);
    assert.ok(failures.every(([id]) => id === 2));
    assert.equal(edges.feederRunning, false);
  });
}

/** The audit of a feeder whose listing answers `answers` in turn (the last repeats). */
async function auditOf(answers, options = { boundMs: 2_000, everyMs: 5 }) {
  const failures = [];
  const notes = [];
  let reads = 0;
  await auditFeederIsolation({
    edges: { feeder: { label: 'node10 (feeder)' } },
    graphs: { following: async () => answers[Math.min(reads++, answers.length - 1)] },
    fail: (id, message) => failures.push([id, message]),
    note: text => notes.push(text),
  }, 'public', 'after case 6', options);
  return { failures, notes, reads };
}
const busy = { state: 'unknown', reason: 'HTTP 500 {"error":"ontology/agents definition scan exceeded listContextGraphs budget"}' };

test('a feeder whose store is busy is asked again, and the first answer that says either way decides', async () => {
  // It cannot read its store for a while, then says it stayed out: nothing failed, and the note keeps what it said.
  const out = await auditOf([busy, busy, { state: 'not-following' }]);
  assert.deepEqual(out.failures, []);
  assert.equal(out.reads, 3);
  assert.deepEqual(out.notes, [`after case 6 the feeder node10 (feeder) could not say whether it follows the public graph 2 time(s) (first: ${busy.reason}), then it did`]);
  // Then it says it follows the graph: as without the wait, that fails case 2.
  const followed = await auditOf([busy, { state: 'following' }]);
  assert.deepEqual(followed.failures, [[2, 'after case 6 the feeder node10 (feeder) follows the public graph: its gossip may have carried writes']]);
  assert.equal(followed.reads, 2);
});

test('a feeder that answers is not asked again, and one that never says fails case 2 when the bound runs out', async () => {
  const quiet = await auditOf([{ state: 'not-following' }]);
  assert.deepEqual([quiet.failures, quiet.notes, quiet.reads], [[], [], 1]);
  const following = await auditOf([{ state: 'following' }]);
  assert.equal(following.failures.length, 1);
  assert.equal(following.reads, 1);
  const never = await auditOf([busy], { boundMs: 40, everyMs: 5 });
  assert.deepEqual(never.failures, [[2, `after case 6 it is not known whether the feeder node10 (feeder) follows the public graph (${busy.reason})`]]);
  assert.ok(never.reads >= 2, `read ${never.reads} time(s)`);
  assert.deepEqual(never.notes, []);
});

test('what a node\'s listing said is kept when it cannot say whether it follows a graph', async () => {
  const answers = {
    8: { status: 500, text: '{"error":"ontology/agents definition scan exceeded listContextGraphs budget"}' },
    9: { status: 0, text: 'fetch failed' },
    10: { status: 200, text: 'not json' },
    11: { status: 200, text: '{"contextGraphs":[{"id":"public","subscribed":false}]}' },
  };
  const graphs = createGraphs({ api: async node => answers[node.number] }, {}, { stamp: 'S', sub: 's', say() {} });
  assert.deepEqual(await graphs.following({ number: 8 }, { id: 'public' }), { state: 'unknown', reason: `HTTP 500 ${answers[8].text}` });
  assert.deepEqual(await graphs.following({ number: 9 }, { id: 'public' }), { state: 'unknown', reason: 'no answer' });
  assert.deepEqual(await graphs.following({ number: 10 }, { id: 'public' }), { state: 'unknown', reason: 'the body is not JSON' });
  assert.deepEqual(await graphs.following({ number: 11 }, { id: 'public' }), { state: 'not-following' });
});

for (const recovers of [false, true]) test(`zero stop status with busy ports retains shutdown ownership (recovers=${recovers})`, async t => {
  const devnet = fakeDevnet(t);
  const edges = new TemporaryEdges(devnet, { stamp: 'S', log: { say() {}, note() {} } });
  edges.allocate({ relay1: 'r1', relay2: 'r2' });
  await edges.prepareLargeGraphAuthor(2, async () => {});
  let busy = true, now = 0;
  devnet.nodePorts = () => [12345]; devnet.listening = () => busy;
  t.mock.method(Date, 'now', () => now += 30_000);
  assert.equal(await edges.prepareLargeGraphAuthor(3, async () => {}), edges.owner);
  assert.equal(edges.feederRunning, true);
  assert.equal(edges.feederUp, false);
  busy = !recovers;
  const failures = [], audits = [];
  await edges.finishFeeder(async () => { audits.push('audit'); }, error => failures.push(error.message));
  assert.equal(audits.length, 1);
  assert.equal(failures.length, recovers ? 0 : 1);
  assert.equal(edges.feederRunning, !recovers);
  assert.equal(await edges.prepareLargeGraphAuthor(4, async () => {}), edges.owner);
  assert.equal(devnet.calls.filter(call => call === 'stop-node 10').length, recovers ? 2 : 3);
});

test('a busy-port removal after a successful stop stays eligible for final shutdown', async t => {
  const devnet = fakeDevnet(t);
  const edges = new TemporaryEdges(devnet, { stamp: 'S', log: { say() {}, note() {} } });
  edges.allocate({ relay1: 'r1', relay2: 'r2' });
  await edges.prepareLargeGraphAuthor(2, async () => {});
  let busy = false, now = 0;
  devnet.nodePorts = () => [12345]; devnet.listening = () => busy;
  t.mock.method(Date, 'now', () => now += 30_000);
  const remove = edges.removeStoppedOwnNode.bind(edges);
  edges.removeStoppedOwnNode = (...args) => { busy = true; return remove(...args); };
  assert.equal(await edges.prepareLargeGraphAuthor(3, async () => {}), edges.owner);
  assert.equal(edges.feederRunning, true);
  const failures = [];
  await edges.finishFeeder(async () => {}, error => failures.push(error.message));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /still listens/);
  assert.equal(devnet.calls.filter(call => call === 'stop-node 10').length, 3);
});

for (const activation of ['before', 'after-failure']) test(`a foreign Core on the reserved feeder number remains visible ${activation} activation`, async t => {
  const devnet = fakeDevnet(t);
  const edges = new TemporaryEdges(devnet, { stamp: 'S', log: { say() {}, note() {} } });
  edges.allocate({ relay1: 'r1', relay2: 'r2' });
  foreign(devnet, 10);
  const calls = [];
  devnet.nodeNumbers = () => [1, 2, 10];
  devnet.nodeConfig = () => ({ nodeRole: 'core' });
  devnet.api = async (node, method, path) => {
    calls.push([node, method, path]);
    const body = { contextGraphs: node === 10 ? [{ id: 'public', subscribed: true }] : [] };
    return { status: 200, json: body, text: JSON.stringify(body) };
  };
  if (activation === 'after-failure') assert.equal(await edges.prepareLargeGraphAuthor(2, async () => {}), edges.owner);
  const graphs = createGraphs(devnet, edges, { stamp: 'S', sub: 's', say() {} });
  assert.deepEqual(graphs.coreNodes(), [1, 2, 10]);
  assert.deepEqual((await graphs.coresFollowing({ id: 'public' })).following, ['node10']);
  await graphs.keepCoresOut({ id: 'public', key: 'public' });
  assert.ok(calls.some(([node, method, path]) => node === 10 && method === 'POST' && path.endsWith('/unsubscribe')));
  assert.ok(untouched(devnet, 10));
  assert.ok(!devnet.calls.includes('stop-node 10'));
});
