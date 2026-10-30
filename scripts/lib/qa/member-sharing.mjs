// The judgements of devnet-test-issue-3251-member-sharing.mjs, kept apart from
// its devnet I/O so that each one is tested on its own. A check returns an
// ordinary result ({ check, outcome, text, evidence }); the known gaps
// (known-gaps.mjs) are applied to it when it is reported. Case 6's evidence is
// judged in busy-slot.mjs.

import { definitionState, readListing } from './context-graph-listing.mjs';

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

const cellText = cell => (cell !== null && typeof cell === 'object' ? String(cell.value ?? '') : String(cell ?? ''));
const bare = iri => iri.replace(/^<|>$/g, '');

/**
 * The text of a literal cell of the query API: an N-Triples term (`"text"`,
 * `"text"@en`, `"text"^^<xsd:string>`) or a SPARQL-results object. The suite
 * writes plain ASCII without quotes or backslashes, so no escape is decoded;
 * anything else (an IRI, a blank node, a typed literal of another type, a cell
 * that is not a term) is not a text and answers null.
 */
export function literalText(cell) {
  if (cell !== null && typeof cell === 'object') {
    if (cell.type === 'uri' || cell.type === 'bnode' || typeof cell.value !== 'string') return null;
    return typeof cell.datatype === 'string' && cell.datatype !== XSD_STRING ? null : cell.value;
  }
  if (typeof cell !== 'string' || !cell.startsWith('"')) return null;
  const end = cell.lastIndexOf('"');
  if (end < 1) return null;
  const rest = cell.slice(end + 1);
  return rest === '' || /^@[A-Za-z]+(-[A-Za-z0-9]+)*$/.test(rest) || rest === `^^<${XSD_STRING}>` ? cell.slice(1, end) : null;
}

/**
 * Whether rows of one subject hold the written value: the predicate is there,
 * and every value held for it is the written one. A node that answers the
 * written value AND another one holds corrupted content, not the write.
 */
export function judgeHeld(rows, { predicate, value }) {
  const found = rows.filter(row => bare(cellText(row.p)) === predicate);
  if (found.length === 0) return { held: false };
  const other = found.map(row => literalText(row.o)).filter(text => text !== value);
  if (other.length === 0) return { held: true };
  return { held: false, different: [...new Set(other.map(text => (text === null ? 'a value that is not a text' : JSON.stringify(text))))].join(' | ') };
}

/** The shared memory of a context graph's root, or of one of its sub-graphs. */
export const sharedMemoryScope = (contextGraphId, subGraphName) =>
  `did:dkg:context-graph:${contextGraphId}/${subGraphName ? `${subGraphName}/` : ''}_shared_memory`;

/**
 * A graph of a cross-partition read is in a scope when it is the scope itself
 * or a graph below it (one per asset), not a sub-graph's shared memory when the
 * root was asked for, and not the bookkeeping graph beside it.
 */
export function inScope(graphCell, scope) {
  const graph = bare(cellText(graphCell));
  return graph === scope || graph.startsWith(`${scope}/`);
}

/**
 * What the connections of one node to one peer say about the topology.
 * `link` is { readable, total, relayed } (from /api/connections); `expect` is
 * 'relayed' (at least one connection, every one through a relay) or 'none'.
 * Returns the problem as a sentence, or null. An unreadable list is a
 * problem: it says nothing about the link.
 */
export function linkProblem(link, expect, from, to) {
  if (!link?.readable) return `the connections of ${from} could not be read`;
  if (expect === 'none') return link.total > 0 ? `${from} holds ${link.total} connection(s) to ${to}` : null;
  if (link.total === 0) return `${from} holds no connection to ${to}`;
  if (link.relayed !== link.total) return `${from} holds ${link.total - link.relayed} direct connection(s) to ${to}`;
  return null;
}

/**
 * The verdict of each case: FAIL when one of its checks failed; PASS when at
 * least one check held or failed only as a known gap, and none failed
 * otherwise; NOT RUN when nothing was checked (a case that never ran is not a
 * case that passed). `findings` maps a case id to { pass: <count>,
 * fail: [<text>], xfail: [<text>], xpass: [<text>] }: an expected failure of a
 * known gap (xfail) does not fail its case, and a check of a known gap that
 * held (xpass) is counted as held and reported, so its expected failure can
 * be removed once the gap is fixed.
 */
export function caseVerdicts(cases, findings) {
  const rows = Object.entries(cases).map(([id, title]) => {
    const f = { pass: 0, fail: [], xfail: [], xpass: [], ...findings[id] };
    const verdict = f.fail.length ? 'FAIL' : f.pass > 0 || f.xfail.length > 0 ? 'PASS' : 'NOT RUN';
    return { id, title, verdict, held: f.pass, failed: f.fail.length, expected: f.xfail.length, unexpected: f.xpass.length };
  });
  return { rows, failed: rows.filter(row => row.verdict !== 'PASS').map(row => row.id) };
}

/**
 * One read folded into a pair's progress ({ view, partitions }: the age at
 * which each read first found the write, or null). Each read keeps the time it
 * completed itself; a read that completed after the bound does not count, and
 * a read already satisfied is never undone, so a slow or failed later read of
 * one kind cannot discard a timely success of the other.
 */
export function foldRead(progress, kind, { held, completedAt }, { from, boundMs }) {
  if (progress[kind] !== null) return progress;
  const age = completedAt - from;
  if (!held || age >= boundMs) return progress;
  return { ...progress, [kind]: age };
}
export const pairHeld = progress => progress.view !== null && progress.partitions !== null;

/**
 * One member's subscription, observed by one poller of its listing: when it
 * first held the graph's definition and when it first listed the graph as
 * synced (ages in ms from the subscribe), each against its own deadline, and
 * the listing as read at each deadline. `listed` is { readable, defined,
 * entry, why }. Returns the next observation; `done` once both deadlines are
 * settled (a success before its deadline, or the deadline's listing).
 */
export function foldSubscription(observation, listed, age, { definitionMs, syncedMs }) {
  const next = { ...observation };
  if (next.atDefinitionDeadline === null) {
    if (listed.readable && listed.defined && next.definedAt === null) next.definedAt = age;
    if (age >= definitionMs) next.atDefinitionDeadline = listed;
  }
  if (next.atSyncedDeadline === null) {
    if (listed.readable && listed.entry?.synced === true && next.syncedAt === null) next.syncedAt = age;
    if (age >= syncedMs) next.atSyncedDeadline = listed;
  }
  const settled = (at, deadlineListing, ms) => (at !== null && at < ms) || deadlineListing !== null;
  next.done = settled(next.definedAt, next.atDefinitionDeadline, definitionMs) && settled(next.syncedAt, next.atSyncedDeadline, syncedMs);
  return next;
}
export const freshSubscription = () => ({ definedAt: null, syncedAt: null, atDefinitionDeadline: null, atSyncedDeadline: null, done: false });

/**
 * The results of an observed subscription, as ordinary checks with their
 * evidence (the known gaps of known-gaps.mjs are applied when they are
 * reported): `definition` (case 3, or 7 on the registered and private graphs)
 * and `synced` (case 8). A definition held in time is a quiet pass: a
 * precondition of the member's own writes, not a delivery. The evidence is the
 * graph's `registered` (on chain) and `private`; `member` (the subscriber is
 * a member, not the owner); `definitionHeld`, whether the listing read at the
 * deadline showed the definition (undefined when it could not be read); and
 * `definitionSeen`, whether the member was seen holding it before that
 * listing, so that a definition lost is told from one never obtained.
 */
export function subscriptionResults(observation, { registered, private: isPrivate, member, definitionMs, syncedMs }) {
  const secs = ms => Math.round(ms / 1000);
  const { definedAt } = observation;
  const evidence = (definitionHeld, definitionSeen) => ({ registered, private: isPrivate, member, definitionHeld, definitionSeen });
  const definition = (() => {
    const { atDefinitionDeadline: last } = observation;
    const result = (outcome, text, definitionHeld) => ({ check: 'definition', outcome, text, evidence: evidence(definitionHeld, definedAt !== null) });
    if (definedAt !== null && definedAt < definitionMs) return { ...result('pass', `holds the definition ${secs(definedAt)} s after it subscribed`, true), quiet: true };
    if (definedAt !== null) return result('fail', `holds the definition only ${secs(definedAt)} s after it subscribed`, true);
    if (!last?.readable) return result('fail', `its listing could not be read ${secs(definitionMs)} s after it subscribed (${last?.why ?? 'no reading'})`, undefined);
    const seen = last.entry ? `its listing has no access policy for it (${JSON.stringify(last.entry).slice(0, 200)})` : 'its listing does not name it';
    return result('fail', `holds no definition ${secs(definitionMs)} s after it subscribed: ${seen}; a write it makes there is refused`, false);
  })();
  const synced = (() => {
    const { syncedAt, atSyncedDeadline: last } = observation;
    // Seen before the deadline's listing: a poll earlier than the deadline found it.
    const result = (outcome, text, definitionHeld) => ({ check: 'synced', outcome, text, evidence: evidence(definitionHeld, definedAt !== null && definedAt < syncedMs) });
    if (syncedAt !== null && syncedAt < syncedMs) return result('pass', `lists it as synced ${secs(syncedAt)} s after it subscribed`, undefined);
    if (!last?.readable) return result('fail', `its listing could not be read ${secs(syncedMs)} s after it subscribed (${last?.why ?? 'no reading'})`, undefined);
    const seen = syncedAt !== null
      ? `lists it as synced only ${secs(syncedAt)} s after it subscribed`
      : `lists it as ${last.entry ? `subscribed=${last.entry.subscribed} synced=${last.entry.synced}` : 'absent'} ${secs(syncedMs)} s after it subscribed`;
    return result('fail', seen, last.defined);
  })();
  return { definition, synced };
}

/**
 * What one answer of a node's own listing (GET /api/context-graph/list) says
 * about one graph, through the shared listing parser: { readable: true, entry
 * (null when the listing does not name it), defined (it holds the graph's
 * definition) } or { readable: false, reason }.
 */
export function listingObservation(httpStatus, body, contextGraphId) {
  const listing = readListing(httpStatus, body);
  if (!listing.ok) return { readable: false, reason: listing.reason };
  return {
    readable: true,
    entry: listing.graphs.find(entry => entry.id === contextGraphId) ?? null,
    defined: definitionState(httpStatus, body, contextGraphId).state === 'defined',
  };
}

/** One answer of a node's connections (GET /api/connections): { readable, connections }. */
export function connectionsObservation(httpStatus, json) {
  return httpStatus === 200 && Array.isArray(json?.connections) ? { readable: true, connections: json.connections } : { readable: false };
}

/**
 * The topology every conclusion rests on, judged from one observation of each
 * node's connections (`observations`: node number -> connectionsObservation).
 * `links` are [from, to, 'relayed' | 'none'] between node records ({ number,
 * label, peerId }); `members` must hold no connection to a peer outside the
 * devnet (`known`: its peer ids), which could carry the graph. Returns the
 * problems as sentences, those of the links first, or none. A node whose
 * connections could not be read fails every link from it.
 */
export function topologyProblems({ observations, links, members, known }) {
  const problems = [];
  for (const [from, to, expect] of links) {
    const seen = observations.get(from.number);
    const mine = seen?.readable ? seen.connections.filter(c => c.peerId === to.peerId) : null;
    const link = mine ? { readable: true, total: mine.length, relayed: mine.filter(c => c.transport === 'relayed').length } : { readable: false };
    const problem = linkProblem(link, expect, from.label, to.label);
    if (problem) problems.push(problem);
  }
  for (const member of members) {
    const seen = observations.get(member.number);
    if (!seen?.readable) continue; // reported by the link checks
    const strangers = [...new Set(seen.connections.map(c => c.peerId).filter(id => typeof id === 'string' && !known.has(id)))];
    if (strangers.length) problems.push(`${member.label} is connected to ${strangers.length} peer(s) that are no node of this devnet (${strangers.map(id => id.slice(-8)).join(', ')}): they could carry the graph`);
  }
  return problems;
}

/**
 * What a node's answer to an asynchronous share says about its job, by the
 * client rule of docs/build/async-jobs.md. `job`: poll `jobId`, which is stored
 * or, with a 409 that names it, the same share still running. `indeterminate`:
 * a job may exist under `jobId`, so read it and do not resend. `not-admitted`:
 * no job was written, so send the same request again after Retry-After.
 * `refused`: anything else, which no client rule says to wait out.
 */
export function shareAdmission(status, json) {
  if (status === 200 && json?.jobId) return { kind: 'job', jobId: json.jobId };
  if (status === 409 && json?.existingJobId) return { kind: 'job', jobId: json.existingJobId };
  if (status === 503 && json?.code === 'PROMOTE_ADMISSION_UNAVAILABLE') {
    if (json.admissionOutcome === 'indeterminate' && json.jobId) return { kind: 'indeterminate', jobId: json.jobId, phase: json.phase };
    if (json.admissionOutcome === 'not_admitted') return { kind: 'not-admitted', phase: json.phase };
  }
  return { kind: 'refused' };
}

/** Where a write went, and the write as the report names it. */
export const where = record => `${record.graph.key}${record.sub ? `/${record.sub}` : ' root'}`;
export const describe = record => `"${record.value}" by ${record.author.label} in ${where(record)}`;

/**
 * One pair's result (a write, and a node that must hold it), as an ordinary
 * check with its evidence: held when both reads found the write within the
 * bound; missing otherwise, with what each read last saw; or refused, with
 * whether its author is a member, the refusal's structured code, whether the
 * author held the graph's definition right after it, and `definitionSeen`:
 * whether anything ever showed the author holding it, a snapshot of its
 * history taken when the write is judged (observation.mjs keeps it), so that
 * a definition obtained and lost after the subscription counts.
 */
export function pairResult(pair, { boundMs, definitionSeen }) {
  const secs = ms => Math.round(ms / 1000);
  const what = `${describe(pair.record)} at ${pair.node.label}`;
  const { record } = pair;
  if (record.error) {
    return {
      check: 'write-refused', outcome: 'fail', text: `${what}: not written, ${record.error}`,
      evidence: {
        registered: record.graph.registered, private: record.graph.private, member: record.author.member === true,
        definitionHeld: record.definitionHeld, definitionSeen, errorCode: record.errorCode,
      },
    };
  }
  const { view, partitions } = pair.progress;
  const after = pair.fromWhat ?? 'share';
  if (pairHeld(pair.progress)) return { check: 'held', outcome: 'pass', text: `${what}: held ${secs(Math.max(view, partitions))} s after the ${after}` };
  const missing = [];
  if (view === null) missing.push(`the shared-working-memory view${readDetail(pair.last.view)}`);
  if (partitions === null) missing.push(`the cross-partition read${readDetail(pair.last.partitions)}`);
  const found = [view !== null && `view after ${secs(view)} s`, partitions !== null && `partitions after ${secs(partitions)} s`].filter(Boolean);
  return { check: 'held', outcome: 'fail', text: `${what}: NOT in ${missing.join(' nor in ')} ${secs(boundMs)} s after the ${after}${found.length ? ` (found in ${found.join(', ')})` : ''}` };
}
function readDetail(read) {
  if (!read) return '';
  if (read.different) return ` (holds another value: ${read.different})`;
  if (read.error) return ` (${read.error})`;
  return '';
}
