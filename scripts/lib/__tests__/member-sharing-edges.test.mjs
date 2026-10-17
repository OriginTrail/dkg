import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TemporaryEdges } from '../member-sharing/temporary-edges.mjs';

const MARK = '.issue-3251-member-sharing';

/**
 * A devnet folder whose devnet.sh is a fake that does what addnode does: it
 * refuses a folder that exists, creates the folder with one mkdir, writes the
 * caller's mark into it first, and then starts the node. `duringAddnode` runs
 * at the start of each addnode, as another suite might; `readiness(number)`
 * says how the start ends: 'ready', 'failed', or 'hang' (until it is
 * cancelled). Every call is kept.
 */
function fakeDevnet(t, { duringAddnode = () => {}, readiness = () => 'ready' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-edges-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const nodeDir = node => join(dir, `node${typeof node === 'object' ? node.number : node}`);
  return {
    dir, calls, nodeDir,
    async devnetSh(args, env = {}, timeoutMs, { signal } = {}) {
      calls.push(args.join(' '));
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
