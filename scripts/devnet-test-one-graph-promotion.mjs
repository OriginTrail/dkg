#!/usr/bin/env node
//
// one-graph promotion: Edges share signed reports into the shared memory of
// one registered context graph, a curator promotes chosen reports to its
// Verified Memory, and every Edge follows. Each report reaches every other
// Edge; a promoted report is in every Edge's Verified Memory and in no Edge's
// shared memory; its author keeps sharing; an Edge that subscribes later
// recovers both layers; and an Edge whose only sync slot a large transfer of
// another graph holds still receives.
//
// The graph. One public context graph, registered on chain, with a curated
// publish policy (`publishPolicy: 0`): only its owner, the curator, publishes
// to its Verified Memory. Shared memory follows the access policy alone
// (isSwmAuthorAuthorized, packages/agent/src/rfc64/catalog-access-policy-v1.ts),
// so every Edge writes it. Reports go to the graph's named sub-graph
// `reports`, not its root, which holds at most 64 author catalogs. A report is
// one asset of three triples with a subject of its own, created with its seal
// and shared through the asynchronous share job, as a client does it. The
// curator promotes a report another Edge authored with POST
// /api/knowledge-assets/:name/vm/publish, naming the sub-graph and the author
// (`selectedAuthorAgentAddress`, one of the authors resident at that name);
// the asset is published under its author's seal.
//
// The Edges. Four temporary Edges on one node profile
// (scripts/lib/one-graph/profile.mjs). Config: `syncOnConnectEnabled` true,
// `syncReconcilerEnabled` false, `vmReconcilerEnabled` true,
// `vmRecoveryPrefetchEnabled` true, `durableSyncEnabled` true,
// `syncGlobalMaxInflight` 1, `syncGlobalQueueLimit` 0. Environment:
// DKG_EXACT_BATCH_STREAM_ENABLED=1, DKG_CATCHUP_MAX_CONCURRENT_PEERS=1,
// DKG_STORE_QUEUE_WAIT_TIMEOUT_MS=300000, DKG_SYNC_TOTAL_TIMEOUT_MS=1800000,
// DKG_SWM_RECOVERY_TIMEOUT_MS=3600000, DKG_STORE_QUEUE_LIMIT=512. The
// variables that would override those config members are set empty for each
// Edge (the node reads an empty value as unset), so the caller's environment
// cannot change them. Roles: the curator; edgeA and edgeB, which write
// reports; late, which starts and subscribes late in the run. Each Edge
// reserves a relay slot on node 1 and node 2 and announces, in place of its
// listen address, a port nobody listens on and its circuit addresses through
// them: Edges reach each other only through a relay, and dial the Cores
// directly, as an Edge behind NAT reaches the public nodes. The Cores host the
// registered graph, as on the public network. Before each case the suite
// checks that no two Edges hold a direct connection, that every Edge holds
// one to a Core, and that none holds one to a peer outside the devnet. The
// devnet's own Edges take no part: they never subscribe to the graph.
//
// Bounds: the time a node has to show what a check waits for. A node is read
// twice, with the layer's view (`shared-working-memory` or
// `verifiable-memory`, with `subGraphName`) and with the cross-partition read
// (`includeContextGraphPartitions`, GRAPH ?g) kept to the layer's graphs of
// the sub-graph; each read counts with the time it completed.
//   ONE_GRAPH_BOUND_SECS (60): a report, from the end of its share job, to be
//     in the shared memory of every other subscribed Edge; a promotion, from
//     the curator's confirmed publish, to be in every Edge's Verified Memory
//     and out of every Edge's shared memory, where it must stay out to the end
//     of the bound.
//   ONE_GRAPH_RECOVERY_SECS (90): the late Edge, from its subscribe, to hold
//     every promoted report in Verified Memory and not in shared memory, and
//     every other report in shared memory.
//   ONE_GRAPH_SYNCED_SECS (90): a subscriber, from its subscribe, to list the
//     graph as synced. It must also hold the graph's definition within 90 s,
//     or its own writes are refused.
//
// Cases (each line of the report names the case, the report, the node and
// what did not hold):
//   1  every Edge runs the profile: the build the devnet runs reads every
//      member and variable of the profile; each Edge's status shows its peer
//      reconciler off and VM reconciliation on, and its log one general sync
//      slot and no queue
//   2  reports reach every other Edge, live: edgeA and edgeB share two
//      reports each; the curator and the other author must hold each
//   3  the publish policy holds: edgeA's own publish of its second report is
//      refused, and no Edge holds that report in Verified Memory
//   4  promotion: the curator promotes the first report of each author; every
//      Edge, its author included, holds it in Verified Memory and no longer in
//      shared memory, and every report not promoted stays in shared memory
//   5  an author whose report was promoted still shares: edgeA and edgeB
//      share one more report each, and every other Edge must hold it
//   6  edgeB's only sync slot is held by a large Verified Memory transfer of
//      another graph (ONE_GRAPH_LARGE_ASSETS x ONE_GRAPH_LARGE_TRIPLES, which
//      the curator publishes) while edgeA shares a report and the curator
//      promotes the report of case 3. edgeB must hold the new report, and the
//      promoted one in Verified Memory and not in shared memory, within the
//      bound, and its own evidence must show the transfer in its general slot
//      until then (scripts/lib/one-graph/busy-transfer.mjs); a check passed
//      after the transfer left the slot fails as not exercised
//   7  the late Edge recovers both layers within ONE_GRAPH_RECOVERY_SECS, then
//      shares a report that every other Edge must hold
//   8  the synced flag: every subscriber lists the graph as synced within
//      ONE_GRAPH_SYNCED_SECS, and every Edge lists it so at the end
//   9  the end state: on every Edge, each promoted report is in Verified
//      Memory and not in shared memory, and every other report is in shared
//      memory
//
// Exit codes: 0 every case passed; 1 a case failed or was not run; 3 the
// devnet cannot host the scenario and nothing was exercised: no devnet, node 1
// or node 2 not a Core, or fewer than four node numbers free of other suites'
// nodes.
//
// Env knobs:
//   DEVNET_DIR, API_PORT_BASE, LIBP2P_PORT_BASE, DKG_AUTH
//   DEVNET_REPO_ROOT          the checkout whose devnet.sh adds and stops the
//                             Edges and whose build they run (default: this one)
//   ONE_GRAPH_BOUND_SECS, ONE_GRAPH_RECOVERY_SECS, ONE_GRAPH_SYNCED_SECS (above)
//   ONE_GRAPH_NODES           the temporary nodes curator,edgeA,edgeB,late
//                             (default: the first four of 7, 8, 9, 10 with no
//                             folder and no listener on their ports)
//   ONE_GRAPH_LARGE_ASSETS    assets of the large graph of case 6 (24)
//   ONE_GRAPH_LARGE_TRIPLES   triples per asset of that graph (3000)
//   ONE_GRAPH_KEEP_NODES=1    leave the temporary nodes running (debugging)
// Run it with the DEVNET_* environment the devnet was started with: the Edges
// get the config blocks it selects (the publisher's, the chain RPC budget).
//
// The temporary nodes, their marks and their cleanup are the member-sharing
// suite's (scripts/lib/member-sharing/temporary-edges.mjs): a node left by a
// run of either suite that was killed is removed when either starts. A
// failing run keeps every Edge's log, and the part of every other node's log
// written since the run began, under <DEVNET_DIR>/one-graph-promotion/<run>.
//
// Run against a running devnet: scripts/devnet-test-one-graph-promotion.mjs
//
// This file orders the cases. The rest is under scripts/lib/: the profile and
// the temporary Edges (one-graph/profile.mjs, edges.mjs), the graphs
// (one-graph/graphs.mjs), the reports, reads and watches
// (one-graph/reports.mjs), case 6 (one-graph/busy-transfer.mjs), and the
// judgements, which hold no I/O (qa/one-graph-promotion.mjs). It reuses the
// member-sharing suite's devnet access, temporary Edges, client-like write,
// subscription observer, report and shared-memory judgements.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brief, openDevnet, waitFor } from './lib/member-sharing/devnet.mjs';
import { createReport } from './lib/member-sharing/report.mjs';
import { describe, subscriptionResults } from './lib/qa/member-sharing.mjs';
import {
  admissionPolicyProblem, memberPublishOutcome, pairOutcome, parseAdmissions, profileStatusProblems, promotionOutcome,
} from './lib/qa/one-graph-promotion.mjs';
import { busyEdge } from './lib/one-graph/busy-transfer.mjs';
import { OneGraphEdges } from './lib/one-graph/edges.mjs';
import { createGraphs } from './lib/one-graph/graphs.mjs';
import { inheritedDkgEnv, PROFILE_CONFIG, PROFILE_ENV, PROFILE_NAMES } from './lib/one-graph/profile.mjs';
import { createReports, settled } from './lib/one-graph/reports.mjs';

const SUITE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = process.env.DEVNET_REPO_ROOT || SUITE_ROOT;
const DEVNET_DIR = process.env.DEVNET_DIR || join(REPO_ROOT, '.devnet');
const positive = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const BOUND_MS = positive('ONE_GRAPH_BOUND_SECS', 60) * 1000;
const RECOVERY_MS = positive('ONE_GRAPH_RECOVERY_SECS', 90) * 1000;
const SYNCED_MS = positive('ONE_GRAPH_SYNCED_SECS', 90) * 1000;
// A subscriber must hold the graph's definition this long after it subscribed:
// without it its own writes into the graph are refused.
const DEFINITION_MS = 90_000;
// The reports that should already be where they are, read once more.
const CHECK_MS = 30_000;
const LARGE_ASSETS = Math.round(positive('ONE_GRAPH_LARGE_ASSETS', 24));
const LARGE_TRIPLES = Math.round(positive('ONE_GRAPH_LARGE_TRIPLES', 3000));
const SUB = 'reports';
const STAMP = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${process.pid}`;
const STARTED = Date.now();

const seconds = ms => Math.round(ms / 1000);
const elapsed = () => `t+${seconds(Date.now() - STARTED)}s`;

const CASES = {
  1: 'every Edge runs the profile',
  2: 'reports reach every other Edge, live',
  3: 'a member\'s own publish to Verified Memory is refused',
  4: 'promotion: in every Edge\'s Verified Memory, out of its shared memory',
  5: 'an author whose report was promoted still shares',
  6: 'a large Verified Memory transfer holds an Edge\'s only sync slot',
  7: 'a late Edge recovers Verified Memory and shared memory',
  8: 'the synced flag of every Edge',
  9: 'the end state on every Edge',
};

// The member-sharing suite's report, its lines under this suite's name.
const PREFIX = '[issue-3251] ';
const report = createReport(CASES, { print: line => console.log(line.startsWith(PREFIX) ? `[one-graph] ${line.slice(PREFIX.length)}` : line) });
const { say, note, pass, fail } = report;
const devnet = openDevnet({
  repoRoot: REPO_ROOT, dir: DEVNET_DIR, adminToken: process.env.DKG_AUTH,
  apiPortBase: Number(process.env.API_PORT_BASE || 9201), libp2pPortBase: Number(process.env.LIBP2P_PORT_BASE || 10001),
});
const edges = new OneGraphEdges(devnet, { stamp: STAMP, log: report });
const graphs = createGraphs(devnet, { stamp: STAMP, say });
const io = createReports(devnet, {
  stamp: STAMP, sub: SUB, predicate: 'urn:one-graph:label', type: 'urn:one-graph:Report',
  boundMs: BOUND_MS, definitionMs: DEFINITION_MS, syncedMs: SYNCED_MS,
});
// Each node's log size when the run began: a failing run keeps what came after.
const offsets = new Map();
let EXIT = 0;

/** Before a case's writes: a topology that does not hold fails the case. */
async function precondition(caseId, when) {
  const { problems, relayedPairs } = await edges.topologyProblems();
  if (problems.length === 0) {
    note(`case ${caseId}, ${when}: no direct link between Edges; linked through a relay: ${relayedPairs.join(', ') || 'none'}`);
    return true;
  }
  fail(caseId, `${when}: the Edges do not reach each other through relays only: ${problems.join('; ')}`);
  return false;
}

/** Waits for the watches, then reports each pair under its case. */
async function settle(handles) {
  for (const pair of await settled(handles)) {
    const result = pairOutcome(pair, { boundMs: BOUND_MS });
    (result.outcome === 'pass' ? pass : fail)(pair.caseId, result.text);
  }
}

/**
 * The profile's names that the build the devnet runs never mentions: a
 * setting no node reads. A variable counts when the build reads it from the
 * environment or names it in quotes; a config member, when it names it.
 */
function unreadProfileNames() {
  const pending = new Map(PROFILE_NAMES.map(name => [name, name in PROFILE_ENV
    ? new RegExp(`process\\.env\\.${name}\\b|['"\`]${name}['"\`]`)
    : new RegExp(`\\b${name}\\b`)]));
  const visit = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (pending.size === 0) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') visit(path);
      } else if (entry.name.endsWith('.js')) {
        const text = readFileSync(path, 'utf8');
        for (const [name, pattern] of pending) if (pattern.test(text)) pending.delete(name);
      }
    }
  };
  const packages = join(REPO_ROOT, 'packages');
  let builds = 0;
  for (const name of readdirSync(packages)) {
    const dist = join(packages, name, 'dist');
    try {
      if (!statSync(dist).isDirectory()) continue;
    } catch { continue; }
    builds += 1;
    visit(dist);
  }
  return builds ? { missing: [...pending.keys()] } : { problem: `no build under ${packages}` };
}

/** Case 1 for each Edge: its status and its own log show the profile. */
async function checkProfile(nodes) {
  for (const node of nodes) {
    const status = await devnet.api(node, 'GET', '/api/status');
    const problems = status.status === 200 ? profileStatusProblems(status.json) : [`its status could not be read (${brief(status)})`];
    const admitted = await waitFor(async () => {
      const last = parseAdmissions(devnet.logSince(node, 0)).filter(admission => !admission.reserved).at(-1);
      return { ok: Boolean(last), last };
    }, 60_000, 2000);
    const policy = admitted.ok ? admissionPolicyProblem(admitted.last) : 'its log shows no sync admission within 60 s';
    if (policy) problems.push(policy);
    if (problems.length) fail(1, `${node.label} does not run the profile: ${problems.join('; ')}`);
    else pass(1, `${node.label} runs the profile: peer reconciler off, VM reconciliation on, one general sync slot and no queue`);
  }
}

/**
 * What an author's status says of its shared-memory catalog once its report
 * was promoted: the sweeps of finalized assets' rows and the catalog capacity
 * counts (the `rfc64Catalog` block of /api/status), for the run's notes.
 */
async function catalogStatus(node) {
  const status = await devnet.api(node, 'GET', '/api/status');
  const block = status.json?.rfc64Catalog;
  if (!block) return status.status === 200 ? 'no rfc64Catalog block' : brief(status);
  const { enabled, finalizedRowHeal, authorCatalogCapacity } = block;
  return JSON.stringify({ enabled, finalizedRowHeal, authorCatalogCapacity }).slice(0, 400);
}

/** A settled subscription: a missing definition under `definitionCase`, the synced flag under case 8. */
function reportSubscription(handle, observation, definitionCase) {
  if (!observation) return fail(definitionCase, `${handle.node.label}: its subscription to ${handle.graph.key} was not observed`);
  const { definition, synced } = subscriptionResults(observation, {
    registered: true, private: false, member: true, definitionMs: DEFINITION_MS, syncedMs: SYNCED_MS,
  });
  if (definition.outcome !== 'pass') fail(definitionCase, `${handle.node.label}, ${handle.graph.key}: ${definition.text}`);
  (synced.outcome === 'pass' ? pass : fail)(8, `${handle.node.label}, ${handle.graph.key}: ${synced.text}`);
  return undefined;
}

/** The pairs every Edge in `nodes` must show for each report, by where it should be by now. */
function placementPairs(caseId, records, promoted, nodes, options) {
  return records.filter(record => !record.error).flatMap(record => (promoted.has(record)
    ? [...io.pairs(caseId, record, nodes, 'vm', options), ...io.pairs(caseId, record, nodes, 'absent', options)]
    : io.pairs(caseId, record, nodes, 'swm', options)));
}

async function run() {
  if (!devnet.adminToken) return skip('no devnet: no auth token');
  const relays = [devnet.multiaddrOf(1), devnet.multiaddrOf(2)];
  if (relays.some(relay => !relay)) return skip(`no devnet: the multiaddr of node 1 or node 2 is missing under ${DEVNET_DIR}`);
  if (devnet.nodeConfig(1)?.nodeRole !== 'core' || devnet.nodeConfig(2)?.nodeRole !== 'core') return skip('node 1 and node 2 must be Cores, the relays of the Edges');
  edges.reclaimLeftovers();
  const picked = edges.allocate({ explicit: process.env.ONE_GRAPH_NODES, relays });
  if (picked.problem) return skip(picked.problem);
  if (picked.taken.length) note(`node numbers in use, left alone: ${picked.taken.join('; ')}`);
  for (const number of devnet.nodeNumbers()) offsets.set(number, devnet.logSize(number));
  const { curator, edgeA, edgeB, late } = edges;
  say(`bounds: ${seconds(BOUND_MS)} s for a report or a promotion, ${seconds(RECOVERY_MS)} s for the late Edge's recovery, ${seconds(SYNCED_MS)} s for the synced flag; curator node${curator.number}, edgeA node${edgeA.number}, edgeB node${edgeB.number}, late node${late.number}; run ${STAMP}`);
  say(`profile: ${JSON.stringify(PROFILE_CONFIG)} ${Object.entries(PROFILE_ENV).map(([name, value]) => `${name}=${value}`).join(' ')}`);
  const inherited = inheritedDkgEnv(process.env);
  if (inherited.length) note(`every node of the devnet inherits ${inherited.join(', ')} from this environment: the Edges differ from the profile by each one a node reads`);

  // Case 1: the profile, in the build and on every Edge.
  const unread = unreadProfileNames();
  if (unread.problem) fail(1, unread.problem);
  else if (unread.missing.length) fail(1, `the build the devnet runs never reads ${unread.missing.join(', ')}: the profile sets ${unread.missing.length === 1 ? 'it' : 'them'} to no effect`);
  else pass(1, `the build reads every setting of the profile (${PROFILE_NAMES.length})`);
  for (const node of [curator, edgeA, edgeB]) await edges.start(node);
  say(`curator, edgeA and edgeB up (${elapsed()})`);
  await checkProfile([curator, edgeA, edgeB]);
  await precondition(1, 'once the Edges are up');

  // The graph; edgeA and edgeB subscribe. Their subscriptions settle while
  // the first reports go out: a missing definition shows as refused writes.
  const main = await graphs.createGraph(curator, 'main', { publishPolicy: 0, sub: SUB });
  const observers = [];
  for (const member of [edgeA, edgeB]) observers.push(io.observeSubscription(member, main, await graphs.subscribe(member, main)));
  say(`edgeA and edgeB subscribed (${elapsed()})`);

  // Case 2: reports, live; every other running Edge must hold each.
  await precondition(2, 'before the reports');
  const others = author => edges.running.filter(node => node !== author);
  const shared = [];
  const byAuthor = new Map([[edgeA, []], [edgeB, []]]);
  const live = [];
  for (const author of [edgeA, edgeB]) {
    for (const n of [1, 2]) {
      const record = await io.share(author, main, `${author.role} report ${n}`);
      shared.push(record);
      byAuthor.get(author).push(record);
      live.push(io.watch(io.pairs(2, record, others(author), 'swm')));
    }
  }
  await settle(live);
  for (const handle of observers) reportSubscription(handle, await handle.done, 2);

  // Case 3: edgeA publishes its second report itself.
  const [a1, a2] = byAuthor.get(edgeA);
  const [b1] = byAuthor.get(edgeB);
  const promoted = new Set();
  if (a2.error) fail(3, `${describe(a2)} was not written, so its publish was not tried`);
  else {
    const { answer, at } = await io.ownPublish(edgeA, a2);
    const own = memberPublishOutcome(answer);
    if (own.refused) pass(3, `${edgeA.label}'s own publish of ${describe(a2)} was refused: ${own.why}`);
    else {
      fail(3, `${edgeA.label}, not the curator, published ${describe(a2)} to Verified Memory: ${own.why}`);
      // It is in Verified Memory now: the later cases expect it there and out of shared memory.
      promoted.add(a2);
    }
    await settle([io.watch(io.pairs(3, a2, edges.running, own.refused ? 'unpublished' : 'vm', { from: at, fromWhat: `${edgeA.role}'s own publish` }))]);
  }

  // Case 4: the curator promotes the first report of each author.
  await precondition(4, 'before the promotions');
  const promotions = [];
  for (const record of [a1, b1]) {
    if (record.error) {
      fail(4, `${describe(record)} was not written, so it was not promoted`);
      continue;
    }
    const { answer, at } = await io.promote(curator, record);
    const outcome = promotionOutcome(answer, { authorAddress: record.author.agentAddress });
    if (!outcome.ok) {
      fail(4, `the curator could not promote ${describe(record)}: ${outcome.why}`);
      continue;
    }
    promoted.add(record);
    say(`promoted ${describe(record)}: ${outcome.ual ?? 'no UAL'} (${elapsed()})`);
    const options = { from: at, fromWhat: 'promotion' };
    promotions.push(io.watch([...io.pairs(4, record, edges.running, 'vm', options), ...io.pairs(4, record, edges.running, 'gone', options)]));
  }
  await settle(promotions);
  const check = () => ({ from: Date.now(), fromWhat: 'check', bound: CHECK_MS });
  const notPromoted = shared.filter(record => !record.error && !promoted.has(record));
  await settle([io.watch(notPromoted.flatMap(record => io.pairs(4, record, edges.running, 'kept', check())))]);
  for (const record of promoted) {
    note(`case 4: on its author, ${describe(record)} has the record ${await io.lifecycle(record.author, record)}; the author's catalog status: ${await catalogStatus(record.author)}`);
  }

  // Case 5: the authors share again.
  await precondition(5, 'before the authors share again');
  const again = [];
  for (const author of [edgeA, edgeB]) {
    const record = await io.share(author, main, `${author.role} after its promotion`);
    shared.push(record);
    again.push(io.watch(io.pairs(5, record, others(author), 'swm')));
  }
  await settle(again);

  // Case 6: edgeB's only sync slot busy with a large transfer of another graph.
  let large = null;
  try {
    large = await graphs.createGraph(curator, 'large', { publishPolicy: 0 });
    const took = await graphs.fillLargeGraph(io, curator, large, { assets: LARGE_ASSETS, triples: LARGE_TRIPLES });
    say(`large graph published: ${LARGE_ASSETS} assets of ${LARGE_TRIPLES} triples in ${took} s (${elapsed()})`);
  } catch (error) {
    fail(6, `the large graph could not be set up: ${error?.message ?? error}; case 6 did not run`);
    large = null;
  }
  if (large && await precondition(6, 'before the large transfer')) {
    const busy = await busyEdge({ devnet, edges, graphs, io, report, caseId: 6, boundMs: BOUND_MS }, main, large,
      a2.error || promoted.has(a2) ? null : a2);
    if (busy.shared) shared.push(busy.shared);
    if (busy.promoted) promoted.add(a2);
  }

  // Case 7: the late Edge starts, subscribes and recovers; then it shares.
  await edges.start(late);
  say(`late Edge up (${elapsed()})`);
  await checkProfile([late]);
  await precondition(7, 'once the late Edge is up');
  const subscribedAt = await graphs.subscribe(late, main);
  const lateObserver = io.observeSubscription(late, main, subscribedAt);
  await settle([io.watch(placementPairs(7, shared, promoted, [late], { from: subscribedAt, fromWhat: 'late Edge subscribed', bound: RECOVERY_MS }))]);
  reportSubscription(lateObserver, await lateObserver.done, 7);
  const fromLate = await io.share(late, main, 'late report');
  shared.push(fromLate);
  await settle([io.watch(io.pairs(7, fromLate, others(late), 'swm'))]);

  // Case 8: every Edge lists the graph as synced at the end.
  for (const node of edges.running) {
    const listed = await io.listingEntry(node, main);
    if (!listed.readable) fail(8, `${node.label}: its listing could not be read at the end (${listed.why})`);
    else if (listed.entry?.synced === true) pass(8, `${node.label}: lists ${main.key} as synced at the end`);
    else fail(8, `${node.label}: lists ${main.key} as ${listed.entry ? `subscribed=${listed.entry.subscribed} synced=${listed.entry.synced}` : 'absent'} at the end`);
  }

  // Case 9: the end state on every Edge.
  await settle([io.watch(placementPairs(9, shared, promoted, edges.running, check()))]);
  await precondition(9, 'at the end');
}

function skip(reason) { say(`SKIP: ${reason}`); EXIT = 3; }

const cleanup = () => edges.cleanup({ keep: process.env.ONE_GRAPH_KEEP_NODES === '1', failed: report.anyFailed() || EXIT === 1, offsets });
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
  const failed = report.summary(`Results (${elapsed()}; ${seconds(BOUND_MS)} s per report or promotion, ${seconds(RECOVERY_MS)} s for the late Edge, ${seconds(SYNCED_MS)} s for the synced flag):`);
  if (failed.length) EXIT = 1;
}
process.exit(EXIT);
