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
//     and out of every Edge's shared memory, where it must stay out at every
//     reading to the end of the bound.
//   ONE_GRAPH_RECOVERY_SECS (90): the late Edge, from its second subscribe
//     (the remedy's, case 10), to hold every promoted report in Verified
//     Memory and not in shared memory, and every other report in shared
//     memory.
//   ONE_GRAPH_SYNCED_SECS (90): a subscriber, from its subscribe, to list the
//     graph as synced. It must also hold the graph's definition within 90 s,
//     or its own writes are refused.
//
// The client remedy (case 10). Every subscriber, once its subscription's
// checks have settled, does what a client can to write the graph whether it
// needs to or not, so that the gate proves the path keeps working: it dials
// the curator through its relay (a subscriber asks only the peers it is
// connected to for the graph's declaration, and the curator may be the only
// one that holds it), subscribes again with an explicit catch-up
// (`forceCatchup`) and must hold the definition within 90 s; it writes a
// report into the sub-graph before registering the sub-graph itself (a check
// of its own, see the known gaps), then registers it and must list it. Its
// later bounds count from that second subscribe. A subscriber's report
// refused because the graph is not yet synced for its writes is made again
// until its synced deadline, as a client does.
//
// Known gaps (scripts/lib/qa/known-gaps.mjs, applied to every check before it
// is reported): a check that fails for the reason of an open issue, with
// evidence of that reason, prints as XFAIL with the issue and does not fail
// its case; the same check holding prints as XPASS, so that the gap can be
// retired. #3264: a subscriber that never obtains the definition (its
// listing shows no access policy, and it never did), and its synced flag
// (cases 2, 7, 8). #3293: a subscriber that holds the definition but whose
// write into the sub-graph is refused with HTTP 500 naming the unregistered
// sub-graph, its listing naming none (cases 2, 7). #3294: the curator's
// promotion of another Edge's report refused with HTTP 409
// ASSERTION_AUTHOR_NOT_RESIDENT, though the report was in its shared memory
// (cases 4, 6), and the share after it that is then not exercised (case 5).
// #3296: a late Edge that held every report when its second subscribe was
// accepted, never marked synced because its catch-up inserted no data (its
// log shows the catch-up's shared-memory passes, none with data; case 8).
//
// Cases (each line of the report names the case, the report, the node and
// what did not hold):
//   1  every Edge runs the profile: each Edge's status shows its peer
//      reconciler off and VM reconciliation on, and its log one general sync
//      slot and no queue. A setting of the profile the build never reads is
//      noted (it is the deployment's setting, not node behaviour)
//   2  reports reach every other Edge, live: the curator, edgeA and edgeB
//      share two reports each; every other Edge must hold each. Also the
//      subscription checks of edgeA and edgeB: the definition within 90 s,
//      and the write into the sub-graph before registering it
//   3  the publish policy holds: edgeA's own publish of its second report is
//      refused by the chain's publisher authorization (any other failure of
//      the publish leaves the policy unexercised and fails the case), and no
//      Edge holds that report in Verified Memory
//   4  promotion: the curator promotes the first report of each Edge, its
//      own included (each promotion is a check); every Edge, the author
//      included, holds it in Verified Memory and no longer in shared memory,
//      and every report not promoted is in shared memory at every reading,
//      from before the first promotion to the end of the last one's watch
//   5  an author whose report was promoted still shares: edgeA and edgeB,
//      each once its report of case 4 was promoted, share one more report,
//      and every other Edge must hold it. An author whose report was not
//      promoted leaves the check not exercised (#3294 when its promotion was
//      refused as not resident)
//   6  edgeB's only sync slot is held by a large Verified Memory transfer of
//      another graph (ONE_GRAPH_LARGE_ASSETS x ONE_GRAPH_LARGE_TRIPLES, which
//      the curator publishes) while edgeA shares a report and the curator
//      promotes edgeA's report of case 3 and its own second report. edgeB
//      must hold the new report, and each promoted one in Verified Memory and
//      not in shared memory, within the bound and within the transfer's life,
//      with edgeB's log and diagnostics as the evidence of the busy slot. The
//      transfer is many short admissions (`durable:<graph>:<peer>`, one or a
//      few assets each). A report, which arrives through gossip, must land
//      while one of them holds the slot, so edgeA shares again, up to 6 times
//      while the transfer runs, until one does. A promotion, whose delivery
//      needs the slot itself, must have contended with the transfer: a
//      reading between the promotion and the receipt shows it in the slot.
//      A receipt without that evidence fails as not exercised
//      (scripts/lib/one-graph/busy-transfer.mjs)
//   7  the late Edge: its subscription checks as in case 2; it recovers both
//      layers within ONE_GRAPH_RECOVERY_SECS, then shares a report that every
//      other Edge must hold
//   8  the synced flag: every subscriber lists the graph as synced within
//      ONE_GRAPH_SYNCED_SECS of its subscribe, and again of the remedy's
//      subscribe, and every Edge lists it so at the end (#3296 for the late
//      Edge when it already held the reports at its subscribe)
//   9  the end state: on every Edge, each promoted report is in Verified
//      Memory and not in shared memory, and every other report is in shared
//      memory
//  10  the client remedy of edgeA, edgeB and the late Edge (above): dialing
//      the curator, the definition after subscribing again with
//      forceCatchup, and the sub-graph registered and listed
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
  admissionPolicyProblem, catchupDataTriples, definitionInTime, heldAtSubscribe, memberPublishOutcome, pairOutcome, parseAdmissions,
  postPromotionCheck, profileStatusProblems, promotionOutcome, promotionResult, subGraphWriteResult, syncedAfterRemedyResult, syncedAtEndResult,
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
  10: 'the client remedy: dial the curator, subscribe again with forceCatchup, register the sub-graph',
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

/** Waits for the watches, then reports each pair under its case; resolves to the pairs. */
async function settle(handles) {
  const pairs = await settled(handles);
  for (const pair of pairs) {
    const result = pairOutcome(pair, { boundMs: BOUND_MS });
    (result.outcome === 'pass' ? pass : fail)(pair.caseId, result.text);
  }
  return pairs;
}

// Each promotion's check result, by report: what case 5 depends on.
const promotionResults = new Map();
// The reports the curator held in its shared memory before a promotion: the
// evidence known gap #3294 takes. Its own reports, and every report a check
// showed in its shared memory.
const heldByCurator = new Set();
const noteHeldByCurator = pairs => {
  for (const pair of pairs) {
    if (pair.node === edges.curator && pair.kind === 'swm' && pairOutcome(pair, { boundMs: BOUND_MS }).outcome === 'pass') heldByCurator.add(pair.record);
  }
};

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

/**
 * Polls a node's listing, from its subscribe at `from`, until it holds the
 * graph's definition or DEFINITION_MS has passed. Resolves to { held,
 * late, afterMs }: held only when the listing that showed the definition
 * completed within DEFINITION_MS of `from` (definitionInTime), however
 * slowly it answered.
 */
async function holdsDefinition(node, graph, from) {
  const seen = await waitFor(async () => {
    const listed = await io.listingEntry(node, graph);
    return { ok: listed.readable && listed.defined, completedAt: Date.now() };
  }, Math.max(0, from + DEFINITION_MS - Date.now()), 2000);
  return definitionInTime(seen, { from, boundMs: DEFINITION_MS });
}

/**
 * Polls a node's listing, from its subscribe at `from`, until it lists the
 * graph as synced or SYNCED_MS has passed. Resolves to the last listing it
 * made: { ok, listed (listingEntry), completedAt }, which
 * syncedAfterRemedyResult judges against the deadline.
 */
const syncedBy = (node, graph, from) => waitFor(async () => {
  const listed = await io.listingEntry(node, graph);
  return { ok: listed.readable && listed.entry?.synced === true, listed, completedAt: Date.now() };
}, Math.max(0, from + SYNCED_MS - Date.now()), 2000);

// Each remedy's poll of the subscriber's synced flag from its second subscribe, by node: case 8 judges it.
const remedySynced = new Map();

/**
 * A subscriber that holds no definition of a graph rejoins it as a client
 * can: it dials the curator through its relay (a subscriber asks only the
 * peers it is connected to for the graph's declaration, and the curator may
 * be the only one that holds it) and subscribes again with an explicit
 * catch-up (`forceCatchup`). `onSubscribed(from)` runs as soon as that
 * subscribe was accepted. Resolves to { dialError, from (the second
 * subscribe), held (whether it held the definition within DEFINITION_MS),
 * late (it held it, but only past DEFINITION_MS), heldAfterMs, synced (with
 * `watchSynced`: the poll of its synced flag from that subscribe, syncedBy,
 * still running) }.
 */
async function rejoin(node, graph, onSubscribed, { watchSynced = false } = {}) {
  let dialError = null;
  if (node !== edges.curator) {
    try {
      await edges.dialOwner(node);
    } catch (error) {
      dialError = error?.message ?? String(error);
    }
  }
  const from = await graphs.subscribe(node, graph, { forceCatchup: true });
  onSubscribed?.(from);
  const synced = watchSynced ? syncedBy(node, graph, from) : null;
  const { held, late, afterMs } = await holdsDefinition(node, graph, from);
  return { dialError, from, held, late, heldAfterMs: afterMs ?? Date.now() - from, synced };
}

/** The rejoin as the setup of another case: noted, not checked. Resolves to the second subscribe. */
async function ensureDefinition(node, graph, caseId) {
  const { dialError, from, held, late, heldAfterMs } = await rejoin(node, graph);
  const outcome = held ? `it held the definition ${seconds(heldAfterMs)} s later` : late ? `it held the definition only ${seconds(heldAfterMs)} s later, past the ${seconds(DEFINITION_MS)} s` : `it still held none ${seconds(DEFINITION_MS)} s later`;
  note(`case ${caseId}: ${node.label} ${dialError ? `could not dial the curator (${dialError}) but` : 'dialed the curator through its relay and'} subscribed to ${graph.key} again with forceCatchup: ${outcome}`);
  return from;
}

/** Whether a node's sub-graph listing names the graph's sub-graph: { ok, why }. */
async function listsSubGraph(node, graph) {
  const answer = await devnet.api(node, 'GET', `/api/sub-graph/list?contextGraphId=${encodeURIComponent(graph.id)}`);
  const names = Array.isArray(answer.json?.subGraphs) ? answer.json.subGraphs.map(sub => sub?.name) : [];
  return { ok: names.includes(graph.sub), why: answer.status === 200 ? `it lists ${names.length ? names.join(', ') : 'no sub-graph'}` : brief(answer) };
}

/**
 * A subscriber's subscribe as a client makes it, and its checks from that
 * moment: the graph's definition within DEFINITION_MS (under `caseId`) and
 * its synced flag within SYNCED_MS (case 8), with the known gaps applied
 * (#3264). Resolves once both have settled.
 */
async function subscribeChecked(node, graph, caseId) {
  const observer = io.observeSubscription(node, graph, await graphs.subscribe(node, graph));
  reportSubscription(observer, await observer.done, caseId);
}

/**
 * Case 10, the client remedy, made by every subscriber whether it needs it or
 * not, so that the gate proves it keeps working: the node rejoins (it dials
 * the curator and subscribes again with forceCatchup) and must hold the
 * definition within DEFINITION_MS. With the definition, its write into the
 * sub-graph before it registers the sub-graph itself is a check under
 * `caseId` (known gap #3293); then it registers the sub-graph (POST
 * /api/sub-graph/create) and must list it. `onSubscribed(from)` runs as soon
 * as the second subscribe was accepted, so that a watch timed from it starts
 * at once. A write that went through is a report like the others, and the
 * watch of its delivery to every other running Edge starts as soon as its
 * share ended. Resolves to { from (the second subscribe: the node's later
 * bounds count from it), probe (the record of that write), probeWatch (the
 * watch of its delivery, or null) }.
 */
async function remedy(node, graph, caseId, { onSubscribed } = {}) {
  const { dialError, from, held, late, heldAfterMs, synced } = await rejoin(node, graph, onSubscribed, { watchSynced: true });
  remedySynced.set(node, { graph, from, synced });
  if (dialError) fail(10, `${node.label} could not dial the curator through its relay: ${dialError}`);
  else pass(10, `${node.label} dialed the curator through its relay`);
  if (held) pass(10, `${node.label} holds the definition of ${graph.key} ${seconds(heldAfterMs)} s after it subscribed again with forceCatchup`);
  else if (late) fail(10, `${node.label} held the definition of ${graph.key} only ${seconds(heldAfterMs)} s after it subscribed again with forceCatchup, past the ${seconds(DEFINITION_MS)} s`);
  else fail(10, `${node.label} holds no definition of ${graph.key} ${seconds(DEFINITION_MS)} s after it subscribed again with forceCatchup`);
  let probe = null;
  let probeWatch = null;
  // A definition that came past its deadline failed above; the node holds it, so the remedy goes on.
  if (graph.sub && (held || late)) {
    const listed = await listsSubGraph(node, graph);
    probe = await shareReport(caseId, node, graph, `${node.role} write before its sub-graph`, from + SYNCED_MS);
    if (!probe.error) probeWatch = io.watch(io.pairs(caseId, probe, edges.running.filter(other => other !== node), 'swm'));
    report.record(caseId, subGraphWriteResult({ node, graph, record: probe, listed: listed.ok }));
    const made = await devnet.api(node, 'POST', '/api/sub-graph/create', { contextGraphId: graph.id, subGraphName: graph.sub });
    const after = await listsSubGraph(node, graph);
    if (made.json?.created === graph.sub && after.ok) pass(10, `${node.label} registered the sub-graph ${graph.sub} of ${graph.key} and lists it`);
    else fail(10, `${node.label} could not register the sub-graph ${graph.sub} of ${graph.key}: ${made.json?.created === graph.sub ? after.why : brief(made)}`);
  }
  return { from, probe, probeWatch };
}

/**
 * The curator promotes a report. The promotion is a check under `caseId`
 * (known gap #3294 for a report another Edge authored, with the evidence of
 * the curator holding it). Resolves to when it was confirmed, or null.
 */
async function promoteChecked(caseId, record) {
  const { curator } = edges;
  const { answer, at } = await io.promote(curator, record);
  const outcome = promotionOutcome(answer, { authorAddress: record.author.agentAddress });
  const result = promotionResult({ record, curator, outcome, answer, heldByCurator: record.author === curator || heldByCurator.has(record) });
  promotionResults.set(record, result);
  report.record(caseId, result);
  return outcome.ok ? at : null;
}

/**
 * A report shared by `author`. Until `readyBy` (its subscription's synced
 * deadline) a create refused the way a client retries (the graph not yet
 * synced for writes) is made again, as a client does; the run notes it.
 */
async function shareReport(caseId, author, graph, what, readyBy = 0) {
  const record = await io.share(author, graph, what, { retryUntil: readyBy });
  if (record.refused) {
    note(`case ${caseId}: ${describe(record)}: refused ${record.refused.times} time(s) as ${record.refused.code} before it was written, ${seconds(record.refused.waitedMs)} s after the first try`);
  }
  return record;
}

/**
 * A settled subscription of a member to the registered public graph: the
 * definition under `definitionCase` (a pass is quiet), the synced flag under
 * case 8, each with the known gaps applied (#3264).
 */
function reportSubscription(handle, observation, definitionCase) {
  if (!observation) return fail(definitionCase, `${handle.node.label}: its subscription to ${handle.graph.key} was not observed`);
  const { definition, synced } = subscriptionResults(observation, {
    registered: true, private: false, member: true, definitionMs: DEFINITION_MS, syncedMs: SYNCED_MS,
  });
  for (const [id, result] of [[definitionCase, definition], [8, synced]]) {
    report.record(id, { ...result, text: `${handle.node.label}, ${handle.graph.key}: ${result.text}` });
  }
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

  // Case 1: every Edge runs the profile. The settings the build does not read
  // are the deployment's, not node behaviour: a note.
  const unread = unreadProfileNames();
  if (unread.problem) note(`case 1: the build was not scanned for the profile's settings: ${unread.problem}`);
  else if (unread.missing.length) note(`case 1: the build the devnet runs never reads ${unread.missing.join(', ')}: the profile sets ${unread.missing.length === 1 ? 'it' : 'them'} to no effect`);
  else say(`the build reads every setting of the profile (${PROFILE_NAMES.length})`);
  for (const node of [curator, edgeA, edgeB]) await edges.start(node);
  say(`curator, edgeA and edgeB up (${elapsed()})`);
  await checkProfile([curator, edgeA, edgeB]);
  await precondition(1, 'once the Edges are up');

  // The graph. edgeA and edgeB subscribe (their definition and synced flag
  // are checked from that subscribe), then make the client remedy (case 10).
  const main = await graphs.createGraph(curator, 'main', { publishPolicy: 0, sub: SUB });
  const subscriptions = await Promise.all([edgeA, edgeB].map(async member => {
    await subscribeChecked(member, main, 2);
    return remedy(member, main, 2);
  }));
  say(`edgeA and edgeB subscribed (${elapsed()})`);

  // Case 2: reports, live; every other running Edge must hold each.
  await precondition(2, 'before the reports');
  const others = author => edges.running.filter(node => node !== author);
  const shared = [];
  const byAuthor = new Map([[curator, []], [edgeA, []], [edgeB, []]]);
  // Each subscriber has until its synced deadline to take writes.
  const readyBy = new Map([edgeA, edgeB].map((member, i) => [member, subscriptions[i].from + SYNCED_MS]));
  const live = [];
  // A write made before the sub-graph that went through (#3293 fixed) is a
  // report like the others; the remedy started the watch of its delivery.
  for (const { probe, probeWatch } of subscriptions) {
    if (!probeWatch) continue;
    shared.push(probe);
    live.push(probeWatch);
  }
  for (const author of [curator, edgeA, edgeB]) {
    for (const n of [1, 2]) {
      const record = await shareReport(2, author, main, `${author.role} report ${n}`, readyBy.get(author));
      shared.push(record);
      byAuthor.get(author).push(record);
      live.push(io.watch(io.pairs(2, record, others(author), 'swm')));
    }
  }
  noteHeldByCurator(await settle(live));

  // Case 3: edgeA publishes its second report itself.
  const [a1, a2] = byAuthor.get(edgeA);
  const [b1] = byAuthor.get(edgeB);
  const [c1, c2] = byAuthor.get(curator);
  const promoted = new Set();
  if (a2.error) fail(3, `${describe(a2)} was not written, so its publish was not tried`);
  else {
    const { answer, at } = await io.ownPublish(edgeA, a2);
    const own = memberPublishOutcome(answer);
    if (own.verdict === 'refused') pass(3, `${edgeA.label}'s own publish of ${describe(a2)} was refused by the publish policy: ${own.why}`);
    else if (own.verdict === 'published') {
      fail(3, `${edgeA.label}, not the curator, published ${describe(a2)} to Verified Memory: ${own.why}`);
      // It is in Verified Memory now: the later cases expect it there and out of shared memory.
      promoted.add(a2);
    } else fail(3, `not exercised: ${edgeA.label}'s own publish of ${describe(a2)} failed for another reason than the publish policy: ${own.why}`);
    await settle([io.watch(io.pairs(3, a2, edges.running, own.verdict === 'published' ? 'vm' : 'unpublished', { from: at, fromWhat: `${edgeA.role}'s own publish` }))]);
  }

  // Case 4: the curator promotes the first report of each Edge, its own included.
  // Every report that is not promoted stays in shared memory on every Edge at
  // every reading, from before the first promotion (or from the refusal of its
  // own) until the last promotion's watch has ended.
  await precondition(4, 'before the promotions');
  const candidates = [a1, b1, c1];
  const retained = [];
  const retain = (records, fromWhat) => {
    if (records.length) retained.push(io.watch(records.flatMap(record => io.pairs(4, record, edges.running, 'kept', { from: Date.now(), fromWhat, bound: Infinity }))));
  };
  retain(shared.filter(record => !record.error && !candidates.includes(record) && !promoted.has(record)), 'start of the promotions');
  const promotions = [];
  for (const record of candidates) {
    if (record.error) {
      fail(4, `${describe(record)} was not written, so it was not promoted`);
      continue;
    }
    const at = await promoteChecked(4, record);
    if (at === null) {
      retain([record], 'refusal of its promotion');
      continue;
    }
    promoted.add(record);
    const options = { from: at, fromWhat: 'promotion' };
    promotions.push(io.watch([...io.pairs(4, record, edges.running, 'vm', options), ...io.pairs(4, record, edges.running, 'gone', options)]));
  }
  await settle(promotions);
  for (const handle of retained) handle.close();
  await settle(retained);
  const check = () => ({ from: Date.now(), fromWhat: 'check', bound: CHECK_MS });
  for (const record of promoted) {
    note(`case 4: on its author, ${describe(record)} has the record ${await io.lifecycle(record.author, record)}; the author's catalog status: ${await catalogStatus(record.author)}`);
  }

  // Case 5: an author whose report was promoted shares again. Only an author
  // whose report was promoted exercises it; for the other the check is not
  // exercised, with its promotion's refusal as the evidence (#3294).
  await precondition(5, 'before the authors share again');
  const again = [];
  for (const [author, first] of [[edgeA, a1], [edgeB, b1]]) {
    const unexercised = postPromotionCheck({ author, report: first, promoted: promoted.has(first), promotion: promotionResults.get(first) });
    if (unexercised) {
      report.record(5, unexercised);
      continue;
    }
    const record = await io.share(author, main, `${author.role} after its promotion`);
    shared.push(record);
    again.push(io.watch(io.pairs(5, record, others(author), 'swm')));
  }
  noteHeldByCurator(await settle(again));

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
    const busy = await busyEdge({ devnet, edges, graphs, io, report, caseId: 6, boundMs: BOUND_MS, stamp: STAMP, ensureDefinition, promote: promoteChecked }, main, large,
      [a2, c2].filter(record => !record.error && !promoted.has(record)));
    shared.push(...busy.shared);
    for (const record of busy.promoted) promoted.add(record);
  }

  // Case 7: the late Edge starts, subscribes and recovers; then it shares.
  await edges.start(late);
  say(`late Edge up (${elapsed()})`);
  await checkProfile([late]);
  await precondition(7, 'once the late Edge is up');
  await subscribeChecked(late, main, 7);
  // The recovery counts from the second subscribe, and its watch starts the
  // moment that subscribe is accepted, beside the remedy's other steps.
  let recoveryWatch = null;
  const recovery = await remedy(late, main, 7, {
    onSubscribed: from => { recoveryWatch = io.watch(placementPairs(7, shared, promoted, [late], { from, fromWhat: 'late subscribed again', bound: RECOVERY_MS })); },
  });
  await settle([recoveryWatch]);
  // Whether the late Edge already held every report when its second subscribe
  // was accepted: the state of known gap #3296, judged at the end.
  const heldAtResubscribe = new Map([[late, heldAtSubscribe(recoveryWatch.pairs)]]);
  if (recovery.probeWatch) {
    shared.push(recovery.probe);
    await settle([recovery.probeWatch]);
  }
  const fromLate = await shareReport(7, late, main, 'late report', recovery.from + SYNCED_MS);
  shared.push(fromLate);
  await settle([io.watch(io.pairs(7, fromLate, others(late), 'swm'))]);

  // Case 8: every subscriber lists the graph as synced within SYNCED_MS of the
  // remedy's subscribe, and every Edge lists it so at the end. A node that held
  // the graph's reports at its subscribe is judged with its catch-up's log (#3296).
  const evidenceOf = node => {
    const held = heldAtResubscribe.get(node) === true;
    return { heldAtSubscribe: held, catchup: held ? catchupDataTriples(devnet.logSince(node, 0), main.id) : null };
  };
  for (const [node, { graph, from, synced }] of remedySynced) {
    if (graph !== main) continue;
    report.record(8, syncedAfterRemedyResult({ node, graph, seen: await synced, from, boundMs: SYNCED_MS, ...evidenceOf(node) }));
  }
  for (const node of edges.running) {
    const listed = await io.listingEntry(node, main);
    report.record(8, syncedAtEndResult({ node, graph: main, listed, ...evidenceOf(node) }));
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
