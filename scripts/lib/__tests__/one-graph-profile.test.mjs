// Tests of the one-graph promotion suite's Edges (scripts/lib/one-graph/profile.mjs
// and edges.mjs): the node profile they run, the topology between them, and the
// marks of their node folders.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { edgeTopologyProblems, profileStatusProblems } from '../qa/one-graph-promotion.mjs';
import { markOwner, OneGraphEdges, processAlive } from '../one-graph/edges.mjs';
import {
  DEAD_DIRECT_ADDRESS, edgeEnv, edgeOverrides, inheritedDkgEnv, OVERRIDE_ENV, PROFILE_CONFIG, PROFILE_ENV, PROFILE_NAMES,
} from '../one-graph/profile.mjs';

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

test('a node\'s mark names the run that started it, and whether that run still runs', () => {
  assert.deepEqual(markOwner('20261016T123857Z-37695 curator\n'), { stamp: '20261016T123857Z-37695', pid: 37695, role: 'curator' });
  for (const text of ['', 'garbage', 'S curator', '20261016T123857Z-37695', undefined]) assert.equal(markOwner(text), null, String(text));
  assert.equal(processAlive(process.pid), true);
  const ended = spawnSync(process.execPath, ['-e', '']).pid;
  assert.equal(processAlive(ended), false);
});

test('a run reclaims only nodes of its own suite whose run has ended; a running run\'s nodes and another suite\'s are left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'one-graph-edges-'));
  try {
    const nodeDir = number => join(dir, `node${number}`);
    for (const number of [7, 8, 9, 10]) mkdirSync(nodeDir(number));
    const ended = spawnSync(process.execPath, ['-e', '']).pid;
    // node7: a run of this suite that still runs; node8: one that has ended; node9: the member-sharing
    // suite's, its run ended or not; node10: a mark that names no run.
    writeFileSync(join(nodeDir(7), '.one-graph-promotion'), `20261016T120000Z-${process.pid} curator\n`);
    writeFileSync(join(nodeDir(8), '.one-graph-promotion'), `20261016T110000Z-${ended} edgeA\n`);
    writeFileSync(join(nodeDir(9), '.issue-3251-member-sharing'), `20261016T110000Z-${ended} member1\n`);
    writeFileSync(join(nodeDir(10), '.one-graph-promotion'), 'garbage\n');
    const notes = [];
    const edges = new OneGraphEdges({ nodeDir }, { stamp: 'S', log: { say() {}, note: text => notes.push(text) } });
    const removed = [];
    edges.removeOwnNode = number => { removed.push(number); return null; };
    edges.reclaimLeftovers();
    assert.deepEqual(removed, [8]);
    assert.deepEqual(notes, [
      `node7 belongs to run 20261016T120000Z-${process.pid} of this suite, which is still running: left alone`,
      `removed node8, left by run 20261016T110000Z-${ended} of this suite, which has ended`,
      'node10 carries this suite\'s mark but it names no run: left alone',
    ]);
    // The mark a started node gets is this suite's own, never the member-sharing suite's.
    assert.equal(edges.ownMark(7), join(nodeDir(7), '.one-graph-promotion'));
    // A run whose owner cannot be told ended keeps its node; once it ends, the node is reclaimed.
    removed.length = 0;
    edges.reclaimLeftovers({ isAlive: () => true });
    assert.deepEqual(removed, []);
    edges.reclaimLeftovers({ isAlive: () => false });
    assert.deepEqual(removed, [7, 8]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
