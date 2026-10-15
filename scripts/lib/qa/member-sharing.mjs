// The judgements of devnet-test-issue-3251-member-sharing.mjs, kept apart from
// its devnet I/O so that each one is tested on its own.

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
 * A missed check on a registered graph is the known gap #3264 (an expected
 * failure) only with evidence that this member lacks the graph's definition:
 * `definitionHeld` false, read in the same listing. A member that holds the
 * definition, or whose listing could not be read (undefined), fails.
 */
export function registeredGapVerdict({ registered, definitionHeld }) {
  return registered === true && definitionHeld === false ? 'xfail' : 'fail';
}

/**
 * When the node admitted sync work whose label contains `needle` to its
 * global slots (e.g. `:<graph id>:` for any operation on that graph): the
 * times (ms, local clock, second resolution) of its
 * `Sync backpressure running <label> …` log lines, oldest first.
 */
export function admissionStarts(logText, needle) {
  const marker = 'Sync backpressure running ';
  const starts = [];
  for (const line of String(logText ?? '').split('\n')) {
    const at = line.indexOf(marker);
    if (at === -1 || !line.slice(at + marker.length).split(' ', 1)[0].includes(needle)) continue;
    const time = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) /.exec(line);
    if (time) starts.push(new Date(`${time[1]}T${time[2]}`).getTime());
  }
  return starts;
}

/**
 * Whether a reading shows the policy of case 6's member: one sync slot and no
 * queue (`syncGlobalMaxInflight: 1`, `syncGlobalQueueLimit: 0`). The reading
 * reports the node's effective policy, so an environment override
 * (`DKG_SYNC_GLOBAL_MAX_INFLIGHT`, …) that gave it spare slots shows here.
 * Returns null when it does, else the reason.
 */
export function singleSlotProblem(reading) {
  if (!reading || reading.unreadable) return `the sync slots could not be read (${reading?.unreadable ?? 'no reading'})`;
  if (reading.capacityModel !== 'shared') return `the sync slots are not one shared pool (${reading.capacityModel ?? 'no capacity model'})`;
  if (reading.inflightLimit !== 1) return `the node runs ${reading.inflightLimit ?? 'an unknown number of'} sync slot(s), not one`;
  if (reading.queueLimit !== 0) return `the node has a sync queue of ${reading.queueLimit ?? 'unknown size'}, not none`;
  return null;
}

/**
 * Whether one admission held the node's only sync slot through [from, until],
 * the window of the writes and of their receipt checks. `admissionStartMs` is
 * when that admission started (from the log); `samples` are readings of the
 * node's `sync-global` scheduler ({ at, inflight, oldestActiveAgeMs,
 * inflightLimit, queueLimit, capacityModel }, or { at, unreadable }).
 *
 * Only readings inside the window are evidence: a reading taken before it (a
 * free slot before the transfer was admitted, say) neither proves nor
 * disproves anything about it. Each reading in the window must show the
 * single-slot policy, work in flight, and the oldest running admission
 * started when this one did; the window must hold at least one reading and no
 * gap longer than `maxGapMs` (from its start, between readings, to its end).
 * A catch-up job that is merely running proves nothing: without an admission
 * there is nothing that holds the slot.
 * Returns { held: true, provenUntil } or { held: false, reason, provenUntil }.
 */
export function busySlotCovered({ admissionStartMs, samples, from, until, toleranceMs = 2500, maxGapMs = 5000 }) {
  if (!Number.isFinite(admissionStartMs)) return { held: false, reason: 'no transfer of it was admitted to a sync slot', provenUntil: null };
  const inWindow = samples.filter(sample => sample.at >= from && sample.at <= until).sort((a, b) => a.at - b.at);
  if (inWindow.length === 0) return { held: false, reason: 'no reading of the sync slot in the window', provenUntil: null };
  let previous = from;
  let provenUntil = null;
  for (const sample of inWindow) {
    if (sample.at - previous > maxGapMs) return { held: false, reason: `no reading of the sync slot for ${Math.round((sample.at - previous) / 1000)} s`, provenUntil };
    if (sample.unreadable) return { held: false, reason: `the sync slot could not be read (${sample.unreadable})`, provenUntil };
    const policy = singleSlotProblem(sample);
    if (policy) return { held: false, reason: policy, provenUntil };
    if (!(sample.inflight >= 1)) return { held: false, reason: 'the sync slot was free', provenUntil };
    if (Math.abs(sample.at - sample.oldestActiveAgeMs - admissionStartMs) > toleranceMs) {
      return { held: false, reason: 'the slot was held by other work', provenUntil };
    }
    previous = sample.at;
    provenUntil = sample.at;
  }
  if (until - previous > maxGapMs) return { held: false, reason: `no reading of the sync slot for the last ${Math.round((until - previous) / 1000)} s`, provenUntil };
  return { held: true, provenUntil };
}

/**
 * A write refused as a write to an unknown graph is the known gap #3264 only
 * on the registered graph and with evidence that the author lacked the
 * definition. The refusal is judged by its structured code, never by the
 * wording of the message.
 */
export function refusedWriteVerdict({ errorCode, registered, definitionHeld }) {
  return errorCode === 'CONTEXT_GRAPH_NOT_FOUND' ? registeredGapVerdict({ registered, definitionHeld }) : 'fail';
}

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
 * The verdicts of an observed subscription, kept apart from the reporting:
 * `definition` (case 3, or 7 on the registered and private graphs) and
 * `synced` (case 8), each 'pass' | 'xpass' | 'xfail' | 'fail' | 'none'
 * with what was seen. On the registered graph a missing definition is #3264
 * (xfail), a held one is printed as XPASS, and a synced flag that stays false
 * is #3264 only when the deadline's listing shows no definition.
 */
export function subscriptionVerdicts(observation, { registered, definitionMs, syncedMs }) {
  const secs = ms => Math.round(ms / 1000);
  const definition = (() => {
    const { definedAt, atDefinitionDeadline: last } = observation;
    if (definedAt !== null && definedAt < definitionMs) {
      return registered ? { verdict: 'xpass', text: `holds the definition ${secs(definedAt)} s after it subscribed` } : { verdict: 'none', text: '' };
    }
    if (definedAt !== null) return { verdict: 'fail', text: `holds the definition only ${secs(definedAt)} s after it subscribed` };
    if (!last?.readable) return { verdict: 'fail', text: `its listing could not be read ${secs(definitionMs)} s after it subscribed (${last?.why ?? 'no reading'})` };
    const text = `holds no definition ${secs(definitionMs)} s after it subscribed: ${last.entry ? `its listing has no access policy for it (${JSON.stringify(last.entry).slice(0, 200)})` : 'its listing does not name it'}; a write it makes there is refused`;
    return { verdict: registeredGapVerdict({ registered, definitionHeld: false }), text };
  })();
  const synced = (() => {
    const { syncedAt, atSyncedDeadline: last } = observation;
    if (syncedAt !== null && syncedAt < syncedMs) return { verdict: 'pass', text: `lists it as synced ${secs(syncedAt)} s after it subscribed` };
    if (!last?.readable) return { verdict: 'fail', text: `its listing could not be read ${secs(syncedMs)} s after it subscribed (${last?.why ?? 'no reading'})` };
    const seen = syncedAt !== null
      ? `lists it as synced only ${secs(syncedAt)} s after it subscribed`
      : `lists it as ${last.entry ? `subscribed=${last.entry.subscribed} synced=${last.entry.synced}` : 'absent'} ${secs(syncedMs)} s after it subscribed`;
    const verdict = registeredGapVerdict({ registered, definitionHeld: last.defined });
    return { verdict, text: verdict === 'xfail' ? `${seen}; it holds no definition of the graph` : `${seen}${registered ? '; it holds the definition, so this is not #3264' : ''}` };
  })();
  return { definition, synced };
}
