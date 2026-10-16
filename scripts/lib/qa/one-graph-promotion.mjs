// The judgements of devnet-test-one-graph-promotion.mjs, kept apart from its
// devnet I/O so that each one is tested on its own: where a report is held
// (shared memory or Verified Memory) and when it has left shared memory, what
// a promotion and a member's own publish answered, the topology between the
// Edges, the profile an Edge runs, and the evidence that a large transfer
// held an Edge's only sync slot. The shared-memory reads reuse the judgements
// of member-sharing.mjs.

import { describe, literalText, pairHeld } from './member-sharing.mjs';

const cellText = cell => (cell !== null && typeof cell === 'object' ? String(cell.value ?? '') : String(cell ?? ''));
const bare = iri => iri.replace(/^<|>$/g, '');
const secs = ms => Math.round(ms / 1000);
const brief = answer => `HTTP ${answer?.status ?? 0} ${String(answer?.text ?? '').replace(/\s+/g, ' ').slice(0, 240)}`;

/**
 * The Verified Memory of a sub-graph (or of the root, without one): the
 * sub-graph's content graph, where a confirmed publish writes, and the
 * per-asset graphs below `/_verifiable_memory/`. Its shared memory, working
 * memory and assertion graphs sit under the same root and are not in it.
 */
export function verifiedScope(contextGraphId, subGraphName) {
  const root = `did:dkg:context-graph:${contextGraphId}${subGraphName ? `/${subGraphName}` : ''}`;
  return { root, prefix: `${root}/_verifiable_memory/` };
}
export function inVerifiedScope(graphCell, scope) {
  const graph = bare(cellText(graphCell));
  return graph === scope.root || graph.startsWith(scope.prefix);
}

/**
 * Whether rows of one report's subject hold nothing at all: a report that has
 * left a layer. The reads select only that subject, so any triple of it left
 * in the layer (its value, its body, its class) means it has not left.
 */
export function judgeGone(rows) {
  return { gone: rows.length === 0, found: rows.length };
}

// An IRI cell of the query API: a bare or bracketed IRI, or a SPARQL-results `uri`; null for a literal or a blank node.
function iriText(cell) {
  if (cell !== null && typeof cell === 'object') return cell.type === 'uri' && typeof cell.value === 'string' ? cell.value : null;
  if (typeof cell !== 'string' || cell.startsWith('"') || cell.startsWith('_:')) return null;
  return bare(cell);
}
function cellShown(cell) {
  const text = literalText(cell);
  if (text !== null) return JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}...` : text);
  const iri = iriText(cell);
  return iri !== null ? `<${iri}>` : 'a value that is neither a text nor an IRI';
}

/**
 * Whether rows of one report's subject hold the whole report as it was
 * written: each of its triples (`expected`: [{ name, predicate, iri | text }],
 * its class, its value and its body) is there, and every object held for
 * that predicate is the written one. A layer that holds the value but lost
 * the body or the class does not hold the report, and nor does one that
 * holds another object beside the written one (corrupted content). Other
 * predicates of the subject are not judged. Returns { held } or { held:
 * false, missing (the names of the triples not there, when some are),
 * different }.
 */
export function judgeReport(rows, expected) {
  const missing = [];
  const different = [];
  for (const triple of expected) {
    const objects = rows.filter(row => bare(cellText(row.p)) === triple.predicate).map(row => row.o);
    if (objects.length === 0) {
      missing.push(triple.name);
      continue;
    }
    const wrong = objects.filter(cell => ('iri' in triple ? iriText(cell) !== triple.iri : literalText(cell) !== triple.text));
    if (wrong.length) different.push(`its ${triple.name} ${[...new Set(wrong.map(cellShown))].join(' | ')}`);
  }
  if (missing.length === 0 && different.length === 0) return { held: true };
  // Nothing of the report there at all: simply not held.
  if (missing.length === expected.length) return { held: false };
  return { held: false, ...(missing.length ? { missing } : {}), ...(different.length ? { different: different.join('; ') } : {}) };
}

/**
 * What each kind of pair (a report, a node, what it must show) waits for, and
 * in which layer: `swm` the report in shared memory, `vm` in Verified Memory,
 * `gone` no longer in shared memory (it was just promoted), `absent` not in
 * shared memory (it was promoted before), `kept` in shared memory at every
 * reading while other reports are promoted (`throughout`), `unpublished` not
 * in Verified Memory (its publish was refused). A pair is read twice, with
 * the layer's view and with the cross-partition read, and holds once both
 * showed it.
 */
export const PAIR_KINDS = Object.freeze({
  swm: { layer: 'swm', want: 'held' },
  vm: { layer: 'vm', want: 'held' },
  gone: { layer: 'swm', want: 'gone' },
  absent: { layer: 'swm', want: 'gone' },
  kept: { layer: 'swm', want: 'held', throughout: true },
  unpublished: { layer: 'vm', want: 'gone' },
});
const LAYER_NAMES = { swm: 'shared memory', vm: 'Verified Memory' };

/**
 * One read of a pair, folded to what the pair waits for: { satisfied, error,
 * missing, different, found }. `seen` is { held, missing, different } for a
 * held kind (from judgeReport) and { gone, found } for `gone`, or { error }
 * when the read failed: a failed read satisfies nothing, not even `gone`.
 */
export function readOutcome(kind, seen) {
  if (!PAIR_KINDS[kind]) throw new Error(`unknown pair kind ${kind}`);
  if (seen?.error) return { satisfied: false, error: seen.error };
  if (PAIR_KINDS[kind].want === 'gone') return { satisfied: seen?.gone === true, found: seen?.found ?? 0 };
  return {
    satisfied: seen?.held === true,
    ...(seen?.held !== true && seen?.missing?.length ? { missing: seen.missing } : {}),
    ...(seen?.different ? { different: seen.different } : {}),
  };
}

const viewName = (layer, sub) => `the ${layer === 'vm' ? 'verifiable-memory' : 'shared-working-memory'} view${sub ? ` of ${sub}` : ''}`;
function readDetail(read) {
  if (!read) return ' (never read)';
  if (read.error) return ` (${read.error})`;
  const parts = [read.missing?.length && `without its ${read.missing.join(' and its ')}`, read.different && `holds another value: ${read.different}`].filter(Boolean);
  if (parts.length) return ` (${parts.join('; ')})`;
  if (read.found) return ` (${read.found} row(s) of it)`;
  return '';
}

/**
 * One pair's result: { outcome: 'pass' | 'fail', text }. A pair holds when
 * both reads showed what it waits for within its bound. A pair that waits for
 * the report's absence keeps reading until its bound has passed, and reads
 * once more after that (`pair.confirm`): a report seen back in the layer at
 * any of those readings (`pair.reappeared`, or the confirmation) fails it,
 * and so does a confirmation that could not be read, since the absence is
 * then not known to the end of the bound. A report that was never written
 * fails every pair of it.
 */
export function pairOutcome(pair, { boundMs }) {
  const { record, kind } = pair;
  const { layer, want } = PAIR_KINDS[kind];
  const layerName = LAYER_NAMES[layer];
  const what = `${describe(record)} at ${pair.node.label}`;
  if (record.error) return { outcome: 'fail', text: `${what}: not written, ${record.error}` };
  const after = pair.fromWhat ?? 'share';
  const bound = secs(pair.boundMs ?? boundMs);
  const { view, partitions } = pair.progress;
  const names = { view: viewName(layer, record.sub), partitions: 'the cross-partition read' };
  // A report that must stay in the layer fails at the first reading that missed it, whatever came after.
  // A reading that broke the pair, at its moment (`at`), from the anchor of the pair's bound.
  const ageOf = violation => Math.max(0, violation.at - pair.from);
  if (pair.lapsed) {
    const { read, seen } = pair.lapsed;
    return { outcome: 'fail', text: `${what}: MISSING from ${names[read]}${readDetail(seen)} ${secs(ageOf(pair.lapsed))} s after the ${after}, though it must stay in ${layerName}` };
  }
  if (pairHeld(pair.progress)) {
    const at = secs(Math.max(view, partitions));
    if (want === 'gone') {
      const first = kind === 'gone' ? `left ${layerName} ${at} s after the ${after}` : `absent from ${layerName} ${at} s after the ${after}`;
      if (pair.reappeared) {
        const { read, seen } = pair.reappeared;
        return { outcome: 'fail', text: `${what}: ${first}, then was in ${names[read]}${readDetail(seen)} again ${secs(ageOf(pair.reappeared))} s after it` };
      }
      const back = ['view', 'partitions'].filter(read => pair.confirm?.[read]?.satisfied === false && !pair.confirm[read].error);
      if (back.length) {
        return { outcome: 'fail', text: `${what}: ${first}, then was in ${back.map(read => `${names[read]}${readDetail(pair.confirm[read])}`).join(' and in ')} again when the ${bound} s had passed` };
      }
      const unknown = ['view', 'partitions'].filter(read => pair.confirm?.[read]?.satisfied !== true);
      if (unknown.length) {
        return { outcome: 'fail', text: `${what}: ${first}, but ${unknown.map(read => `${names[read]}${readDetail(pair.confirm?.[read])}`).join(' and ')} could not be read when the ${bound} s had passed, so the absence to the end is not known` };
      }
      return { outcome: 'pass', text: `${what}: ${first}, and out of it to the end of the ${bound} s` };
    }
    if (PAIR_KINDS[kind].throughout) {
      const missing = ['view', 'partitions'].filter(read => pair.confirm?.[read]?.satisfied === false && !pair.confirm[read].error);
      if (missing.length) {
        return { outcome: 'fail', text: `${what}: in ${layerName} at every reading, then MISSING from ${missing.map(read => `${names[read]}${readDetail(pair.confirm[read])}`).join(' and from ')} when the ${bound} s had passed` };
      }
      const unknown = ['view', 'partitions'].filter(read => pair.confirm?.[read]?.satisfied !== true);
      if (unknown.length) {
        return { outcome: 'fail', text: `${what}: in ${layerName} at every reading, but ${unknown.map(read => `${names[read]}${readDetail(pair.confirm?.[read])}`).join(' and ')} could not be read when the ${bound} s had passed, so its stay to the end is not known` };
      }
      return { outcome: 'pass', text: `${what}: in ${layerName} at every reading from the ${after} to the end of the ${bound} s` };
    }
    return { outcome: 'pass', text: `${what}: in ${layerName} ${at} s after the ${after}` };
  }
  const missing = ['view', 'partitions'].filter(read => pair.progress[read] === null).map(read => `${names[read]}${readDetail(pair.last?.[read])}`);
  const found = [view !== null && `the view after ${secs(view)} s`, partitions !== null && `the cross-partition read after ${secs(partitions)} s`].filter(Boolean);
  const shown = found.length ? ` (${want === 'gone' ? 'absent from' : 'shown by'} ${found.join(', ')})` : '';
  if (want === 'gone') return { outcome: 'fail', text: `${what}: ${kind === 'gone' ? 'STILL' : 'FOUND'} in ${missing.join(' and in ')} ${bound} s after the ${after}${shown}` };
  return { outcome: 'fail', text: `${what}: NOT in ${layerName}: not in ${missing.join(' nor in ')} ${bound} s after the ${after}${shown}` };
}

/**
 * The curator's promotion of a report another node authored (POST
 * /api/knowledge-assets/:name/vm/publish with `selectedAuthorAgentAddress`):
 * { ok: true, ual, txHash } once the publish was confirmed on chain and the
 * answer names the report's author as the one whose seal was published, else
 * { ok: false, why }; an answer that names no author is no evidence of it. A confirmed publish whose binding to
 * the context graph failed (HTTP 207) is not a promotion of the report into
 * the graph's Verified Memory.
 */
export function promotionOutcome(answer, { authorAddress }) {
  const json = answer?.json ?? {};
  if (answer?.status !== 200 || json.status !== 'confirmed') return { ok: false, why: brief(answer) };
  if (!json.ual && json.kaId === undefined) return { ok: false, why: `confirmed without a UAL or an asset id: ${brief(answer)}` };
  const sealedBy = typeof json.authorAddress === 'string' && json.authorAddress ? json.authorAddress : null;
  if (!sealedBy) return { ok: false, why: `confirmed without the address of the author whose seal was published: ${brief(answer)}` };
  if (sealedBy.toLowerCase() !== String(authorAddress).toLowerCase()) {
    return { ok: false, why: `published under the seal of ${sealedBy}, not of its author ${authorAddress}` };
  }
  return { ok: true, ual: json.ual ?? null, txHash: json.txHash ?? null };
}

// The chain's publisher authorization for a curated graph, as the chain
// adapter words its refusal (contextGraphs.isAuthorizedPublisher answered
// false); the refusal carries no code.
const PUBLISH_DENIAL = /is not authorized to publish to context graph/;

/**
 * A member's publish of its own report in a graph whose publish policy is
 * curated: { verdict, why }. 'refused' only with evidence of the policy's
 * refusal (the chain's publisher authorization); 'published' for a confirmed
 * publish, whatever its HTTP status; 'unexercised' for any other answer (a
 * transport failure, a chain RPC outage, a missing share), which says nothing
 * about the policy.
 */
export function memberPublishOutcome(answer) {
  const json = answer?.json ?? {};
  if (json.status === 'confirmed') return { verdict: 'published', why: `confirmed on chain (${json.ual ?? json.kaId ?? 'no id'}): ${brief(answer)}` };
  const why = ([json.code, json.error].filter(Boolean).join(': ') || brief(answer)).slice(0, 240);
  const said = typeof json.error === 'string' ? json.error : String(answer?.text ?? '');
  return { verdict: PUBLISH_DENIAL.test(said) ? 'refused' : 'unexercised', why };
}

/**
 * The refusal codes of a report's create that a client retries: the node
 * knows the graph but has not synced it for writes yet, or could not validate
 * the graph for a moment (HTTP 503).
 */
export const RETRYABLE_WRITE_CODES = Object.freeze([
  'CONTEXT_GRAPH_NOT_WRITABLE', 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE', 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
]);
/** Whether a write's outcome ({ error, code } when refused) is a refusal a client retries. */
export const writeRetryable = outcome => Boolean(outcome?.error) && RETRYABLE_WRITE_CODES.includes(outcome.code);

/**
 * The topology every conclusion rests on, from one reading of each Edge's
 * connections (`observations`: node number -> { readable, connections }).
 * Edges reach each other through relays only: a connection between two of
 * them that is not relayed is a problem. Each Edge holds a connection to at
 * least one Core (it reaches the network, as an Edge behind NAT does through
 * the public nodes), and none to a peer outside the devnet (`known`), which
 * could carry the graph. Returns { problems, relayedPairs }, the pairs of
 * Edges linked through a relay.
 */
export function edgeTopologyProblems({ observations, edges, corePeers, known }) {
  const problems = [];
  const relayed = new Set();
  const byPeer = new Map(edges.filter(edge => edge.peerId).map(edge => [edge.peerId, edge]));
  for (const edge of edges) {
    const seen = observations.get(edge.number);
    if (!seen?.readable) {
      problems.push(`the connections of ${edge.label} could not be read`);
      continue;
    }
    const direct = new Set();
    for (const connection of seen.connections) {
      const other = byPeer.get(connection.peerId);
      if (!other || other === edge) continue;
      if (connection.transport === 'relayed') relayed.add([edge.label, other.label].sort().join(' and '));
      else direct.add(other.label);
    }
    for (const label of direct) problems.push(`${edge.label} holds a direct connection to ${label}`);
    if (!seen.connections.some(connection => corePeers.has(connection.peerId))) problems.push(`${edge.label} holds no connection to a Core`);
    const strangers = [...new Set(seen.connections.map(c => c.peerId).filter(id => typeof id === 'string' && !known.has(id)))];
    if (strangers.length) problems.push(`${edge.label} is connected to ${strangers.length} peer(s) that are no node of this devnet (${strangers.map(id => id.slice(-8)).join(', ')})`);
  }
  return { problems, relayedPairs: [...relayed].sort() };
}

/**
 * What an Edge's own status (GET /api/status) says of the profile's switches,
 * resolved as the node honours them (environment, then config): the periodic
 * peer reconciler off, chain-driven VM reconciliation on. Returns the
 * problems, or none.
 */
export function profileStatusProblems(status) {
  const lifecycle = status?.syncLifecycle;
  if (!lifecycle || typeof lifecycle !== 'object') return ['its status reports no sync switches'];
  const problems = [];
  if (lifecycle.syncReconcilerEnabled !== false) problems.push(`its peer reconciler is ${lifecycle.syncReconcilerEnabled === true ? 'on' : 'unknown'}, not off`);
  if (lifecycle.vmReconcilerEnabled !== true) problems.push(`its VM reconciliation is ${lifecycle.vmReconcilerEnabled === false ? 'off' : 'unknown'}, not on`);
  return problems;
}

/**
 * Every admission to a node's global sync slots that its log names, oldest
 * first: { at (local clock, the second of its log line), ctx (the operation
 * the line belongs to), label, reserved (it holds a reserved shared-memory
 * slot, not a general one), limit and queueLimit (the general pool's, as the
 * line prints them) }.
 */
export function parseAdmissions(logText) {
  const marker = 'Sync backpressure running ';
  const admissions = [];
  for (const line of String(logText ?? '').split('\n')) {
    const at = line.indexOf(marker);
    if (at === -1) continue;
    const head = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \S+ (\S+) /.exec(line);
    if (!head) continue;
    const rest = line.slice(at + marker.length);
    const label = rest.split(' ', 1)[0];
    const policy = /global inflight=\d+\/(\d+), queued=\d+\/(\d+)/.exec(rest);
    admissions.push({
      at: new Date(`${head[1]}T${head[2]}`).getTime(),
      ctx: head[3],
      label,
      reserved: rest.slice(label.length).startsWith(' in a reserved shared-memory slot'),
      limit: policy ? Number(policy[1]) : null,
      queueLimit: policy ? Number(policy[2]) : null,
    });
  }
  return admissions;
}

/** How many lines of a node log carry `marker` and were written within [from, until]; a line counts with its whole second. */
export function countLogLines(logText, marker, { from, until }) {
  let count = 0;
  for (const line of String(logText ?? '').split('\n')) {
    if (!line.includes(marker)) continue;
    const head = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) /.exec(line);
    if (!head) continue;
    const at = new Date(`${head[1]}T${head[2]}`).getTime();
    if (at + 999 >= from && at <= until) count += 1;
  }
  return count;
}

/** Whether an admission line shows the profile's sync policy: one general slot, no queue. Returns the problem, or null. */
export function admissionPolicyProblem(admission) {
  if (!admission || admission.limit === null || admission.limit === undefined) return 'its log names no sync policy';
  if (admission.limit !== 1) return `it runs ${admission.limit} general sync slot(s), not one`;
  if (admission.queueLimit !== 0) return `it queues up to ${admission.queueLimit} sync job(s), not none`;
  return null;
}

// A node writes an admission's log line as soon as the admission starts; this
// allows for a busy event loop between the two.
const LOG_LAG_MS = 250;
// A reading dates the running work only when its answer came this soon.
const DATING_LATENCY_MS = 250;
// What held the slot when a report arrived is read from the first reading
// taken at or after that moment, when it came this soon.
const RECEIPT_READING_MS = 2000;

const isDurable = operation => typeof operation?.operation === 'string' && operation.operation.split(':', 1)[0] === 'durable'
  && Number.isFinite(operation.oldestAgeMs);
const overlaps = (a, b) => a.from <= b.to && b.from <= a.to;
const lineTime = line => {
  const head = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \S+ (\S+) /.exec(line);
  return head ? { at: new Date(`${head[1]}T${head[2]}`).getTime(), ctx: head[3] } : null;
};

/**
 * When the durable work a reading of the node's `sync-global` scheduler shows
 * started: { from, to } on the local clock, or null when it shows none. A
 * reading is { sentAt, at, operations: [{ operation, oldestAgeMs }] } (the
 * running operations of every lane) or { at, unreadable }. Durable work (a
 * Verified Memory transfer is `durable:<graph>:<peer>`) never takes a
 * reserved shared-memory slot, so under one general slot there is at most one.
 */
export function durableStart(reading) {
  if (!reading || reading.unreadable || !Number.isFinite(reading.at)) return null;
  const durable = (Array.isArray(reading.operations) ? reading.operations : []).filter(isDurable);
  if (durable.length === 0) return null;
  const age = Math.max(...durable.map(operation => operation.oldestAgeMs));
  const sentAt = Number.isFinite(reading.sentAt) ? reading.sentAt : reading.at;
  return { from: sentAt - age - 1, to: reading.at - age, age };
}

/**
 * What one reading shows in the node's general sync slot: { state:
 * 'transfer', admission } when it shows durable work that started when a
 * general-slot admission of the large transfer did (`isTransfer`, by label)
 * and no other durable admission started then; 'other' (durable work of
 * another admission, or none); 'unclear' (the answer came too slowly to date
 * the work, or the log names no admission, or several, that it can be); or
 * 'unreadable'.
 */
export function slotHolder(reading, admissions, isTransfer) {
  if (!reading || reading.unreadable) return { state: 'unreadable' };
  const start = durableStart(reading);
  if (!start) return { state: 'other' };
  if (start.to - start.from > DATING_LATENCY_MS) return { state: 'unclear' };
  const candidates = admissions.filter(admission => !admission.reserved && admission.label.startsWith('durable:')
    && overlaps(start, { from: admission.at - LOG_LAG_MS, to: admission.at + 999 }));
  if (candidates.length === 0) return { state: 'unclear' };
  if (!candidates.some(isTransfer)) return { state: 'other', admission: candidates[0] };
  if (!candidates.every(isTransfer)) return { state: 'unclear' };
  return { state: 'transfer', admission: candidates[0], candidates, start };
}

/**
 * The large transfer's life on the node: from its first general-slot
 * admission to the last evidence that it was still at work, the last line of
 * any operation that ran one of its admissions (each line counts with its
 * whole second) or, for an admission at work quietly, the last reading
 * (`readings`, when it was sent) that shows it in the slot. A transfer of
 * many assets is many short admissions, one or a few assets each, so the
 * slot is free for moments within that life. Returns { from, to, admissions }
 * or null.
 */
export function transferLifetime(logText, admissions, isTransfer, readings = []) {
  const own = admissions.filter(admission => !admission.reserved && isTransfer(admission));
  if (own.length === 0) return null;
  const operations = new Set(own.map(admission => admission.ctx));
  let to = own.at(-1).at + 999;
  for (const line of String(logText ?? '').split('\n')) {
    const time = lineTime(line);
    if (time && operations.has(time.ctx)) to = Math.max(to, time.at + 999);
  }
  for (const reading of readings) {
    if (slotHolder(reading, admissions, isTransfer).state === 'transfer') to = Math.max(to, Number.isFinite(reading.sentAt) ? reading.sentAt : reading.at);
  }
  return { from: own[0].at, to, admissions: own.length };
}

/**
 * When a report reached a node, as far as the node's reads can date it:
 * `dating` keeps, for each read, when the last read that did not find what
 * it waits for was sent (`lastMissSentAt`; a read is answered as of some
 * moment after it was sent, so the report came after that) and when the
 * first read that found it was sent and completed (`hit`; the report was
 * there by its completion). The arrival lies in the window (after, by]:
 * `by` is the earliest completion of a read that found it; `after` the
 * earliest of the reads' last misses, so that one read that lags the other
 * cannot move the window past the arrival. `after` is null when a read found
 * it at its first try, with no miss before. Returns { after, by } or null
 * when no read found it.
 */
export function arrivalWindow(dating) {
  const reads = Object.values(dating ?? {}).filter(read => read?.hit && Number.isFinite(read.hit.completedAt));
  if (reads.length === 0) return null;
  const by = Math.min(...reads.map(read => read.hit.completedAt));
  const after = reads.every(read => Number.isFinite(read.lastMissSentAt)) ? Math.min(...reads.map(read => read.lastMissSentAt)) : null;
  return { after, by };
}

/**
 * Whether the large transfer held the node's only general slot throughout
 * the window in which a report arrived (arrivalWindow: after the moment
 * `after`, by the moment `by`): the first reading taken at or after `by`
 * (and soon enough) shows the transfer, and dates the start of the running
 * admission before `after` (the latest start the reading allows, not the log
 * second of any one candidate: when several of the transfer's admissions
 * match, the running one may be a later one). One admission holds its slot
 * without a break, so it held it at every moment the report could have
 * arrived. A query's completion is not the arrival: a report that came in a
 * free moment and was read only once an admission had started is not
 * evidence. Returns { held, why }.
 */
export function transferHeldThrough(window, readings, admissions, isTransfer) {
  if (!window) return { held: false, why: 'its arrival was never dated' };
  if (!Number.isFinite(window.after)) return { held: false, why: 'its arrival could not be dated: no read found it missing before it was there' };
  const after = readings.filter(reading => (Number.isFinite(reading.sentAt) ? reading.sentAt : reading.at) >= window.by).sort((a, b) => a.at - b.at)[0];
  if (!after || after.at - window.by > RECEIPT_READING_MS) return { held: false, why: 'no reading of the slot right after it' };
  const { state, start } = slotHolder(after, admissions, isTransfer);
  if (state !== 'transfer') {
    return { held: false, why: { other: 'the slot held other work or none', unclear: 'the reading after it could not tell which work held the slot', unreadable: 'the slot could not be read' }[state] };
  }
  if (start.to >= window.after) return { held: false, why: `the transfer's admission in the slot may have started after the report arrived (its arrival is dated to the ${window.by - window.after} ms before a read found it)` };
  return { held: true, why: null };
}

/** How many readings within [from, until] show the transfer in the general slot: { transfer, total }. */
export function transferOccupancy({ readings, admissions, isTransfer, from, until }) {
  const window = readings.filter(reading => reading.at >= from && reading.at <= until);
  return { transfer: window.filter(reading => slotHolder(reading, admissions, isTransfer).state === 'transfer').length, total: window.length };
}

/**
 * Whether the transfer held the node's general slot at some moment between
 * `since` (the promotion) and `until` (the last moment the delivery was
 * surely not done: the `after` of its arrivalWindow): a reading sent after
 * `since` and answered before `until` shows it there. A reading that ran
 * past `until` may show the slot after the delivery, and does not count. A
 * promotion's Verified Memory reaches a node through the node's own sync
 * work, which needs that slot, so its receipt never lands under a transfer
 * admission; what shows the busy slot is that the delivery had to contend
 * with the transfer for it. Returns { held, why }.
 */
export function transferContended(since, until, readings, admissions, isTransfer) {
  if (!Number.isFinite(until)) return { held: false, why: 'the delivery could not be dated: no read found it missing before it was there' };
  const window = readings.filter(reading => (Number.isFinite(reading.sentAt) ? reading.sentAt : reading.at) >= since && reading.at <= until);
  if (window.some(reading => slotHolder(reading, admissions, isTransfer).state === 'transfer')) return { held: true, why: null };
  return { held: false, why: window.length ? `none of the ${window.length} reading(s) between them shows the transfer in the slot` : 'no reading was taken between them' };
}

/**
 * A promotion's delivery to the busy Edge, as busyReceiptOutcome takes it:
 * through the Edge's own sync work, which had to contend with the transfer
 * for the slot (`contended`, transferContended), or while an admission of
 * the transfer held the slot throughout the delivery's window (`through`,
 * transferHeldThrough; a delivery the Edge finalized locally from gossip
 * needs no slot, and may land before the promotion is even answered). Either
 * is evidence; without both, the reasons of both. Returns { held, why, how }.
 */
export function deliveryEvidence(contended, through) {
  if (contended?.held) return { held: true, why: null, how: 'contended' };
  if (through?.held) return { held: true, why: null, how: 'through' };
  return { held: false, why: `${contended?.why ?? 'no reading'}; nor throughout its arrival: ${through?.why ?? 'no reading'}`, how: null };
}

/**
 * The busy Edge's check of one receipt: its pair result (pairOutcome), the
 * latest moment the report can have reached the Edge (`received`, the `by`
 * of its arrivalWindow), the transfer's life (transferLifetime), and the
 * slot evidence `held`: for a report, whether an admission of the transfer
 * held the general slot throughout the window of its arrival
 * (transferHeldThrough); for a promotion (`delivery`), deliveryEvidence,
 * whose `how` says which proof held. It passes only with that evidence and a
 * receipt within the transfer's life. A receipt after the transfer ended,
 * one without that evidence, or one whose readings cannot be placed leaves
 * the case not exercised and fails. A result that failed, or a pair that was
 * never received, is returned as it is.
 */
export function busyReceiptOutcome(result, { received, life, held, delivery = false }) {
  if (result.outcome !== 'pass' || received === null || received === undefined) return result;
  if (!life || received > life.to) return { outcome: 'fail', text: `${result.text}; not exercised: the transfer of the large graph had ended by then` };
  if (!held?.held) {
    const missing = delivery ? 'the transfer never held the general slot between the promotion and the delivery' : 'no reading shows the transfer holding the general slot throughout the moments the report can have arrived';
    return { outcome: 'fail', text: `${result.text}; not exercised: ${missing} (${held?.why ?? 'no reading'})` };
  }
  const how = delivery && held.how !== 'through' ? 'after contending with the transfer for the general slot' : 'while an admission of the transfer held the general slot';
  return { outcome: 'pass', text: `${result.text}, ${how}` };
}

/**
 * A subscriber's write into the graph's sub-graph before it registers the
 * sub-graph itself, as a check with the evidence known gap #3293 takes:
 * `record` is the report (written, or refused with `error` and its
 * structured `refusal`), `listed` whether the writer's listing named the
 * sub-graph, and the writer held the definition. The evidence is the
 * refusal's own: the create's HTTP status, and the server's error, whose
 * wording is all that names the unregistered sub-graph (it carries no code),
 * never the message the suite prints.
 */
export function subGraphWriteResult({ node, graph, record, listed }) {
  const evidence = { definitionHeld: true, subGraphListed: listed };
  const where = `${graph.key}/${record.sub}`;
  if (!record.error) {
    const learned = listed ? ' (its listing already named it)' : '';
    return { check: 'sub-graph-write', outcome: 'pass', text: `${node.label} wrote into ${where} before registering the sub-graph itself${learned}`, evidence };
  }
  const refusal = record.refusal ?? {};
  return {
    check: 'sub-graph-write',
    outcome: 'fail',
    text: `${node.label} could not write into ${where} before registering the sub-graph itself (${listed ? 'its listing names it' : 'its listing does not name it'}): ${record.error}`,
    evidence: {
      ...evidence,
      httpStatus: refusal.phase === 'create' && Number.isInteger(refusal.status) ? refusal.status : null,
      unregisteredSubGraph: refusal.phase === 'create' && /has not been registered in context graph/.test(String(refusal.error ?? '')),
    },
  };
}

/**
 * The curator's promotion of a report as a check, with the evidence known gap
 * #3294 takes: `outcome` from promotionOutcome, `answer` the route's answer,
 * and `heldByCurator` whether the curator held the report in its shared
 * memory before the promotion. A report the curator authored is its own
 * promotion (`curator-promotion`); another Edge's is `member-promotion`.
 */
export function promotionResult({ record, curator, outcome, answer, heldByCurator }) {
  const authorIsCurator = record.author === curator;
  return {
    check: authorIsCurator ? 'curator-promotion' : 'member-promotion',
    outcome: outcome.ok ? 'pass' : 'fail',
    text: outcome.ok ? `the curator promoted ${describe(record)}: ${outcome.ual ?? 'no UAL'}` : `the curator could not promote ${describe(record)}: ${outcome.why}`,
    evidence: { authorIsCurator, heldByCurator: heldByCurator === true, code: answer?.json?.code, httpStatus: answer?.status },
  };
}

/**
 * Case 5's check of an author that shares again after its report was
 * promoted. It runs only when the author's report was promoted (`promoted`);
 * otherwise the check is not exercised and fails, with the evidence of the
 * promotion's refusal (`promotion`, the promotion check's result), so that a
 * refusal of known gap #3294 is reported as that gap. Returns null when the
 * check runs, else its result.
 */
export function postPromotionCheck({ author, report, promoted, promotion }) {
  if (promoted) return null;
  const why = !report || report.error ? 'its report was never written' : promotion ? 'its report was never promoted' : 'no promotion of its report was attempted';
  return {
    check: 'post-promotion-share',
    outcome: 'fail',
    text: `${author.label}: not exercised: ${why}, so no share of it follows a promotion${promotion?.text ? ` (${promotion.text})` : ''}`,
    evidence: promotion?.evidence ?? { authorIsCurator: false, heldByCurator: false },
  };
}

/**
 * Whether a node held a graph's definition in time: `seen` is the last
 * listing a poll made ({ ok: whether it showed the definition, completedAt:
 * when it completed }), `from` the subscribe and `boundMs` the deadline. A
 * listing that showed the definition only after the deadline does not count:
 * the deadline is the node's, not the poll's. Returns { held, late (it
 * showed the definition, but past the deadline), afterMs (when that listing
 * completed, from `from`) }.
 */
export function definitionInTime(seen, { from, boundMs }) {
  const afterMs = Number.isFinite(seen?.completedAt) ? seen.completedAt - from : null;
  const showed = seen?.ok === true && afterMs !== null;
  return { held: showed && afterMs <= boundMs, late: showed && afterMs > boundMs, afterMs };
}

/**
 * Whether a node already held a graph's reports when its last subscribe was
 * accepted, before that subscribe's catch-up could insert anything: every
 * pair of `pairs` (a watch timed from the subscribe, `pair.from`) held, and
 * each of its reads showed what the pair waits for at its first try, which
 * completed within `withinMs` of the subscribe. A read that was sent at once
 * but answered late may have seen reports that arrived meanwhile, so it is no
 * evidence. False for no pairs.
 */
export function heldAtSubscribe(pairs, { withinMs = 2000 } = {}) {
  if (!Array.isArray(pairs) || pairs.length === 0) return false;
  return pairs.every(pair => pairHeld(pair.progress ?? {}) && Object.values(pair.dating ?? {}).length > 0
    && Object.values(pair.dating).every(read => read.lastMissSentAt === null && read.hit && read.hit.completedAt - pair.from <= withinMs));
}

const operationOf = line => /^(?:\[[^\]]+\]|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \S+ (\S+) /.exec(line)?.[1] ?? '';

/**
 * What a node's log says its shared-memory catch-up of a graph inserted
 * after its last subscribe (`[subscribe] contextGraph=<graph> …`), every
 * kind of data the node counts as inserted: a round's data triples (`SWM
 * sync for "<graph>": N data + M meta triples`, or `SWM recovery for
 * "<graph>" from <peer>: … N data + M meta triples`), and the triples of the
 * graph-scoped snapshots it materialized. A round logs each snapshot
 * (`materialized snapshot <ref> as <graph> (N triples)`) and then, unless it
 * failed first, their sum (`materialized K graph-scoped KA snapshot(s)
 * totalling N triples`); a round's snapshots count once, the larger of the
 * two. Returns { passes (the rounds that logged their data and meta
 * triples), data }, or null when the log shows no subscribe of the graph.
 */
export function catchupDataTriples(logText, graphId) {
  const text = String(logText ?? '');
  const at = text.lastIndexOf(`[subscribe] contextGraph=${graphId} `);
  if (at < 0) return null;
  const sync = `SWM sync for "${graphId}": `;
  const recovery = `SWM recovery for "${graphId}" from `;
  let passes = 0;
  let data = 0;
  const snapshots = new Map();
  const ofRound = line => {
    const operation = operationOf(line);
    if (!snapshots.has(operation)) snapshots.set(operation, { each: 0, total: 0 });
    return snapshots.get(operation);
  };
  for (const line of text.slice(at).split('\n')) {
    const inSync = line.indexOf(sync);
    if (inSync >= 0) {
      const rest = line.slice(inSync + sync.length);
      const round = /^(\d+) data \+ \d+ meta triples/.exec(rest);
      const total = /^materialized \d+ graph-scoped KA snapshot\(s\) totalling (\d+) triples/.exec(rest);
      const each = /^materialized snapshot \S+ as \S+ \((\d+) triples\)/.exec(rest);
      if (round) {
        passes += 1;
        data += Number(round[1]);
      } else if (total) ofRound(line).total += Number(total[1]);
      else if (each) ofRound(line).each += Number(each[1]);
      continue;
    }
    const inRecovery = line.indexOf(recovery);
    const recovered = inRecovery >= 0 ? /: replaced \d+ roots, \d+ exact graphs, (\d+) data \+ \d+ meta triples/.exec(line.slice(inRecovery)) : null;
    if (recovered) {
      passes += 1;
      data += Number(recovered[1]);
    }
  }
  for (const { each, total } of snapshots.values()) data += Math.max(each, total);
  return { passes, data };
}

/**
 * A subscriber's synced flag within its deadline after the client remedy's
 * subscribe (with forceCatchup, at `from`), as a check with the evidence
 * known gap #3296 takes: `seen` is the last listing a poll made from that
 * subscribe ({ ok: it showed the graph synced, listed (listingEntry),
 * completedAt }), `boundMs` the deadline, `everSynced` whether any listing
 * before that subscribe showed the graph synced, and `heldAtSubscribe` and
 * `catchup` as for syncedAtEndResult. A flag that showed only after the
 * deadline fails, however slowly the listing answered.
 */
export function syncedAfterRemedyResult({ node, graph, seen, from, boundMs, everSynced, heldAtSubscribe: held, catchup }) {
  const check = 'synced-after-remedy';
  const listed = seen?.listed;
  const bound = secs(boundMs);
  if (!listed?.readable) {
    return { check, outcome: 'fail', text: `${node.label}: its listing could not be read in the ${bound} s after it subscribed to ${graph.key} again with forceCatchup (${listed?.why ?? 'no answer'})`, evidence: { readable: false } };
  }
  const { entry } = listed;
  const afterMs = Number.isFinite(seen.completedAt) ? seen.completedAt - from : null;
  const evidence = {
    readable: true, subscribed: entry?.subscribed === true, synced: entry?.synced === true, definitionHeld: listed.defined === true,
    everSynced, heldAtSubscribe: held === true, catchupPasses: catchup?.passes ?? 0, catchupDataTriples: catchup ? catchup.data : null,
  };
  if (evidence.synced && afterMs !== null && afterMs <= boundMs) {
    return { check, outcome: 'pass', text: `${node.label}: lists ${graph.key} as synced ${secs(afterMs)} s after it subscribed again with forceCatchup`, evidence };
  }
  if (evidence.synced) {
    return { check, outcome: 'fail', text: `${node.label}: lists ${graph.key} as synced only ${secs(afterMs)} s after it subscribed again with forceCatchup, past the ${bound} s`, evidence };
  }
  return { check, outcome: 'fail', text: `${node.label}: lists ${graph.key} as ${entry ? `subscribed=${entry.subscribed} synced=${entry.synced}` : 'absent'} ${bound} s after it subscribed again with forceCatchup`, evidence };
}

/**
 * A node's synced flag for a graph at the end of the run, as a check with the
 * evidence known gap #3296 takes: `listed` is the node's listing entry
 * (listingEntry), `heldAtSubscribe` whether the node already held the
 * graph's reports when its last subscribe was accepted (heldAtSubscribe; only
 * a node watched from that moment has it), `everSynced` whether any earlier
 * listing of it showed the graph synced (a flag lost after it held is no
 * flag that never came), and `catchup` what its log says its catch-up
 * inserted after that subscribe (catchupDataTriples).
 */
export function syncedAtEndResult({ node, graph, listed, everSynced, heldAtSubscribe: held, catchup }) {
  const check = 'synced-at-end';
  if (!listed?.readable) return { check, outcome: 'fail', text: `${node.label}: its listing could not be read at the end (${listed?.why ?? 'no answer'})`, evidence: { readable: false } };
  const { entry } = listed;
  const evidence = {
    readable: true, subscribed: entry?.subscribed === true, synced: entry?.synced === true, definitionHeld: listed.defined === true,
    everSynced, heldAtSubscribe: held === true, catchupPasses: catchup?.passes ?? 0, catchupDataTriples: catchup ? catchup.data : null,
  };
  if (evidence.synced) return { check, outcome: 'pass', text: `${node.label}: lists ${graph.key} as synced at the end`, evidence };
  return { check, outcome: 'fail', text: `${node.label}: lists ${graph.key} as ${entry ? `subscribed=${entry.subscribed} synced=${entry.synced}` : 'absent'} at the end`, evidence };
}
