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
//      another graph (MEMBER_SHARING_BIG_ASSETS x MEMBER_SHARING_BIG_TRIPLES);
//      the case fails as not exercised if that transfer was not running
//      before the first write and after the last one
//   7  cases 1, 2 and 3 on a public graph registered on chain, and cases 1
//      and 3 on a private graph whose members joined through the signed
//      request flow. A member's write into a private graph sets up its sender
//      key with every other member directly, which members that reach only
//      the owner cannot do, so case 2 does not apply there.
//   8  the `synced` flag of every member, for every graph
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
import { subscriptionState } from './lib/qa/context-graph-listing.mjs';
import { caseVerdicts, inScope, judgeHeld, linkProblem, sharedMemoryScope } from './lib/qa/member-sharing.mjs';

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
const findings = Object.fromEntries(Object.keys(CASES).map(id => [id, { pass: 0, fail: [] }]));
const pass = (id, text) => { findings[id].pass += 1; console.log(`  [PASS] case ${id}: ${text}`); };
const fail = (id, text) => { findings[id].fail.push(text); console.log(`  [FAIL] case ${id}: ${text}`); };
const note = text => console.log(`  [NOTE] ${text}`);

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
  return { key, id, resolved, private: body.accessPolicy === 1, subscribedAt: {} };
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

async function listingEntry(node, graph) {
  const answer = await api(node, 'GET', '/api/context-graph/list');
  if (answer.status !== 200 || !Array.isArray(answer.json?.contextGraphs)) return { readable: false, why: brief(answer) };
  return { readable: true, entry: answer.json.contextGraphs.find(entry => entry.id === graph.id) ?? null };
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

/** One asset with a subject of its own, created and shared through the asynchronous share job, as a client does. */
async function write(author, graph, sub, what) {
  sequence += 1;
  const record = {
    author, graph, sub, what, sequence,
    subject: `urn:issue3251:${STAMP}:${sequence}`,
    value: `${what} (${sequence})`,
    doneAt: null, error: null,
  };
  const name = `i3251-${STAMP.toLowerCase()}-${sequence}`;
  const created = await api(author, 'POST', '/api/knowledge-assets', {
    contextGraphId: graph.id, name, ...(sub ? { subGraphName: sub } : {}),
    quads: [{ subject: record.subject, predicate: LABEL, object: `"${record.value}"`, graph: '' }],
    finalize: true, alsoShareSwm: false,
  }, { timeoutMs: 120_000 });
  if (created.status !== 200 && created.status !== 201) { record.error = `the author refused the asset: ${brief(created)}`; return record; }
  const queued = await api(author, 'POST', `/api/knowledge-assets/${name}/swm/share-async`,
    { contextGraphId: graph.id, entities: 'all', ...(sub ? { subGraphName: sub } : {}) });
  const job = queued.json?.jobId;
  if (queued.status !== 200 || !job) { record.error = `the share was not accepted: ${brief(queued)}`; return record; }
  const finished = await waitFor(async () => {
    const view = await api(author, 'GET', `/api/knowledge-assets/swm/share-jobs/${encodeURIComponent(job)}`);
    return { ok: ['succeeded', 'failed'].includes(view.json?.state), view };
  }, 120_000, 1000);
  if (finished.view?.json?.state !== 'succeeded') {
    record.error = `the share job ended ${finished.view?.json?.state ?? 'unfinished'}: ${JSON.stringify(finished.view?.json?.lastError ?? null).slice(0, 240)}`;
    return record;
  }
  record.doneAt = Date.now();
  return record;
}
const where = record => `${record.graph.key}${record.sub ? `/${record.sub}` : ' root'}`;
const describe = record => `"${record.value}" by ${label(record.author)} in ${where(record)}`;

async function reads(node, record) {
  const view = await api(node, 'POST', '/api/query', {
    contextGraphId: record.graph.id, view: 'shared-working-memory', ...(record.sub ? { subGraphName: record.sub } : {}),
    sparql: `SELECT ?p ?o WHERE { <${record.subject}> ?p ?o }`,
  }, { timeoutMs: 30_000 });
  const partitions = await api(node, 'POST', '/api/query', {
    contextGraphId: record.graph.id, includeContextGraphPartitions: true,
    sparql: `SELECT ?g ?p ?o WHERE { GRAPH ?g { <${record.subject}> ?p ?o } }`,
  }, { timeoutMs: 30_000 });
  const scope = sharedMemoryScope(record.graph.resolved, record.sub);
  const rowsOf = answer => (answer.status === 200 && Array.isArray(answer.json?.result?.bindings) ? answer.json.result.bindings : null);
  const viewRows = rowsOf(view);
  const partitionRows = rowsOf(partitions)?.filter(row => inScope(row.g, scope)) ?? null;
  const written = { predicate: LABEL, value: record.value };
  return {
    view: viewRows ? judgeHeld(viewRows, written) : { held: false, error: brief(view) },
    partitions: partitionRows ? judgeHeld(partitionRows, written) : { held: false, error: brief(partitions) },
  };
}

/**
 * Starts watching pairs (write, node that must hold it) at once: each is read
 * until it holds or its bound has passed. Call it when the bound starts (right
 * after the write, the subscribe, the return), so that no pair is judged
 * without having been read inside its bound. A pair's bound starts at `from`
 * (default: the end of the write's share job). Returns a handle { pairs, done },
 * not a promise, so that whoever starts a watch does not wait for it.
 */
function watch(pairs) {
  for (const pair of pairs) {
    pair.from = pair.from ?? pair.record.doneAt;
    pair.viewAt = null; pair.partitionsAt = null; pair.last = null;
  }
  const open = () => pairs.filter(p => !p.record.error && (p.viewAt === null || p.partitionsAt === null) && Date.now() - p.from < BOUND_MS);
  const done = (async () => {
    for (let pending = open(); pending.length > 0; pending = open()) {
      await Promise.all(pending.map(async pair => {
        const seen = await reads(pair.node, pair.record);
        const age = Date.now() - pair.from;
        if (age >= BOUND_MS) return; // the answer came after the bound
        if (seen.view.held && pair.viewAt === null) pair.viewAt = age;
        if (seen.partitions.held && pair.partitionsAt === null) pair.partitionsAt = age;
        pair.last = seen;
      }));
      await sleep(2000);
    }
  })();
  return { pairs, done };
}

/** A write, and at once the watch of the nodes that must hold it (a handle, see watch). */
async function writeAndWatch(caseId, author, graph, sub, what, nodes) {
  return watch(at(caseId, await write(author, graph, sub, what), nodes));
}

/** Waits for the watches, then reports each pair under its case. */
async function settle(handles) {
  await Promise.all(handles.map(handle => handle.done));
  const pairs = handles.flatMap(handle => handle.pairs);
  for (const pair of pairs) {
    const what = `${describe(pair.record)} at ${label(pair.node)}`;
    if (pair.record.error) { fail(pair.caseId, `${what}: not written, ${pair.record.error}`); continue; }
    if (pair.viewAt !== null && pair.partitionsAt !== null) {
      pass(pair.caseId, `${what}: held ${seconds(Math.max(pair.viewAt, pair.partitionsAt))} s after the ${pair.fromWhat ?? 'share'}`);
      continue;
    }
    const missing = [];
    if (pair.viewAt === null) missing.push(`the shared-working-memory view${detail(pair.last?.view)}`);
    if (pair.partitionsAt === null) missing.push(`the cross-partition read${detail(pair.last?.partitions)}`);
    const found = [pair.viewAt !== null && `view after ${seconds(pair.viewAt)} s`, pair.partitionsAt !== null && `partitions after ${seconds(pair.partitionsAt)} s`].filter(Boolean);
    fail(pair.caseId, `${what}: NOT in ${missing.join(' nor in ')} ${seconds(BOUND_MS)} s after the ${pair.fromWhat ?? 'share'}${found.length ? ` (found in ${found.join(', ')})` : ''}`);
  }
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
 */
async function watchDefinition(caseId, node, graph) {
  const from = graph.subscribedAt[node];
  for (;;) {
    const last = await listingEntry(node, graph);
    const age = Date.now() - from;
    if (typeof last.entry?.accessPolicy === 'string' && last.entry.accessPolicy !== '' && age < DEFINITION_MS) return;
    if (age >= DEFINITION_MS) {
      const seen = !last.readable ? `its listing could not be read (${last.why})` : last.entry ? `its listing has no access policy for it (${JSON.stringify(last.entry).slice(0, 200)})` : 'its listing does not name it';
      return fail(caseId, `${label(node)} holds no definition of ${graph.key} ${seconds(age)} s after it subscribed: ${seen}; a write it makes there is refused`);
    }
    await sleep(Math.min(2000, DEFINITION_MS - age));
  }
}

/** Started right after a member subscribed: its `synced` flag for the graph must be true within the bound. */
async function watchSynced(node, graph) {
  const from = graph.subscribedAt[node];
  for (;;) {
    const last = await listingEntry(node, graph);
    const age = Date.now() - from;
    const synced = last.entry?.synced === true;
    if (synced && age < SYNCED_MS) return pass(8, `${label(node)} lists ${graph.key} as synced ${seconds(age)} s after it subscribed`);
    if (age >= SYNCED_MS) {
      if (synced) return fail(8, `${label(node)} lists ${graph.key} as synced only ${seconds(age)} s after it subscribed`);
      if (!last.readable) return fail(8, `${label(node)}: its listing could not be read ${seconds(age)} s after it subscribed to ${graph.key} (${last.why})`);
      return fail(8, `${label(node)} lists ${graph.key} as ${last.entry ? `subscribed=${last.entry.subscribed} synced=${last.entry.synced}` : 'absent'} ${seconds(age)} s after it subscribed`);
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
    const name = `i3251-big-${STAMP.toLowerCase()}-${i}`;
    const created = await api(OWNER, 'POST', '/api/knowledge-assets', { contextGraphId: graph.id, name, quads, finalize: true, alsoShareSwm: false }, { timeoutMs: 300_000 });
    if (created.status !== 200 && created.status !== 201) throw new Error(`asset ${i} of the large graph was refused: ${brief(created)}`);
    const queued = await api(OWNER, 'POST', `/api/knowledge-assets/${name}/swm/share-async`, { contextGraphId: graph.id, entities: 'all' });
    if (!queued.json?.jobId) throw new Error(`asset ${i} of the large graph was not shared: ${brief(queued)}`);
    const finished = await waitFor(async () => {
      const view = await api(OWNER, 'GET', `/api/knowledge-assets/swm/share-jobs/${encodeURIComponent(queued.json.jobId)}`);
      return { ok: ['succeeded', 'failed'].includes(view.json?.state), state: view.json?.state };
    }, 300_000, 2000);
    if (finished.state !== 'succeeded') throw new Error(`asset ${i} of the large graph was not shared (${finished.state ?? 'unfinished'})`);
  }
}

async function catchupState(node, graph) {
  const answer = await api(node, 'GET', `/api/sync/catchup-status?contextGraphId=${encodeURIComponent(graph.id)}`);
  return answer.json?.status ?? (answer.status === 404 ? 'none' : `unreadable (${brief(answer)})`);
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

/** Case 6: member 2 subscribes to the large graph; writes are made while its transfer runs. */
async function busyMember(pub, big) {
  await precondition(6, 'before the large transfer');
  const offset = logSize(M2);
  await subscribe(M2, big);
  const before = await waitFor(async () => {
    const state = await catchupState(M2, big);
    return { ok: state === 'running', state };
  }, 20_000, 300);
  const busy = [
    await writeAndWatch(6, OWNER, pub, null, 'owner while member2 is busy, root', [M2]),
    await writeAndWatch(6, OWNER, pub, SUB, 'owner while member2 is busy, sub-graph', [M2]),
    await writeAndWatch(6, M1, pub, null, 'member1 while member2 is busy, root', [M2]),
  ];
  const after = await catchupState(M2, big);
  await settle(busy);
  const refused = countOf(logSince(M2, offset), `Sync backpressure rejected shared-memory:${pub.id}`);
  if (before.state === 'running' && after === 'running') {
    note(`case 6: member2's catch-up of the large graph was running before the first write and after the last; member2 refused ${refused} pull(s) of the public graph for a busy slot`);
  } else {
    fail(6, `not exercised: member2's catch-up of the large graph was ${before.state} before the first write and ${after} after the last (raise MEMBER_SHARING_BIG_ASSETS / MEMBER_SHARING_BIG_TRIPLES)`);
  }
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
  for (const row of rows) console.log(`  case ${row.id} ${row.verdict.padEnd(7)} ${row.title} (${row.held} held, ${row.failed} failed)`);
  if (failed.length) EXIT = 1;
  say(failed.length ? `NOT PASSED: case(s) ${failed.join(', ')}` : 'every case passed');
}
process.exit(EXIT);
