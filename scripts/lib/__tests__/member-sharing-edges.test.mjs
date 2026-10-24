import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDevnet } from '../member-sharing/devnet.mjs';
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
  await edges.startFeeder();
  assert.ok(devnet.calls.includes('addnode 10 edge') && edges.feederUp);
  assert.equal(edges.largeAuthor, edges.feeder);
  await edges.stopFeeder();
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
  assert.ok(edges.isTemporary(10) && !edges.nodes.includes(edges.feeder));
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
  await assert.rejects(fallback.startFeeder(), /temporary node 10 could not be added/);
  assert.equal(fallback.largeAuthor, fallback.owner);
  // One that started but that member 2 cannot dial is stopped again.
  const undialable = fakeDevnet(t);
  const dialFails = new TemporaryEdges(undialable, { stamp: 'S', log });
  dialFails.allocate({ relay1: 'r1', relay2: 'r2' });
  dialFails.dial = async () => { throw new Error('node9 (member2) could not dial the feeder through the relay: HTTP 0 refused'); };
  await assert.rejects(dialFails.startFeeder(), /could not dial the feeder/);
  assert.ok(undialable.calls.includes('stop-node 10') && !dialFails.feederUp && !dialFails.feederRunning);
  assert.equal(dialFails.largeAuthor, dialFails.owner);
  // A stop that fails leaves the feeder marked running, and a second stopFeeder stops it.
  let stops = 0;
  const stubborn = fakeDevnet(t, { stopStatus: number => (number === 10 && ++stops === 1 ? 1 : 0) });
  const once = new TemporaryEdges(stubborn, { stamp: 'S', log });
  once.allocate({ relay1: 'r1', relay2: 'r2' });
  await once.startFeeder();
  await assert.rejects(once.stopFeeder(), /the feeder could not be stopped/);
  assert.ok(once.feederRunning && once.feederUp);
  await once.stopFeeder();
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
