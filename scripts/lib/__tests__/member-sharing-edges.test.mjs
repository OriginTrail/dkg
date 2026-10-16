import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TemporaryEdges } from '../member-sharing/temporary-edges.mjs';

const MARK = '.issue-3251-member-sharing';

/**
 * A devnet folder whose devnet.sh is a fake: addnode refuses a folder that
 * exists, as the real one does, and otherwise creates it; `duringAddnode` runs
 * at the start of each addnode, as another suite might. Every call is kept.
 */
function fakeDevnet(t, { duringAddnode = () => {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-edges-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const nodeDir = node => join(dir, `node${typeof node === 'object' ? node.number : node}`);
  return {
    dir, calls, nodeDir,
    async devnetSh(args) {
      calls.push(args.join(' '));
      if (args[0] !== 'addnode') return { status: 0, output: '' };
      const number = Number(args[1]);
      duringAddnode(number);
      if (existsSync(nodeDir(number))) return { status: 1, output: `[devnet] node${number} already exists` };
      mkdirSync(nodeDir(number));
      writeFileSync(join(nodeDir(number), 'config.json'), '{"ours":true}');
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
