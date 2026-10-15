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
// member whose slot was starved in the issue.
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
//   6  member 2 while its only sync slot is busy with a large transfer of
//      another graph (MEMBER_SHARING_BIG_ASSETS x MEMBER_SHARING_BIG_TRIPLES).
//      Member 2's own evidence must show the transfer in the slot: its log
//      names the transfer's admission, and its sync-slot readings
//      (/api/diagnostics/backpressure, every second) show that admission
//      still running until each write was received. A write received after
//      the transfer left the slot, or a transfer never admitted, fails the
//      case as not exercised; a running catch-up job alone proves nothing
//   7  cases 1, 2 and 3 on a public graph registered on chain, and cases 1
//      and 3 on a private graph whose members joined through the signed
//      request flow. A member's write into a private graph sets up its sender
//      key with every other member directly, which members that reach only
//      the owner cannot do, so case 2 does not apply there.
//   8  the `synced` flag of every member, for every graph
//
// Known gaps (KNOWN_GAPS): a check that fails for the reason of an open issue,
// with evidence of that reason, is printed as XFAIL with the issue and does not
// fail its case. Today one: #3264, a member of the registered graph never
// obtains its definition here. The definition check itself (case 7; printed as
// XPASS when the member holds it); a member's write refused as a write to an
// unknown graph while its listing shows no definition (case 7); and the synced
// flag staying false while the same listing shows no definition (case 8). A
// member that holds the definition and still cannot write or never syncs
// fails. Once #3264 is fixed and these hold, remove the entry and its calls.
//
// After a restart each member dials the owner again, as a client of the
// issue's kind does; the script does not wait for the nodes to find each
// other by themselves.
//
// Exit codes: 0 every case passed; 1 a case failed or was not run; 3 the
// devnet cannot host the scenario (the temporary node numbers are taken, node 1
// is not a Core) and nothing was exercised.
//
// Env knobs:
//   DEVNET_DIR, API_PORT_BASE
//   MEMBER_SHARING_BOUND_SECS    time a write has to reach a node (60)
//   MEMBER_SHARING_SYNCED_SECS   time a member has to list a graph as synced (90)
//   MEMBER_SHARING_LATER_SECS    age of the members' subscription in case 5 (300)
//   MEMBER_SHARING_NODES         temporary nodes owner,member1,member2 (7,8,9)
//   MEMBER_SHARING_BIG_ASSETS    assets of the large graph of case 6 (32)
//   MEMBER_SHARING_BIG_TRIPLES   triples per asset of that graph (2000)
//   MEMBER_SHARING_KEEP_NODES=1  leave the temporary nodes running (debugging)
//
// Run against a running devnet: scripts/devnet-test-issue-3251-member-sharing.mjs

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definitionState, readListing, subscriptionState } from './lib/qa/context-graph-listing.mjs';
import {
  admissionStarts, busySlotCovered, caseVerdicts, foldRead, inScope, judgeHeld, linkProblem, pairHeld, registeredGapVerdict,
  sharedMemoryScope,
} from './lib/qa/member-sharing.mjs';
import { parseObservation } from './lib/qa/query-observation.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEVNET_DIR = process.env.DEVNET_DIR || join(REPO_ROOT, '.devnet');
const API_PORT_BASE = Number(process.env.API_PORT_BASE || 9201);
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
const BIG_ASSETS = Math.round(positive('MEMBER_SHARING_BIG_ASSETS', 32));
const BIG_TRIPLES = Math.round(positive('MEMBER_SHARING_BIG_TRIPLES', 2000));
const [OWNER, M1, M2] = (process.env.MEMBER_SHARING_NODES || '7,8,9').split(',').map(Number);
const SUB = 's';
const LABEL = 'urn:issue3251:label';
// Nobody listens on the discard port: a dial of it is refused at once.
const DEAD_DIRECT_ADDRESS = '/ip4/127.0.0.1/tcp/9';
const STAMP = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${process.pid}`;
const STARTED = Date.now();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const seconds = ms => Math.round(ms / 1000);
const elapsed = () => `t+${seconds(Date.now() - STARTED)}s`;
const say = text => console.log(`[issue-3251] ${text}`);
const role = node => ({ [OWNER]: 'owner', [M1]: 'member1', [M2]: 'member2' }[node] ?? `node${node}`);
const label = node => `node${node} (${role(node)})`;

// ── results ──────────────────────────────────────────────────────────────────
const CASES = {
  1: 'owner -> members, root and sub-graph, live',
  2: 'member -> owner -> other member, root and sub-graph, live',
  3: 'history: writes made before the members subscribed',
  4: 'after a member restart and after an owner restart',
  5: `members ${seconds(LATER_MS)} s after they subscribed`,
  6: 'member 2 while its only sync slot is busy with another graph',
  7: 'cases 1, 2, 3 on a registered graph; 1, 3 on a private graph',
  8: 'the synced flag of every member',
};
const findings = Object.fromEntries(Object.keys(CASES).map(id => [id, { pass: 0, fail: [], xfail: [], xpass: [] }]));
const pass = (id, text) => { findings[id].pass += 1; console.log(`  [PASS] case ${id}: ${text}`); };
const fail = (id, text) => { findings[id].fail.push(text); console.log(`  [FAIL] case ${id}: ${text}`); };
const note = text => console.log(`  [NOTE] ${text}`);

// Known gaps. A check that fails for the reason an open issue describes is an
// expected failure: printed as XFAIL with the issue, and it does not fail its
// case. The same check holding is printed as XPASS (and counted as held). Once
// the issue is fixed and its checks hold, remove its entry and the calls.
const KNOWN_GAPS = {
  registeredDefinition: {
    issue: '#3264',
    what: 'a member of a registered graph that reaches only the owner never obtains the graph\'s definition',
  },
};
const xfail = (id, gap, text) => {
  findings[id].xfail.push(text);
  console.log(`  [XFAIL] case ${id}: ${text} (expected failure: ${KNOWN_GAPS[gap].issue}, ${KNOWN_GAPS[gap].what})`);
};
const xpass = (id, gap, text) => {
  findings[id].pass += 1;
  findings[id].xpass.push(text);
  console.log(`  [XPASS] case ${id}: ${text} (held although ${KNOWN_GAPS[gap].issue} is expected to fail it; remove the expected failure once ${KNOWN_GAPS[gap].issue} is fixed)`);
};

// ── devnet access ────────────────────────────────────────────────────────────
function readToken(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').map(line => line.trim()).find(line => line && !line.startsWith('#')) ?? '';
  } catch { return ''; }
}
const ADMIN_TOKEN = process.env.DKG_AUTH || readToken(join(DEVNET_DIR, 'node1', 'auth.token'));

async function api(node, method, path, body, { token = ADMIN_TOKEN, timeoutMs = 60_000 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${API_PORT_BASE + node - 1}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text };
  } catch (error) {
    return { status: 0, json: null, text: String(error?.message ?? error) };
  }
}
const brief = answer => `HTTP ${answer.status} ${answer.text.replace(/\s+/g, ' ').slice(0, 240)}`;

/**
 * devnet.sh without blocking: the watches of the nodes that stay up keep
 * reading while another node stops, starts or restarts.
 */
function devnetSh(args, env = {}, timeoutMs = 300_000) {
  return new Promise(resolve => {
    const child = spawn('bash', [join(REPO_ROOT, 'scripts/devnet.sh'), ...args], {
      cwd: REPO_ROOT, env: { ...process.env, DEVNET_DIR, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', error => { output += String(error?.message ?? error); });
    child.on('close', status => { clearTimeout(timer); resolve({ status, output: output.trim() }); });
  });
}
/** The same, for the cleanup, which must also work from a signal handler. */
function devnetShSync(args, timeoutMs = 120_000) {
  const result = spawnSync('bash', [join(REPO_ROOT, 'scripts/devnet.sh'), ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, DEVNET_DIR },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}
const lastLines = text => text.split('\n').slice(-3).join(' | ').slice(0, 300);

const nodeConfig = node => {
  try { return JSON.parse(readFileSync(join(DEVNET_DIR, `node${node}`, 'config.json'), 'utf8')); } catch { return null; }
};
// The Cores come from the devnet's files, not from API answers: a Core that
// does not answer must not drop out of the list.
function coreNodes() {
  return readdirSync(DEVNET_DIR)
    .map(entry => /^node(\d+)$/.exec(entry)?.[1]).filter(Boolean).map(Number)
    .filter(node => ![OWNER, M1, M2].includes(node))
    .filter(node => nodeConfig(node)?.nodeRole === 'core')
    .sort((a, b) => a - b);
}

/** Polls until `check` answers { ok: true } or the time is up; returns the last answer, never asks twice for it. */
async function waitFor(check, ms, everyMs = 1000) {
  const end = Date.now() + ms;
  let last = { ok: false, why: 'not asked' };
  for (;;) {
    last = await check();
    if (last.ok || Date.now() + everyMs > end) return last;
    await sleep(everyMs);
  }
}

// ── the temporary Edges ──────────────────────────────────────────────────────
const PEER = {};
const AGENT = {};
const STARTED_NODES = [];
let RELAY1 = '';
let RELAY2 = '';
// The relay a member dials the owner through; the owner reserves on both.
const relayOf = node => (node === M2 ? RELAY2 : RELAY1);

async function startEdge(node, extra) {
  STARTED_NODES.push(node);
  const added = await devnetSh(['addnode', String(node), 'edge'], { DEVNET_ADDNODE_CONFIG_OVERRIDES: JSON.stringify(extra) });
  if (added.status !== 0) throw new Error(`temporary node ${node} could not be added: ${lastLines(added.output)}`);
  await identify(node);
}

async function identify(node) {
  const up = await waitFor(async () => {
    const status = await api(node, 'GET', '/api/agent/identity', undefined, { timeoutMs: 10_000 });
    return { ok: status.status === 200 && Boolean(status.json?.peerId) && Boolean(status.json?.agentAddress), status };
  }, 120_000, 2000);
  if (!up.ok) throw new Error(`node${node} did not report its identity: ${up.status ? brief(up.status) : 'no answer'}`);
  PEER[node] = up.status.json.peerId;
  AGENT[node] = up.status.json.agentAddress;
}

function agentToken(node) {
  try {
    const records = Object.values(JSON.parse(readFileSync(join(DEVNET_DIR, `node${node}`, 'agent-keystore.json'), 'utf8')));
    return records.find(record => typeof record?.authToken === 'string')?.authToken ?? '';
  } catch { return ''; }
}

/** A member dials the owner through the relay; the owner's reservation there may need a moment. */
async function dialOwner(member) {
  const multiaddr = `${relayOf(member)}/p2p-circuit/p2p/${PEER[OWNER]}`;
  const dialed = await waitFor(async () => {
    const answer = await api(member, 'POST', '/api/connect', { multiaddr }, { timeoutMs: 30_000 });
    return { ok: answer.status === 200 && answer.json?.connected !== false, why: brief(answer) };
  }, 120_000, 3000);
  if (!dialed.ok) throw new Error(`${label(member)} could not dial the owner through the relay: ${dialed.why}`);
}

async function link(from, to) {
  const answer = await api(from, 'GET', '/api/connections');
  const all = answer.json?.connections;
  if (answer.status !== 200 || !Array.isArray(all)) return { readable: false };
  const mine = all.filter(c => c.peerId === PEER[to]);
  return { readable: true, total: mine.length, relayed: mine.filter(c => c.transport === 'relayed').length };
}

/** The topology every conclusion rests on; the problems, or none. */
async function topologyProblems() {
  const expected = [[M1, OWNER, 'relayed'], [OWNER, M1, 'relayed'], [M2, OWNER, 'relayed'], [OWNER, M2, 'relayed'], [M1, M2, 'none'], [M2, M1, 'none']];
  const problems = [];
  for (const [a, b, expect] of expected) {
    const problem = linkProblem(await link(a, b), expect, label(a), label(b));
    if (problem) problems.push(problem);
  }
  return problems;
}

/** Before a case's writes: a topology that does not hold fails the case, since nothing it shows is about #3251. */
async function precondition(caseId, when) {
  const problems = await topologyProblems();
  if (problems.length === 0) return true;
  fail(caseId, `${when}: the members do not reach the owner through the relay only, or reach each other: ${problems.join('; ')}`);
  return false;
}

// ── graphs ───────────────────────────────────────────────────────────────────
async function createGraph(key, body) {
  const id = `${AGENT[OWNER]}/issue-3251-${key}-${STAMP}`;
  const created = await api(OWNER, 'POST', '/api/context-graph/create', { id, name: `issue 3251 ${key}`, ...body }, { timeoutMs: 180_000 });
  if (created.json?.created !== id) throw new Error(`graph ${key} was not created: ${brief(created)}`);
  if (body.register && created.json?.registered !== true) throw new Error(`graph ${key} was not registered: ${brief(created)}`);
  const sub = await api(OWNER, 'POST', '/api/sub-graph/create', { contextGraphId: id, subGraphName: SUB }, { timeoutMs: 120_000 });
  if (sub.json?.created !== SUB) throw new Error(`the sub-graph of ${key} was not created: ${brief(sub)}`);
  // The graph names of its partitions are built from the id the node resolved.
  const resolved = typeof sub.json?.contextGraphId === 'string' && sub.json.contextGraphId ? sub.json.contextGraphId : id;
  say(`graph ${key}: ${id}${created.json?.onChainId ? ` (registered, id ${created.json.onChainId})` : ''}${resolved !== id ? ` resolved as ${resolved}` : ''}`);
  return { key, id, resolved, private: body.accessPolicy === 1, registered: body.register === true && body.accessPolicy !== 1, subscribedAt: {} };
}

/** A Core subscribes and unsubscribes at once; discovery does not re-activate an ended subscription. */
async function keepCoresOut(graph) {
  for (const core of coreNodes()) {
    const subscribed = await waitFor(async () => {
      const answer = await api(core, 'POST', '/api/context-graph/subscribe', { contextGraphId: graph.id });
      return { ok: answer.status === 200, why: brief(answer) };
    }, 90_000, 2000);
    if (!subscribed.ok) throw new Error(`Core node${core} could not be kept out of ${graph.key} (subscribe): ${subscribed.why}`);
    const ended = await api(core, 'POST', '/api/context-graph/unsubscribe', { contextGraphId: graph.id });
    if (ended.status !== 200) throw new Error(`Core node${core} could not be kept out of ${graph.key} (unsubscribe): ${brief(ended)}`);
  }
}

/** Every Core must say it does not follow the graph; one that cannot be asked has said nothing. */
async function coresFollowing(graph) {
  const following = [];
  const unknown = [];
  for (const core of coreNodes()) {
    const answer = await api(core, 'GET', '/api/context-graph/list');
    const state = subscriptionState(answer.status, answer.text, graph.id);
    if (state.state === 'following') following.push(`node${core}`);
    else if (state.state !== 'not-following') unknown.push(`node${core} (${state.reason ?? state.state})`);
  }
  return { following, unknown };
}

/** A node's own listing entry for the graph, through the shared listing parser; `defined` = it holds the definition. */
async function listingEntry(node, graph) {
  const answer = await api(node, 'GET', '/api/context-graph/list');
  const listing = readListing(answer.status, answer.text);
  if (!listing.ok) return { readable: false, why: `${listing.reason}, ${brief(answer)}` };
  return {
    readable: true,
    entry: listing.graphs.find(entry => entry.id === graph.id) ?? null,
    defined: definitionState(answer.status, answer.text, graph.id).state === 'defined',
  };
}

/** A public graph: subscribe. A private one: the signed request flow first, with the member's own agent token. */
async function subscribe(node, graph) {
  if (graph.private) {
    const token = agentToken(node);
    if (!token) throw new Error(`${label(node)} has no agent token for the private graph`);
    const encoded = encodeURIComponent(graph.id);
    const signed = await api(node, 'POST', `/api/context-graph/${encoded}/sign-join`, {}, { token });
    if (signed.json?.ok !== true || !signed.json?.delegation) throw new Error(`${label(node)} could not sign its join: ${brief(signed)}`);
    const body = { delegation: signed.json.delegation, curatorPeerId: PEER[OWNER], agentName: role(node) };
    const joined = await waitFor(async () => {
      const answer = await api(node, 'POST', `/api/context-graph/${encoded}/request-join`, body, { token });
      const ok = ['approved', 'already-member'].includes(answer.json?.status) && ['1', 'local'].includes(String(answer.json?.delivered));
      return { ok, why: brief(answer) };
    }, 90_000, 15_000);
    if (!joined.ok) throw new Error(`${label(node)} did not join the private graph: ${joined.why}`);
    const ready = await waitFor(async () => {
      const answer = await api(node, 'GET', `/api/context-graph/${encoded}/participants`, undefined, { token });
      const agents = Array.isArray(answer.json?.allowedAgents) ? answer.json.allowedAgents : [];
      return { ok: agents.some(a => typeof a === 'string' && a.toLowerCase() === AGENT[node].toLowerCase()), why: brief(answer) };
    }, 120_000, 2000);
    if (!ready.ok) throw new Error(`${label(node)} never saw itself among the participants: ${ready.why}`);
    const answer = await api(node, 'POST', '/api/subscribe', { contextGraphId: graph.id, includeSharedMemory: true }, { token });
    if (answer.status !== 200) throw new Error(`${label(node)} could not subscribe to ${graph.key}: ${brief(answer)}`);
  } else {
    const answer = await api(node, 'POST', '/api/context-graph/subscribe', { contextGraphId: graph.id, includeSharedMemory: true });
    if (answer.status !== 200) throw new Error(`${label(node)} could not subscribe to ${graph.key}: ${brief(answer)}`);
  }
  graph.subscribedAt[node] = Date.now();
}

// ── writes, reads, and the bound ─────────────────────────────────────────────
let sequence = 0;

/**
 * Creates an asset and shares it through the asynchronous share job, as a
 * client does, and waits for the job to end. Resolves to { doneAt } (the time
 * a write's bound starts from) or { error, code } (the refusal's code, if any).
 */
async function createAndShare(author, { contextGraphId, name, quads, subGraphName }, { createTimeoutMs, jobTimeoutMs, pollMs }) {
  const scope = subGraphName ? { subGraphName } : {};
  const created = await api(author, 'POST', '/api/knowledge-assets', {
    contextGraphId, name, ...scope, quads, finalize: true, alsoShareSwm: false,
  }, { timeoutMs: createTimeoutMs });
  if (created.status !== 200 && created.status !== 201) return { error: `the author refused the asset: ${brief(created)}`, code: created.json?.code };
  const queued = await api(author, 'POST', `/api/knowledge-assets/${name}/swm/share-async`, { contextGraphId, entities: 'all', ...scope });
  const job = queued.json?.jobId;
  if (queued.status !== 200 || !job) return { error: `the share was not accepted: ${brief(queued)}` };
  const finished = await waitFor(async () => {
    const view = await api(author, 'GET', `/api/knowledge-assets/swm/share-jobs/${encodeURIComponent(job)}`);
    return { ok: ['succeeded', 'failed'].includes(view.json?.state), view };
  }, jobTimeoutMs, pollMs);
  const state = finished.view?.json?.state;
  if (state !== 'succeeded') return { error: `the share job ended ${state ?? 'unfinished'}: ${JSON.stringify(finished.view?.json?.lastError ?? null).slice(0, 240)}` };
  return { doneAt: Date.now() };
}

/** One asset with a subject of its own: the record the watches of the write use. */
async function write(author, graph, sub, what) {
  sequence += 1;
  const record = {
    author, graph, sub, what, sequence,
    subject: `urn:issue3251:${STAMP}:${sequence}`,
    value: `${what} (${sequence})`,
    doneAt: null, error: null, definitionHeld: undefined,
  };
  const outcome = await createAndShare(author, {
    contextGraphId: graph.id, name: `i3251-${STAMP.toLowerCase()}-${sequence}`, subGraphName: sub,
    quads: [{ subject: record.subject, predicate: LABEL, object: `"${record.value}"`, graph: '' }],
  }, { createTimeoutMs: 120_000, jobTimeoutMs: 120_000, pollMs: 1000 });
  if (!outcome.error) {
    record.doneAt = outcome.doneAt;
    return record;
  }
  record.error = outcome.error;
  // Refused as a write to an unknown graph: whether the author held the
  // graph's definition right then is the evidence that decides #3264.
  if (outcome.code === 'CONTEXT_GRAPH_NOT_FOUND') {
    const listed = await listingEntry(author, graph);
    record.definitionHeld = listed.readable ? listed.defined : undefined;
  }
  return record;
}
const where = record => `${record.graph.key}${record.sub ? `/${record.sub}` : ' root'}`;
const describe = record => `"${record.value}" by ${label(record.author)} in ${where(record)}`;
const written = record => ({ predicate: LABEL, value: record.value });

/** One query a client makes, through the shared parser of the query answer: its rows, or why there are none. */
async function queryRows(node, body) {
  const answer = await api(node, 'POST', '/api/query', body, { timeoutMs: 30_000 });
  const observation = parseObservation({
    transportExit: answer.status === 0 ? 1 : 0, httpStatus: answer.status, body: answer.text,
    format: 'api', mode: 'bindings', binding: null, settling: true,
  });
  if (observation.outcome === 'PASS') return { rows: observation.rows };
  return { error: observation.outcome === 'SETTLING' ? 'its read authority is still settling' : `${observation.reason}, ${brief(answer)}` };
}

/** The `shared-working-memory` view, with `subGraphName` for a sub-graph. */
async function readView(node, record) {
  const answer = await queryRows(node, {
    contextGraphId: record.graph.id, view: 'shared-working-memory', ...(record.sub ? { subGraphName: record.sub } : {}),
    sparql: `SELECT ?p ?o WHERE { <${record.subject}> ?p ?o }`,
  });
  return answer.rows ? judgeHeld(answer.rows, written(record)) : { held: false, error: answer.error };
}

/** The cross-partition read, in the shared memory of the root or of that sub-graph. */
async function readPartitions(node, record) {
  const answer = await queryRows(node, {
    contextGraphId: record.graph.id, includeContextGraphPartitions: true,
    sparql: `SELECT ?g ?p ?o WHERE { GRAPH ?g { <${record.subject}> ?p ?o } }`,
  });
  if (!answer.rows) return { held: false, error: answer.error };
  const scope = sharedMemoryScope(record.graph.resolved, record.sub);
  return judgeHeld(answer.rows.filter(row => inScope(row.g, scope)), written(record));
}
const READS = [['view', readView], ['partitions', readPartitions]];

/**
 * Starts watching pairs (write, node that must hold it) at once: each is read
 * until it holds or its bound has passed. Call it when the bound starts (right
 * after the write, the subscribe, the return), so that no pair is judged
 * without having been read inside its bound. A pair's bound starts at `from`
 * (default: the end of the write's share job). Each read counts with the time
 * it completed itself, and a read that found the write is not made again, so
 * a slow or failed later read of one kind never discards a timely success of
 * the other. Returns a handle { pairs, done }, not a promise, so that whoever
 * starts a watch does not wait for it.
 */
function watch(pairs) {
  for (const pair of pairs) {
    pair.from = pair.from ?? pair.record.doneAt;
    pair.progress = { view: null, partitions: null };
    pair.last = { view: null, partitions: null };
  }
  const open = () => pairs.filter(p => !p.record.error && !pairHeld(p.progress) && Date.now() - p.from < BOUND_MS);
  const done = (async () => {
    for (let pending = open(); pending.length > 0; pending = open()) {
      await Promise.all(pending.map(async pair => {
        for (const [kind, read] of READS) {
          if (pair.progress[kind] !== null) continue;
          const seen = await read(pair.node, pair.record);
          pair.progress = foldRead(pair.progress, kind, { held: seen.held, completedAt: Date.now() }, { from: pair.from, boundMs: BOUND_MS });
          pair.last[kind] = seen;
        }
      }));
      await sleep(2000);
    }
  })();
  return { pairs, done };
}
/** When a pair was held (both reads), or null. */
const heldAt = pair => (pair.progress && pairHeld(pair.progress) ? pair.from + Math.max(pair.progress.view, pair.progress.partitions) : null);

/** A write, and at once the watch of the nodes that must hold it (a handle, see watch). */
async function writeAndWatch(caseId, author, graph, sub, what, nodes) {
  return watch(at(caseId, await write(author, graph, sub, what), nodes));
}

/** Waits for the watches and returns their pairs. */
async function watched(handles) {
  await Promise.all(handles.map(handle => handle.done));
  return handles.flatMap(handle => handle.pairs);
}

/** Waits for the watches, then reports each pair under its case. */
async function settle(handles) {
  for (const pair of await watched(handles)) report(pair);
}

/** One pair's verdict, under its case. */
function report(pair) {
  const what = `${describe(pair.record)} at ${label(pair.node)}`;
  if (pair.record.error) {
    const text = `${what}: not written, ${pair.record.error}`;
    // A member without the registered graph's definition cannot write into
    // it (#3264). The refusal is that gap only when the author was shown to
    // lack the definition; any other refusal fails.
    const gap = pair.record.error.includes('CONTEXT_GRAPH_NOT_FOUND')
      && registeredGapVerdict({ registered: pair.record.graph.registered, definitionHeld: pair.record.definitionHeld }) === 'xfail';
    return gap ? xfail(pair.caseId, 'registeredDefinition', `${text}; the author holds no definition of the graph`) : fail(pair.caseId, text);
  }
  const { view, partitions } = pair.progress;
  if (pairHeld(pair.progress)) return pass(pair.caseId, `${what}: held ${seconds(Math.max(view, partitions))} s after the ${pair.fromWhat ?? 'share'}`);
  const missing = [];
  if (view === null) missing.push(`the shared-working-memory view${detail(pair.last.view)}`);
  if (partitions === null) missing.push(`the cross-partition read${detail(pair.last.partitions)}`);
  const found = [view !== null && `view after ${seconds(view)} s`, partitions !== null && `partitions after ${seconds(partitions)} s`].filter(Boolean);
  return fail(pair.caseId, `${what}: NOT in ${missing.join(' nor in ')} ${seconds(BOUND_MS)} s after the ${pair.fromWhat ?? 'share'}${found.length ? ` (found in ${found.join(', ')})` : ''}`);
}
function detail(read) {
  if (!read) return '';
  if (read.different) return ` (holds another value: ${read.different})`;
  if (read.error) return ` (${read.error})`;
  return '';
}
const at = (caseId, record, nodes) => nodes.map(node => ({ caseId, record, node }));

/**
 * Started right after a member subscribed: it must hold the graph's definition
 * (its listing names the access policy) within DEFINITION_MS. Nothing asks
 * again: a definition lost on the way is a failure, not something to retry.
 * On the registered graph a missing definition is #3264 itself.
 */
async function watchDefinition(caseId, node, graph) {
  const from = graph.subscribedAt[node];
  for (;;) {
    const last = await listingEntry(node, graph);
    const age = Date.now() - from;
    if (last.readable && last.defined) {
      if (age >= DEFINITION_MS) return fail(caseId, `${label(node)} holds the definition of ${graph.key} only ${seconds(age)} s after it subscribed`);
      if (graph.registered) xpass(caseId, 'registeredDefinition', `${label(node)} holds the definition of ${graph.key} ${seconds(age)} s after it subscribed`);
      return;
    }
    if (age >= DEFINITION_MS) {
      if (!last.readable) return fail(caseId, `${label(node)}: its listing could not be read ${seconds(age)} s after it subscribed to ${graph.key} (${last.why})`);
      const text = `${label(node)} holds no definition of ${graph.key} ${seconds(age)} s after it subscribed: ${last.entry ? `its listing has no access policy for it (${JSON.stringify(last.entry).slice(0, 200)})` : 'its listing does not name it'}; a write it makes there is refused`;
      return registeredGapVerdict({ registered: graph.registered, definitionHeld: false }) === 'xfail' ? xfail(caseId, 'registeredDefinition', text) : fail(caseId, text);
    }
    await sleep(Math.min(2000, DEFINITION_MS - age));
  }
}

/**
 * Started right after a member subscribed: its `synced` flag for the graph must
 * be true within the bound. On the registered graph a flag that stays false is
 * #3264 only when the same listing shows the member without the definition; a
 * member that holds it and never syncs fails.
 */
async function watchSynced(node, graph) {
  const from = graph.subscribedAt[node];
  for (;;) {
    const last = await listingEntry(node, graph);
    const age = Date.now() - from;
    const synced = last.entry?.synced === true;
    if (synced && age < SYNCED_MS) return pass(8, `${label(node)} lists ${graph.key} as synced ${seconds(age)} s after it subscribed`);
    if (age >= SYNCED_MS) {
      if (!last.readable) return fail(8, `${label(node)}: its listing could not be read ${seconds(age)} s after it subscribed to ${graph.key} (${last.why})`);
      const text = synced
        ? `${label(node)} lists ${graph.key} as synced only ${seconds(age)} s after it subscribed`
        : `${label(node)} lists ${graph.key} as ${last.entry ? `subscribed=${last.entry.subscribed} synced=${last.entry.synced}` : 'absent'} ${seconds(age)} s after it subscribed`;
      if (registeredGapVerdict({ registered: graph.registered, definitionHeld: last.defined }) === 'xfail') {
        return xfail(8, 'registeredDefinition', `${text}; it holds no definition of the graph`);
      }
      return fail(8, `${text}${graph.registered ? '; it holds the definition, so this is not #3264' : ''}`);
    }
    await sleep(Math.min(2000, SYNCED_MS - age));
  }
}

// ── case 6: the large graph and member 2's busy slot ────────────────────────
// Each asset: 50 subjects with an equal share of its triples, about 100 bytes a value.
async function fillBigGraph(graph) {
  const perSubject = Math.max(1, Math.ceil(BIG_TRIPLES / 50));
  for (let i = 0; i < BIG_ASSETS; i++) {
    const quads = Array.from({ length: BIG_TRIPLES }, (_, t) => ({
      subject: `urn:issue3251:big:${STAMP}:${i}:${Math.floor(t / perSubject)}`, predicate: `urn:issue3251:payload:${t % perSubject}`,
      object: `"row ${t} of asset ${i} ${'x'.repeat(80)}"`, graph: '',
    }));
    const outcome = await createAndShare(OWNER, { contextGraphId: graph.id, name: `i3251-big-${STAMP.toLowerCase()}-${i}`, quads },
      { createTimeoutMs: 300_000, jobTimeoutMs: 300_000, pollMs: 2000 });
    if (outcome.error) throw new Error(`asset ${i} of the large graph: ${outcome.error}`);
  }
}

const logFile = node => join(DEVNET_DIR, `node${node}`, 'daemon.log');
const logSize = node => { try { return statSync(logFile(node)).size; } catch { return 0; } };
function logSince(node, offset) {
  try {
    const text = readFileSync(logFile(node));
    return text.subarray(text.length >= offset ? offset : 0).toString('utf8');
  } catch { return ''; }
}
const countOf = (text, needle) => text.split(needle).length - 1;

/** One reading of a node's sync slots: its `sync-global` scheduler in the backpressure diagnostics. */
async function slotReading(node) {
  const answer = await api(node, 'GET', '/api/diagnostics/backpressure', undefined, { timeoutMs: 5000 });
  const atMs = Date.now();
  const scheduler = Array.isArray(answer.json?.schedulers) ? answer.json.schedulers.find(s => s?.scheduler === 'sync-global') : undefined;
  if (answer.status !== 200 || !scheduler?.totals) return { at: atMs, unreadable: answer.status === 200 ? 'no sync-global scheduler in the diagnostics' : brief(answer) };
  const { inflight, inflightLimit, oldestActiveAgeMs } = scheduler.totals;
  return { at: atMs, inflight, inflightLimit, oldestActiveAgeMs };
}

/** Reads a node's sync slots every second until stopped. */
function readSlots(node) {
  const readings = [];
  let reading = true;
  const done = (async () => {
    while (reading) {
      readings.push(await slotReading(node));
      await sleep(1000);
    }
  })();
  return { readings, stop: async () => { reading = false; await done; } };
}

/**
 * Case 6: member 2 subscribes to the large graph, and the writes are made while
 * that transfer holds member 2's only sync slot. The node's own evidence must
 * show it: its log names the admission of the transfer (`Sync backpressure
 * running shared-memory:<large graph>:…`), and its slot readings show that
 * admission still running, every second, until each write was received. A
 * running catch-up job proves nothing by itself. A write received only after
 * the transfer left the slot, or a transfer never admitted, means the case was
 * not exercised.
 */
async function busyMember(pub, big) {
  await precondition(6, 'before the large transfer');
  const offset = logSize(M2);
  const needle = `:${big.id}:`;
  const slots = readSlots(M2);
  await subscribe(M2, big);
  const admitted = await waitFor(async () => {
    const start = admissionStarts(logSince(M2, offset), needle).at(-1) ?? null;
    const latest = slots.readings.at(-1);
    const holds = start !== null && latest !== undefined && !latest.unreadable && latest.inflight >= 1
      && Math.abs(latest.at - latest.oldestActiveAgeMs - start) <= 2500;
    return { ok: holds, start, latest };
  }, 30_000, 500);
  if (!admitted.ok) {
    await slots.stop();
    const why = admitted.start === null ? 'its log shows no admission of that transfer' : `its slot was ${admitted.latest?.unreadable ? `unreadable (${admitted.latest.unreadable})` : 'free or held by other work'}`;
    return fail(6, `not exercised: member2's transfer of the large graph did not hold its sync slot within 30 s of the subscribe (${why}); raise MEMBER_SHARING_BIG_ASSETS / MEMBER_SHARING_BIG_TRIPLES`);
  }
  const from = Date.now();
  const handles = [
    await writeAndWatch(6, OWNER, pub, null, 'owner while member2 is busy, root', [M2]),
    await writeAndWatch(6, OWNER, pub, SUB, 'owner while member2 is busy, sub-graph', [M2]),
    await writeAndWatch(6, M1, pub, null, 'member1 while member2 is busy, root', [M2]),
  ];
  const pairs = await watched(handles);
  const until = Date.now();
  await slots.stop();
  const busy = busySlotCovered({ admissionStartMs: admitted.start, samples: slots.readings, from, until });
  for (const pair of pairs) {
    // Proven through the whole window, every receipt in it counts; otherwise a
    // receipt must come before the last reading that still showed the transfer.
    const received = heldAt(pair);
    if (received !== null && !busy.held && (busy.provenUntil === null || received > busy.provenUntil + 1000)) {
      fail(6, `${describe(pair.record)} at ${label(M2)}: held ${seconds(received - pair.from)} s after the share, but after the large transfer stopped holding the slot (${busy.reason ?? 'no reading'}): not exercised`);
    } else report(pair);
  }
  const refused = countOf(logSince(M2, offset), `Sync backpressure rejected shared-memory:${pub.id}:`);
  note(`case 6: member2's transfer of the large graph held its only sync slot ${busy.held ? `through every receipt check (${seconds(until - from)} s)` : `for ${busy.provenUntil === null ? 0 : seconds(busy.provenUntil - from)} s of ${seconds(until - from)} s (then ${busy.reason})`}; member2 refused ${refused} pull(s) of the public graph for a busy slot`);
}

// ── the run ──────────────────────────────────────────────────────────────────
let EXIT = 0;

async function run() {
  if (!ADMIN_TOKEN) return skip('no devnet: no auth token');
  const multiaddrOf = node => { try { return readFileSync(join(DEVNET_DIR, `node${node}`, 'multiaddr'), 'utf8').trim(); } catch { return ''; } };
  RELAY1 = multiaddrOf(1);
  RELAY2 = multiaddrOf(2);
  if (!RELAY1 || !RELAY2) return skip(`no devnet: the multiaddr of node 1 or node 2 is missing under ${DEVNET_DIR}`);
  if (nodeConfig(1)?.nodeRole !== 'core' || nodeConfig(2)?.nodeRole !== 'core') return skip('node 1 and node 2 must be Cores, the relays of the members');
  for (const node of [OWNER, M1, M2]) {
    if (existsSync(join(DEVNET_DIR, `node${node}`))) return skip(`${join(DEVNET_DIR, `node${node}`)} already exists (set MEMBER_SHARING_NODES)`);
  }
  say(`bound ${seconds(BOUND_MS)} s per write, ${seconds(SYNCED_MS)} s for the synced flag; owner node${OWNER}, members node${M1} and node${M2} (member 2 with one sync slot and no queue); run ${STAMP}`);

  // Reachable through relays only: the owner through node 1 and node 2, member 1
  // through node 1 (the devnet's relay for an Edge), member 2 through node 2.
  await startEdge(OWNER, { preferredRelays: [RELAY2], announceAddresses: [DEAD_DIRECT_ADDRESS, `${RELAY1}/p2p-circuit`, `${RELAY2}/p2p-circuit`] });
  await startEdge(M1, { relay: RELAY1, announceAddresses: [DEAD_DIRECT_ADDRESS, `${RELAY1}/p2p-circuit`] });
  await startEdge(M2, { relay: RELAY2, announceAddresses: [DEAD_DIRECT_ADDRESS, `${RELAY2}/p2p-circuit`], syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 });
  await dialOwner(M1);
  await dialOwner(M2);
  say(`temporary Edges up and dialed (${elapsed()})`);

  // The unregistered public graph carries cases 1 to 6; without it nothing runs.
  // A registered or a private graph that cannot be set up fails case 7 and
  // leaves the other cases to run.
  const pub = await createGraph('public', { accessPolicy: 0, publishPolicy: 1, register: false });
  await keepCoresOut(pub);
  let graphs = [pub];
  const caseOf = (graph, publicCase) => (graph === pub ? publicCase : 7);
  const setUp = async (graph, step) => {
    if (graph === pub) return step();
    try { await step(); } catch (error) {
      fail(7, `${graph.key}: ${error?.message ?? error}; no case runs on this graph`);
      graphs = graphs.filter(g => g !== graph);
    }
  };
  for (const [key, body] of [
    ['registered', { accessPolicy: 0, publishPolicy: 1, register: true }],
    ['private', { accessPolicy: 1, publishPolicy: 0, register: true, allowedAgents: [AGENT[OWNER], AGENT[M1], AGENT[M2]] }],
  ]) {
    try {
      const graph = await createGraph(key, body);
      graphs.push(graph);
    } catch (error) { fail(7, `the ${key} graph could not be set up: ${error?.message ?? error}; no case runs on it`); }
  }
  // The large graph of case 6; a failure here fails case 6 only.
  let big = null;
  try {
    big = await createGraph('large', { accessPolicy: 0, publishPolicy: 1, register: false });
    await keepCoresOut(big);
    await fillBigGraph(big);
    say(`large graph written: ${BIG_ASSETS} assets of ${BIG_TRIPLES} triples (${elapsed()})`);
  } catch (error) {
    fail(6, `the large graph could not be set up: ${error?.message ?? error}; case 6 did not run`);
    big = null;
  }

  // Case 3 (7): history, written before the members subscribe. Each member's
  // bound starts at its own subscribe, and so does the watch of its synced flag
  // (case 8).
  await precondition(3, 'before the history');
  const history = [];
  for (const graph of graphs) {
    for (const sub of [null, SUB]) history.push(await write(OWNER, graph, sub, `history ${sub ? 'sub-graph' : 'root'}`));
  }
  const historyWatches = [];
  const syncedWatches = [];
  const definitionWatches = [];
  // setUp replaces `graphs` when a graph drops out; this loop keeps the list it started with.
  for (const graph of graphs) {
    await setUp(graph, async () => {
      for (const member of [M1, M2]) {
        await subscribe(member, graph);
        historyWatches.push(watch(history.filter(record => record.graph === graph).map(record => ({
          caseId: caseOf(graph, 3), record, node: member, from: graph.subscribedAt[member], fromWhat: 'member subscribed',
        }))));
        syncedWatches.push(watchSynced(member, graph));
        definitionWatches.push(watchDefinition(caseOf(graph, 3), member, graph));
      }
    });
  }
  say(`members subscribed (${elapsed()})`);
  await Promise.all([...syncedWatches, ...definitionWatches]);
  await settle(historyWatches);

  // Case 1 (7): the owner writes, live. Case 2 (7): a member writes; the owner
  // and the other member must hold it.
  await precondition(1, 'before the owner writes');
  const live = [];
  for (const graph of graphs) {
    for (const sub of [null, SUB]) live.push(await writeAndWatch(caseOf(graph, 1), OWNER, graph, sub, `owner live ${sub ? 'sub-graph' : 'root'}`, [M1, M2]));
  }
  await precondition(2, 'before the members write');
  for (const graph of graphs.filter(g => !g.private)) {
    for (const sub of [null, SUB]) {
      live.push(await writeAndWatch(caseOf(graph, 2), M1, graph, sub, `member1 live ${sub ? 'sub-graph' : 'root'}`, [OWNER, M2]));
      if (graph === pub) live.push(await writeAndWatch(2, M2, graph, sub, `member2 live ${sub ? 'sub-graph' : 'root'}`, [OWNER, M1]));
    }
  }
  await settle(live);

  // Case 6: member 2's only sync slot busy with a large transfer of another graph.
  if (big) await busyMember(pub, big);

  // Case 5: members that subscribed LATER_MS ago.
  const since = Math.max(pub.subscribedAt[M1], pub.subscribedAt[M2]);
  const rest = since + LATER_MS - Date.now();
  if (rest > 0) { say(`waiting ${seconds(rest)} s for case 5 (${elapsed()})`); await sleep(rest); }
  await precondition(5, `${seconds(Date.now() - since)} s after the members subscribed`);
  await settle([
    await writeAndWatch(5, OWNER, pub, null, 'owner later, root', [M1, M2]),
    await writeAndWatch(5, OWNER, pub, SUB, 'owner later, sub-graph', [M1, M2]),
    await writeAndWatch(5, M1, pub, null, 'member1 later, root', [OWNER, M2]),
    await writeAndWatch(5, M2, pub, SUB, 'member2 later, sub-graph', [OWNER, M1]),
  ]);

  // Case 4: a member restart. What was written while it was down must reach it
  // within the bound of its return; the nodes that stayed up get the usual bound.
  const stopped = await devnetSh(['stop-node', String(M1)]);
  if (stopped.status !== 0) throw new Error(`member1 could not be stopped: ${lastLines(stopped.output)}`);
  const whileDown = [
    await writeAndWatch(4, OWNER, pub, null, 'owner while member1 is down, root', [M2]),
    await writeAndWatch(4, OWNER, pub, SUB, 'owner while member1 is down, sub-graph', [M2]),
    await writeAndWatch(4, M2, pub, null, 'member2 while member1 is down, root', [OWNER]),
  ];
  const missed = whileDown.map(handle => handle.pairs[0].record);
  const restarted = await devnetSh(['restart-node', String(M1)]);
  if (restarted.status !== 0) throw new Error(`member1 did not restart: ${lastLines(restarted.output)}`);
  await identify(M1);
  await dialOwner(M1);
  const backAt = Date.now();
  whileDown.push(watch(missed.map(record => ({ caseId: 4, record, node: M1, from: backAt, fromWhat: 'member restarted' }))));
  await precondition(4, 'after the member restart');
  whileDown.push(await writeAndWatch(4, OWNER, pub, SUB, 'owner after member1 restarted, sub-graph', [M1, M2]));
  await settle(whileDown);

  // Then an owner restart: live writes in both directions.
  const ownerRestarted = await devnetSh(['restart-node', String(OWNER)]);
  if (ownerRestarted.status !== 0) throw new Error(`the owner did not restart: ${lastLines(ownerRestarted.output)}`);
  await identify(OWNER);
  await dialOwner(M1);
  await dialOwner(M2);
  await precondition(4, 'after the owner restart');
  await settle([
    await writeAndWatch(4, OWNER, pub, null, 'owner after it restarted, root', [M1, M2]),
    await writeAndWatch(4, M2, pub, SUB, 'member2 after the owner restarted, sub-graph', [OWNER, M1]),
  ]);

  // No Core carried anything, and the members never reached each other.
  const cores = await coresFollowing(pub);
  if (cores.following.length) fail(2, `at the end Core(s) ${cores.following.join(', ')} follow the public graph: their gossip may have carried writes`);
  if (cores.unknown.length) fail(2, `at the end it is not known whether Core(s) ${cores.unknown.join(', ')} follow the public graph`);
  await precondition(2, 'at the end');
}

function skip(reason) { say(`SKIP: ${reason}`); EXIT = 3; }

function cleanup() {
  if (process.env.MEMBER_SHARING_KEEP_NODES === '1') {
    if (STARTED_NODES.length) say(`MEMBER_SHARING_KEEP_NODES=1: node(s) ${STARTED_NODES.join(', ')} left running`);
    return;
  }
  const failed = Object.values(findings).some(f => f.fail.length) || EXIT === 1;
  const kept = join(DEVNET_DIR, 'issue-3251-member-sharing', STAMP);
  for (const node of STARTED_NODES) {
    devnetShSync(['stop-node', String(node)]);
    if (failed && existsSync(logFile(node))) {
      mkdirSync(kept, { recursive: true });
      copyFileSync(logFile(node), join(kept, `node${node}-${role(node)}.daemon.log`));
    }
    rmSync(join(DEVNET_DIR, `node${node}`), { recursive: true, force: true });
  }
  if (failed && existsSync(kept)) say(`kept the logs of the temporary nodes in ${kept}`);
}

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
  console.log('');
  say(`Results (${elapsed()}; bound ${seconds(BOUND_MS)} s per write, ${seconds(SYNCED_MS)} s for the synced flag):`);
  const { rows, failed } = caseVerdicts(CASES, findings);
  for (const row of rows) {
    const known = [row.expected && `${row.expected} expected failure(s)`, row.unexpected && `${row.unexpected} known-gap check(s) held`].filter(Boolean);
    console.log(`  case ${row.id} ${row.verdict.padEnd(7)} ${row.title} (${row.held} held, ${row.failed} failed${known.length ? `, ${known.join(', ')}` : ''})`);
  }
  const expected = rows.reduce((n, row) => n + row.expected, 0);
  const unexpected = rows.reduce((n, row) => n + row.unexpected, 0);
  for (const gap of Object.values(KNOWN_GAPS)) {
    if (expected || unexpected) say(`known gap ${gap.issue} (${gap.what}): ${expected} check(s) failed as expected${unexpected ? `, ${unexpected} held: remove the expected failure once ${gap.issue} is fixed` : ''}`);
  }
  if (failed.length) EXIT = 1;
  say(failed.length ? `NOT PASSED: case(s) ${failed.join(', ')}` : expected ? 'every case passed, apart from the expected failures of known gaps' : 'every case passed');
}
process.exit(EXIT);
