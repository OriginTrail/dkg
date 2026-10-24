#!/usr/bin/env node
//
// issue-3251 member sharing: in a context graph whose members reach only its
// owner, every subscribed member must hold every write, whoever made it.
//
// Issue #3251: in a public graph that is not registered on chain, a member's
// write reached the owner and never the other members. The owner did not pass
// it on, and the members' catch-up did not pull it: one member's single sync
// slot was busy with a large transfer of another graph, and another member
// reported `synced: true` and pulled nothing for longer than the test waited.
// No devnet suite could see it: every devnet node reaches every other on
// loopback, and the Cores carry every public graph they discover.
//
// Topology. Three temporary Edges: an owner and two members. Each announces,
// in place of its listen address, a loopback port nobody listens on and its
// circuit address through the Core it holds a relay reservation on; the
// overrides are in place from the first start (DEVNET_ADDNODE_CONFIG_OVERRIDES
// of `devnet.sh addnode`; a `relay` among them stays the node's relay on later
// starts). Member 1 reserves on node 1, member 2 on node 2, the owner on both
// (`preferredRelays`). A node dials circuits only through its own relays, so
// each member reaches the owner through its relay and neither can reach the
// other: member 1 cannot use node 2, member 2 cannot use node 1. (Two members
// on one relay find each other: a member dials an author it learns of through
// that relay.) The script checks, before each case and at the end, that every
// connection between a member and the owner is relayed and that the members
// hold no connection to each other. The Cores are kept out of the unregistered
// graphs (each subscribes and unsubscribes as soon as a graph exists; an ended
// subscription is not re-activated by discovery) and must still be out at the
// end, so no Core can carry a write between the members. A registered graph is
// hosted by the Cores, as on the public network (they serve its definition to
// a new member); case 7 checks it that way. Member 2 runs with one sync slot
// and no queue (`syncGlobalMaxInflight: 1`, `syncGlobalQueueLimit: 0`), as the
// member whose slot was starved in the issue. A fourth temporary Edge, the
// feeder, starts only when case 6 makes another attempt, fresh for each one:
// it holds that attempt's large graph and serves it to member 2, which dials
// it through node 2 as it dials the owner. It follows no graph of the other
// cases, must not follow the public graph, and stops after case 6.
//
// A write is one asset with a subject of its own, written and shared the way a
// client does it (create, then the asynchronous share job). A node HOLDS it
// when both reads a client makes find it with the written value and no other
// value: the `shared-working-memory` view (with `subGraphName` for a sub-graph)
// and the cross-partition read (`includeContextGraphPartitions`, GRAPH ?g, in
// the shared memory of the root or of that sub-graph).
//
// The bound: every pair (write, node that must hold it) has
// MEMBER_SHARING_BOUND_SECS (default 60) from the end of the write's share
// job; a write made before a member subscribed or while it was down, from the
// member's subscribe or from its return. The `synced` flag of a member has
// MEMBER_SHARING_SYNCED_SECS (default 90) from its subscribe: a member whose
// first catch-up round proved nothing runs it again 15 s and then 30 s later.
// A member must hold a graph's definition within 90 s of its subscribe (case 3,
// or 7): without it its own writes into the graph are refused.
//
// Cases (each line of the report names the case, the write, the node and the
// read that did not find it):
//   1  owner -> members, root and sub-graph, live
//   2  member -> owner -> other member, root and sub-graph, live (#3251),
//      with each member as an author
//   3  history: writes made before the members subscribed
//   4  after a member restart (writes made while it was down, and live ones
//      after it) and after an owner restart (live, both directions)
//   5  members MEMBER_SHARING_LATER_SECS (default 300) after they subscribed
//      still receive new writes, both directions
//   6  member 2 while its only general sync slot is busy with a large transfer
//      of another graph (MEMBER_SHARING_BIG_ASSETS x MEMBER_SHARING_BIG_TRIPLES).
//      Member 2's own evidence must show the transfer in the slot: its
//      admission trace (DKG_SYNC_ADMISSION_TRACE, written by the agent) names
//      the admission of the large graph that took its general slot, under the
//      effective policy of one general slot and no queue, and lists it once a
//      second while it holds the slot. A write counts only when it was received
//      before the last trace line that shows the transfer holding the slot (its
//      release, or a lost release's last listing). The reserved slots beside
//      the general one, for shared-memory pulls (#3258) and control-plane
//      fetches (#3302), are the fixes under test: the writes must reach member
//      2 although the general slot is busy (the diagnostics report the reserved
//      slots as part of one pool, so they are not read for this). Its daemon
//      starts with the sync environment variables pinned to that policy (they
//      override config), its catch-up asks one peer at a time
//      (DKG_CATCHUP_MAX_CONCURRENT_PEERS=1), and member 2 subscribes to the
//      large graph once its general slot is free: so the transfer from the
//      node that holds the graph is the pull that takes the general slot (the
//      other peers' pulls of it find nothing and continue it at once). The
//      three writes are made as soon as the trace shows the transfer in the
//      slot. How long the transfer holds it is not known in advance, and a
//      write may take up to its bound to arrive: when a write arrives only
//      after the transfer gave up the slot (the attempt proves nothing), or
//      the transfer gave it up before the writes could start, member 2 leaves
//      that graph and the case makes another attempt, up to
//      MEMBER_SHARING_BUSY_ATTEMPTS in all: a new large graph, sized from the
//      rate member 2's trace measured for the last transfer to hold the slot
//      past the window the last writes needed (within what one node holds
//      well), and the three writes again. The first large graph is the
//      owner's, as before; a later one is written by a feeder that holds
//      nothing yet (without a fourth node number, by the owner): a node writes
//      more slowly the more it holds, and the owner's writes are among those
//      the case waits for. The last attempt is judged as the case. A write
//      member 2 does not hold within its bound fails the case at once,
//      whatever the slot did. A write received after the transfer gave up the
//      slot, a transfer that took a reserved slot, or a transfer never
//      admitted, fails the case as not exercised; a running catch-up job
//      alone proves nothing
//   7  cases 1, 2 and 3 on a public graph registered on chain, and cases 1
//      and 3 on a private graph whose members joined through the signed
//      request flow. A member's write into a private graph sets up its sender
//      key with every other member directly, which members that reach only
//      the owner cannot do, so case 2 does not apply there.
//   8  the `synced` flag of every member, for every graph
//
// Known gaps (scripts/lib/qa/known-gaps.mjs, applied to every check before it
// is reported): a check that fails for the reason of an open issue, with
// evidence of that reason, is printed as XFAIL with the issue and does not
// fail its case. None is open: the last, #3264 (a member of the registered
// graph never obtained its definition here), was retired once its checks held.
//
// After a restart each member dials the owner again, as a client of the
// issue's kind does; the script does not wait for the nodes to find each
// other by themselves.
//
// Temporary node numbers. The suite takes the first three free of 7, 8, 9 and
// 10 (no folder, nothing listening on the node's API or libp2p port), and
// keeps the fourth, when it is free too, for the feeder. A node
// folder of its own carries a mark that addnode writes right after it created
// the folder (with one mkdir, which fails on a folder that exists), before the
// daemon starts: a start that fails or is interrupted (a signal while the node
// comes up) is cancelled and its node removed at the cleanup, and a marked
// folder left by a run that was killed is stopped and removed at the start of
// the next, so the suite's own debris never costs a node number. Another
// suite's node, also one that took a number after it was picked, is left
// alone. At the end the suite removes a node's folder only once nothing
// listens on its ports.
//
// Exit codes: 0 every case passed; 1 a case failed or was not run; 3 the
// devnet cannot host the scenario and nothing was exercised: no devnet, node 1
// or node 2 not a Core, or fewer than three node numbers free of other
// suites' nodes.
//
// Env knobs:
//   DEVNET_DIR, API_PORT_BASE
//   MEMBER_SHARING_BOUND_SECS    time a write has to reach a node (60)
//   MEMBER_SHARING_SYNCED_SECS   time a member has to list a graph as synced (90)
//   MEMBER_SHARING_LATER_SECS    age of the members' subscription in case 5 (300)
//   MEMBER_SHARING_NODES         temporary nodes owner,member1,member2[,feeder] (default:
//                                those of 7, 8, 9, 10 with no folder and no listener
//                                on their API or libp2p port, in that order)
//   MEMBER_SHARING_BIG_ASSETS    assets of the large graph of case 6's first attempt (64)
//   MEMBER_SHARING_BIG_TRIPLES   triples per asset of that graph (2000)
//   MEMBER_SHARING_BUSY_ATTEMPTS attempts case 6 may make (3)
//   MEMBER_SHARING_KEEP_NODES=1  leave the temporary nodes running (debugging)
//
// Run against a running devnet: scripts/devnet-test-issue-3251-member-sharing.mjs
//
// This file orders the cases. The rest is under scripts/lib/: the temporary
// Edges (member-sharing/temporary-edges.mjs), the graphs and each graph's part
// of the run (member-sharing/graphs.mjs, graph-scenario.mjs), the writes,
// reads and watches, and each member's history with a graph's definition
// (member-sharing/observation.mjs), case 6 (member-sharing/busy-member.mjs),
// the report (member-sharing/report.mjs), and the judgements, which hold no
// I/O (qa/member-sharing.mjs, qa/busy-slot.mjs, qa/admission-trace.mjs,
// qa/known-gaps.mjs).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { busyMember, fillBigGraph } from './lib/member-sharing/busy-member.mjs';
import { openDevnet, sleep } from './lib/member-sharing/devnet.mjs';
import { GraphScenario } from './lib/member-sharing/graph-scenario.mjs';
import { createGraphs } from './lib/member-sharing/graphs.mjs';
import { createObservation, watched } from './lib/member-sharing/observation.mjs';
import { createReport } from './lib/member-sharing/report.mjs';
import { TemporaryEdges } from './lib/member-sharing/temporary-edges.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEVNET_DIR = process.env.DEVNET_DIR || join(REPO_ROOT, '.devnet');
const positive = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const BOUND_MS = positive('MEMBER_SHARING_BOUND_SECS', 60) * 1000;
const SYNCED_MS = positive('MEMBER_SHARING_SYNCED_SECS', 90) * 1000;
// A member must hold a graph's definition this long after it subscribed:
// without it the member's own writes into the graph are refused.
const DEFINITION_MS = 90_000;
const LATER_MS = positive('MEMBER_SHARING_LATER_SECS', 300) * 1000;
// Case 6's transfer must hold member 2's general slot until the writes made
// while it does have arrived, or the attempt proves nothing and the next one
// transfers another large graph, sized from what member 2's trace measured
// (busy-member.mjs), up to MEMBER_SHARING_BUSY_ATTEMPTS attempts in all.
const BIG_ASSETS = Math.round(positive('MEMBER_SHARING_BIG_ASSETS', 64));
const BIG_TRIPLES = Math.round(positive('MEMBER_SHARING_BIG_TRIPLES', 2000));
const BUSY_ATTEMPTS = Math.max(1, Math.round(positive('MEMBER_SHARING_BUSY_ATTEMPTS', 3)));
const SUB = 's';
const STAMP = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${process.pid}`;
const STARTED = Date.now();

const seconds = ms => Math.round(ms / 1000);
const elapsed = () => `t+${seconds(Date.now() - STARTED)}s`;

const CASES = {
  1: 'owner -> members, root and sub-graph, live',
  2: 'member -> owner -> other member, root and sub-graph, live',
  3: 'history: writes made before the members subscribed',
  4: 'after a member restart and after an owner restart',
  5: `members ${seconds(LATER_MS)} s after they subscribed`,
  6: 'member 2 while its general sync slot is busy with another graph',
  7: 'cases 1, 2, 3 on a registered graph; 1, 3 on a private graph',
  8: 'the synced flag of every member',
};
// The case each kind of check counts under: the public graph carries cases 1
// to 6; on the registered and the private graph every check is case 7. The
// synced flag is case 8 on every graph.
const PUBLIC_CASES = { history: 3, owner: 1, member: 2, definition: 3 };
const OTHER_CASES = { history: 7, owner: 7, member: 7, definition: 7 };
const DEADLINES = { definitionMs: DEFINITION_MS, syncedMs: SYNCED_MS };

const report = createReport(CASES);
const { say, note, fail } = report;
const devnet = openDevnet({
  repoRoot: REPO_ROOT, dir: DEVNET_DIR, adminToken: process.env.DKG_AUTH,
  apiPortBase: Number(process.env.API_PORT_BASE || 9201), libp2pPortBase: Number(process.env.LIBP2P_PORT_BASE || 10001),
});
const edges = new TemporaryEdges(devnet, { stamp: STAMP, log: report });
const graphs = createGraphs(devnet, edges, { stamp: STAMP, sub: SUB, say });
const io = createObservation(devnet, { boundMs: BOUND_MS, ...DEADLINES, stamp: STAMP, predicate: 'urn:issue3251:label' });
const scenarioIo = { ...io, subscribe: graphs.subscribe };
let EXIT = 0;

/** Before a case's writes: a topology that does not hold fails the case, since nothing it shows is about #3251. */
async function precondition(caseId, when) {
  const problems = await edges.topologyProblems();
  if (problems.length === 0) return true;
  fail(caseId, `${when}: the members do not reach the owner through the relay only, or reach each other: ${problems.join('; ')}`);
  return false;
}

// Whether the feeder could not be set up for a later attempt of case 6 (it is not tried again).
let feederFailed = false;

/** A feeder that ran must not follow the public graph (`publicGraph`), as no Core may: its gossip could carry writes. */
async function feederOutOf(publicGraph, when) {
  const fed = await graphs.following(edges.feeder, publicGraph);
  if (fed.state === 'following') fail(2, `${when} the feeder ${edges.feeder.label} follows the public graph: its gossip may have carried writes`);
  else if (fed.state !== 'not-following') fail(2, `${when} it is not known whether the feeder ${edges.feeder.label} follows the public graph (${fed.reason ?? fed.state})`);
}

/**
 * The large graph of case 6's attempt `attempt`, kept away from the Cores and
 * filled with `size` ({ assets, triples per asset }). The first is the
 * owner's. A later one is written by a feeder that holds nothing yet, started
 * for it (member 2 dials it through node 2), or put in place of the one that
 * wrote the attempt before (once it was seen out of `publicGraph`): the owner,
 * whose writes case 6 waits for, holds no more than before, and no node holds
 * the large graphs of several attempts. Without a feeder the owner writes it.
 */
async function largeGraph(attempt, size, publicGraph) {
  if (attempt > 1 && edges.feeder && !feederFailed) {
    try {
      if (edges.feederRunning) {
        await feederOutOf(publicGraph, `before attempt ${attempt} of case 6`);
        await edges.renewFeeder();
      } else await edges.startFeeder();
      say(`feeder ${edges.feeder.label} up, holding nothing yet, and dialed by member2 (${elapsed()})`);
    } catch (error) {
      note(`the feeder could not be set up (${error?.message ?? error}): the owner writes the large graphs of case 6's later attempts`);
      feederFailed = true;
    }
  }
  const author = edges.largeAuthor;
  const graph = await graphs.createGraph(attempt === 1 ? 'large' : `large${attempt}`, { accessPolicy: 0, publishPolicy: 1, register: false }, { by: author });
  await graphs.keepCoresOut(graph);
  const started = Date.now();
  await fillBigGraph(io, author, graph, { ...size, stamp: STAMP });
  say(`large graph ${graph.key} written: ${size.assets} assets of ${size.triples} triples in ${seconds(Date.now() - started)} s (${elapsed()})`);
  return { ...graph, size };
}

/** Waits for the watches, then reports each pair under its case, with its author's history with the definition as it stands now. */
async function settle(handles) {
  for (const pair of await watched(handles)) {
    report.reportPair(pair, { boundMs: BOUND_MS, definitionSeen: io.definitionSeen(pair.record.author, pair.record.graph) });
  }
}

async function run() {
  if (!devnet.adminToken) return skip('no devnet: no auth token');
  const relay1 = devnet.multiaddrOf(1);
  const relay2 = devnet.multiaddrOf(2);
  if (!relay1 || !relay2) return skip(`no devnet: the multiaddr of node 1 or node 2 is missing under ${DEVNET_DIR}`);
  if (devnet.nodeConfig(1)?.nodeRole !== 'core' || devnet.nodeConfig(2)?.nodeRole !== 'core') return skip('node 1 and node 2 must be Cores, the relays of the members');
  edges.reclaimLeftovers();
  const picked = edges.allocate({ explicit: process.env.MEMBER_SHARING_NODES, relay1, relay2 });
  if (picked.problem) return skip(picked.problem);
  if (picked.taken.length) note(`node numbers in use, left alone: ${picked.taken.join('; ')}`);
  const { owner, member1, member2, members } = edges;
  const feeder = edges.feeder ? `, node${edges.feeder.number} kept for the feeder of case 6's later attempts` : '';
  say(`bound ${seconds(BOUND_MS)} s per write, ${seconds(SYNCED_MS)} s for the synced flag; owner node${owner.number}, members node${member1.number} and node${member2.number} (member 2 with one sync slot and no queue)${feeder}; run ${STAMP}`);

  for (const node of edges.nodes) await edges.start(node);
  for (const member of members) await edges.dialOwner(member);
  say(`temporary Edges up and dialed (${elapsed()})`);

  // The unregistered public graph carries cases 1 to 6; without it nothing runs.
  // A registered or a private graph that cannot be set up fails case 7 and
  // leaves the other cases to run.
  const pub = new GraphScenario(await graphs.createGraph('public', { accessPolicy: 0, publishPolicy: 1, register: false }),
    { cases: PUBLIC_CASES, authors: members, required: true, sub: SUB });
  await graphs.keepCoresOut(pub.graph);
  const scenarios = [pub];
  for (const [key, body, authors] of [
    ['registered', { accessPolicy: 0, publishPolicy: 1, register: true }, [member1]],
    ['private', { accessPolicy: 1, publishPolicy: 0, register: true, allowedAgents: edges.nodes.map(node => node.agentAddress) }, []],
  ]) {
    try {
      scenarios.push(new GraphScenario(await graphs.createGraph(key, body), { cases: OTHER_CASES, authors, sub: SUB }));
    } catch (error) { fail(7, `the ${key} graph could not be set up: ${error?.message ?? error}; no case runs on it`); }
  }
  // The large graph of case 6's first attempt; a failure here fails case 6 only.
  let big = null;
  try {
    big = await largeGraph(1, { assets: BIG_ASSETS, triples: BIG_TRIPLES }, pub.graph);
  } catch (error) {
    fail(6, `the large graph could not be set up: ${error?.message ?? error}; case 6 did not run`);
    big = null;
  }

  // Case 3 (7): history, written before the members subscribe. Each member's
  // bound starts at its own subscribe, and so does the watch of its synced flag
  // (case 8). A graph a member cannot join is dropped with what is pending on it.
  await precondition(3, 'before the history');
  for (const scenario of scenarios) await scenario.writeHistory(scenarioIo, owner);
  for (const scenario of scenarios) {
    const problem = await scenario.subscribeMembers(scenarioIo, members);
    if (problem) fail(7, `${scenario.graph.key}: ${problem}; no case runs on this graph`);
  }
  const active = scenarios.filter(scenario => scenario.active);
  say(`members subscribed (${elapsed()})`);
  const observed = await Promise.all(active.map(scenario => scenario.observedSubscriptions()));
  active.forEach((scenario, i) => {
    for (const subscription of observed[i]) report.reportSubscription(scenario.cases.definition, subscription, DEADLINES);
  });
  await settle((await Promise.all(active.map(scenario => scenario.historyWatches()))).flat());

  // Case 1 (7): the owner writes, live. Case 2 (7): a member writes; the owner
  // and the other member must hold it.
  await precondition(1, 'before the owner writes');
  const live = [];
  for (const scenario of active) live.push(...await scenario.ownerWrites(scenarioIo, owner, members));
  await precondition(2, 'before the members write');
  for (const scenario of active) live.push(...await scenario.memberWrites(scenarioIo, owner, members));
  await settle(live);

  // Case 6: member 2's only general sync slot busy with a large transfer of another graph. A relay's circuit
  // lasts 30 min, and the attempts with their large graphs can take long: before each one the members dial the
  // owner again and member 2 the feeder (a dial of a node already connected changes nothing).
  const redial = async () => {
    for (const member of members) await edges.dialOwner(member);
    if (edges.feederUp) await edges.dial(member2, edges.feeder);
  };
  if (big) {
    const nextLargeGraph = (attempt, size) => largeGraph(attempt, size, pub.graph);
    await busyMember({ devnet, edges, graphs, io, report, precondition, boundMs: BOUND_MS, sub: SUB, attempts: BUSY_ATTEMPTS, largeGraph: nextLargeGraph, connect: redial }, pub.graph, big);
  }
  // A feeder that ran must not have followed the public graph, as no Core may; then it stops, and the cases
  // after case 6 run with the owner and the members alone, as before it. One that cannot be stopped (asked
  // twice) fails case 6: the cases after it would run beside it.
  if (edges.feederRunning) {
    await feederOutOf(pub.graph, 'after case 6');
    const stopped = await edges.stopFeeder().catch(() => edges.stopFeeder()).then(() => null, error => error);
    if (stopped) fail(6, `the feeder ${edges.feeder.label} could not be stopped after case 6, so the cases after it run beside it: ${stopped?.message ?? stopped}`);
  }

  // Case 5: members that subscribed LATER_MS ago (after case 6, the members dial the owner again, as above).
  const since = Math.max(...members.map(member => pub.subscribedAt.get(member)));
  const rest = since + LATER_MS - Date.now();
  if (rest > 0) { say(`waiting ${seconds(rest)} s for case 5 (${elapsed()})`); await sleep(rest); }
  // A member that cannot dial the owner fails case 5's precondition below.
  for (const member of members) await edges.dialOwner(member).catch(error => note(`before case 5: ${error?.message ?? error}`));
  await precondition(5, `${seconds(Date.now() - since)} s after the members subscribed`);
  await settle([
    await io.writeAndWatch(5, owner, pub.graph, null, 'owner later, root', members),
    await io.writeAndWatch(5, owner, pub.graph, SUB, 'owner later, sub-graph', members),
    await io.writeAndWatch(5, member1, pub.graph, null, 'member1 later, root', [owner, member2]),
    await io.writeAndWatch(5, member2, pub.graph, SUB, 'member2 later, sub-graph', [owner, member1]),
  ]);

  // Case 4: a member restart. What was written while it was down must reach it
  // within the bound of its return; the nodes that stayed up get the usual bound.
  await edges.stop(member1);
  const whileDown = [
    await io.writeAndWatch(4, owner, pub.graph, null, 'owner while member1 is down, root', [member2]),
    await io.writeAndWatch(4, owner, pub.graph, SUB, 'owner while member1 is down, sub-graph', [member2]),
    await io.writeAndWatch(4, member2, pub.graph, null, 'member2 while member1 is down, root', [owner]),
  ];
  const missed = whileDown.map(handle => handle.pairs[0].record);
  await edges.restart(member1);
  await edges.dialOwner(member1);
  const backAt = Date.now();
  whileDown.push(io.watch(missed.map(record => ({ caseId: 4, record, node: member1, from: backAt, fromWhat: 'member restarted' }))));
  await precondition(4, 'after the member restart');
  whileDown.push(await io.writeAndWatch(4, owner, pub.graph, SUB, 'owner after member1 restarted, sub-graph', members));
  await settle(whileDown);

  // Then an owner restart: live writes in both directions.
  await edges.restart(owner);
  for (const member of members) await edges.dialOwner(member);
  await precondition(4, 'after the owner restart');
  await settle([
    await io.writeAndWatch(4, owner, pub.graph, null, 'owner after it restarted, root', members),
    await io.writeAndWatch(4, member2, pub.graph, SUB, 'member2 after the owner restarted, sub-graph', [owner, member1]),
  ]);

  // No Core carried anything, and the members never reached each other.
  const cores = await graphs.coresFollowing(pub.graph);
  if (cores.following.length) fail(2, `at the end Core(s) ${cores.following.join(', ')} follow the public graph: their gossip may have carried writes`);
  if (cores.unknown.length) fail(2, `at the end it is not known whether Core(s) ${cores.unknown.join(', ')} follow the public graph`);
  await precondition(2, 'at the end');
}

function skip(reason) { say(`SKIP: ${reason}`); EXIT = 3; }

const cleanup = () => edges.cleanup({ keep: process.env.MEMBER_SHARING_KEEP_NODES === '1', failed: report.anyFailed() || EXIT === 1 });
const interrupted = (signal, code) => () => { say(`stopped by ${signal}`); cleanup(); process.exit(code); };
process.once('SIGINT', interrupted('SIGINT', 130));
process.once('SIGTERM', interrupted('SIGTERM', 143));

try {
  await run();
} catch (error) {
  console.log(`  [FAIL] the run stopped: ${error?.message ?? error}`);
  EXIT = 1;
}
cleanup();
if (EXIT !== 3) {
  const failed = report.summary(`Results (${elapsed()}; bound ${seconds(BOUND_MS)} s per write, ${seconds(SYNCED_MS)} s for the synced flag):`);
  if (failed.length) EXIT = 1;
}
process.exit(EXIT);
