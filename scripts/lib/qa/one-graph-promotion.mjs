// The judgements of devnet-test-one-graph-promotion.mjs, kept apart from its
// devnet I/O so that each one is tested on its own: where a report is held
// (shared memory or Verified Memory) and when it has left shared memory, what
// a promotion and a member's own publish answered, the topology between the
// Edges, the profile an Edge runs, and the evidence that a large transfer
// held an Edge's only sync slot. The shared-memory reads reuse the judgements
// of member-sharing.mjs.

import { describe, pairHeld } from './member-sharing.mjs';

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

/** Whether rows of one subject hold nothing for the predicate: a report that has left a layer. */
export function judgeGone(rows, { predicate }) {
  const found = rows.filter(row => bare(cellText(row.p)) === predicate).length;
  return { gone: found === 0, found };
}

/**
 * What each kind of pair (a report, a node, what it must show) waits for, and
 * in which layer: `swm` the report in shared memory, `vm` in Verified Memory,
 * `gone` no longer in shared memory (it was promoted), `kept` still in shared
 * memory (another report was promoted), `unpublished` not in Verified Memory
 * (its publish was refused). A pair is read twice, with the layer's view and
 * with the cross-partition read, and holds once both showed it.
 */
export const PAIR_KINDS = Object.freeze({
  swm: { layer: 'swm', want: 'held' },
  vm: { layer: 'vm', want: 'held' },
  gone: { layer: 'swm', want: 'gone' },
  kept: { layer: 'swm', want: 'held' },
  unpublished: { layer: 'vm', want: 'gone' },
});
const LAYER_NAMES = { swm: 'shared memory', vm: 'Verified Memory' };

/**
 * One read of a pair, folded to what the pair waits for: { satisfied, error,
 * different, found }. `seen` is { held, different } for a held kind (from
 * judgeHeld) and { gone, found } for `gone`, or { error } when the read
 * failed: a failed read satisfies nothing, not even `gone`.
 */
export function readOutcome(kind, seen) {
  if (!PAIR_KINDS[kind]) throw new Error(`unknown pair kind ${kind}`);
  if (seen?.error) return { satisfied: false, error: seen.error };
  if (PAIR_KINDS[kind].want === 'gone') return { satisfied: seen?.gone === true, found: seen?.found ?? 0 };
  return { satisfied: seen?.held === true, ...(seen?.different ? { different: seen.different } : {}) };
}

const viewName = (layer, sub) => `the ${layer === 'vm' ? 'verifiable-memory' : 'shared-working-memory'} view${sub ? ` of ${sub}` : ''}`;
function readDetail(read) {
  if (!read) return ' (never read)';
  if (read.error) return ` (${read.error})`;
  if (read.different) return ` (holds another value: ${read.different})`;
  if (read.found) return ` (${read.found} row(s) of it)`;
  return '';
}

/**
 * One pair's result: { outcome: 'pass' | 'fail', text }. A pair holds when
 * both reads showed what it waits for within its bound. A pair that waits for
 * the report's absence and held must still hold when its bound has passed
 * (`pair.confirm`, one more reading of each read): a report back in the layer
 * fails; a reading that failed tells nothing. A report that was never written
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
  if (pairHeld(pair.progress)) {
    const at = secs(Math.max(view, partitions));
    if (want === 'gone') {
      const back = ['view', 'partitions'].filter(read => pair.confirm?.[read]?.satisfied === false && !pair.confirm[read].error);
      const absent = kind === 'gone' ? `left ${layerName} ${at} s after the ${after}` : `not in ${layerName} ${bound} s after the ${after}`;
      if (back.length) {
        return { outcome: 'fail', text: `${what}: ${absent}, but then in ${back.map(read => `${names[read]}${readDetail(pair.confirm[read])}`).join(' and in ')} within the bound` };
      }
      return { outcome: 'pass', text: `${what}: ${absent}` };
    }
    return { outcome: 'pass', text: `${what}: in ${layerName} ${at} s after the ${after}` };
  }
  const missing = ['view', 'partitions'].filter(read => pair.progress[read] === null).map(read => `${names[read]}${readDetail(pair.last?.[read])}`);
  const found = [view !== null && `the view after ${secs(view)} s`, partitions !== null && `the cross-partition read after ${secs(partitions)} s`].filter(Boolean);
  const shown = found.length ? ` (${want === 'gone' ? 'absent from' : 'shown by'} ${found.join(', ')})` : '';
  if (want === 'gone') return { outcome: 'fail', text: `${what}: STILL in ${missing.join(' and in ')} ${bound} s after the ${after}${shown}` };
  return { outcome: 'fail', text: `${what}: NOT in ${layerName}: not in ${missing.join(' nor in ')} ${bound} s after the ${after}${shown}` };
}

/**
 * The curator's promotion of a report another node authored (POST
 * /api/knowledge-assets/:name/vm/publish with `selectedAuthorAgentAddress`):
 * { ok: true, ual, txHash } once the publish was confirmed on chain under the
 * author's seal, else { ok: false, why }. A confirmed publish whose binding to
 * the context graph failed (HTTP 207) is not a promotion of the report into
 * the graph's Verified Memory.
 */
export function promotionOutcome(answer, { authorAddress }) {
  const json = answer?.json ?? {};
  if (answer?.status !== 200 || json.status !== 'confirmed') return { ok: false, why: brief(answer) };
  if (!json.ual && json.kaId === undefined) return { ok: false, why: `confirmed without a UAL or an asset id: ${brief(answer)}` };
  const sealedBy = typeof json.authorAddress === 'string' ? json.authorAddress : null;
  if (sealedBy && sealedBy.toLowerCase() !== String(authorAddress).toLowerCase()) {
    return { ok: false, why: `published under the seal of ${sealedBy}, not of its author ${authorAddress}` };
  }
  return { ok: true, ual: json.ual ?? null, txHash: json.txHash ?? null };
}

/**
 * A member's publish of its own report in a graph whose publish policy is
 * curated: it must not reach Verified Memory. { refused: true, why } for any
 * answer but a confirmed publish (the reason is reported, so that a refusal
 * for another cause than the policy shows), { refused: false, why } for a
 * confirmed one, whatever its HTTP status.
 */
export function memberPublishOutcome(answer) {
  const json = answer?.json ?? {};
  if (json.status === 'confirmed') return { refused: false, why: `confirmed on chain (${json.ual ?? json.kaId ?? 'no id'}): ${brief(answer)}` };
  return { refused: true, why: [json.code, json.error].filter(Boolean).join(': ').slice(0, 240) || brief(answer) };
}

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
// A reading identifies an admission only when its answer came this soon.
const IDENTIFYING_LATENCY_MS = 250;
// How far a later reading of the same admission can place its start from the
// identifying one (that reading's own latency, and clock drift in a window).
const SAME_START_MS = 250;
// A reading identifies an admission only once it has run this long, longer
// than two starts can be told apart: work admitted after it ended started
// later than that, so no reading of such work can pass for it.
const IDENTIFYING_AGE_MS = 1000;

const isDurable = operation => typeof operation?.operation === 'string' && operation.operation.split(':', 1)[0] === 'durable'
  && Number.isFinite(operation.oldestAgeMs);
const overlaps = (a, b) => a.from <= b.to && b.from <= a.to;

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
 * The large transfer in the slot, as one reading and the log can name it: the
 * reading shows durable work that has run long enough and came soon enough to
 * date its start, and the general-slot admissions of the log that can have
 * started then are all of the transfer (`isTransfer`, by label). Returns {
 * transfer: { from, to, label, ctx, limit, queueLimit } } or { why }.
 */
export function identifyTransfer(reading, admissions, isTransfer) {
  if (!reading) return { why: 'no reading of its sync slots yet' };
  if (reading.unreadable) return { why: `its sync slots could not be read (${reading.unreadable})` };
  const start = durableStart(reading);
  if (!start) return { why: 'no durable work held its general sync slot' };
  if (start.to - start.from > IDENTIFYING_LATENCY_MS) return { why: 'no reading came soon enough to date the running work' };
  if (start.age < IDENTIFYING_AGE_MS) return { why: `the running work had run for less than ${IDENTIFYING_AGE_MS / 1000} s` };
  const candidates = admissions.filter(admission => !admission.reserved && admission.label.startsWith('durable:')
    && overlaps(start, { from: admission.at - LOG_LAG_MS, to: admission.at + 999 }));
  if (candidates.length === 0) return { why: 'its log shows no durable admission that started when the running work did' };
  if (!candidates.some(isTransfer)) return { why: `its slot was held by other work (${candidates[0].label})` };
  if (!candidates.every(isTransfer)) return { why: 'its log cannot tell the transfer from other durable work admitted at about the same time' };
  const [admission] = candidates;
  return { transfer: { from: start.from, to: start.to, label: admission.label, ctx: admission.ctx, limit: admission.limit, queueLimit: admission.queueLimit } };
}

/**
 * Whether a later reading shows the identified transfer still running: 'same'
 * (durable work that started when it did), 'other' (other durable work, or
 * none), or 'unclear' (the answer came too slowly to tell).
 */
export function sameTransfer(reading, transfer) {
  const start = durableStart(reading);
  if (!start) return 'other';
  const window = { from: transfer.from - SAME_START_MS, to: transfer.to + SAME_START_MS };
  if (!overlaps(start, window)) return 'other';
  return start.from < window.from || start.to > window.to ? 'unclear' : 'same';
}

/**
 * How long the transfer held the node's only general sync slot from `from`,
 * the start of the window of the writes and their checks, and whether that
 * reached `until`, the window's end. `readings` are the node's slot readings,
 * also those taken after `until`. From the window's start each reading must
 * show the transfer (sameTransfer); one admission holds its slot without a
 * break, so between two such readings it held it throughout, and after the
 * last one nothing is known. The evidence ends at a reading of other work or
 * of none, at one that could not be read, and at a gap longer than `maxGapMs`;
 * a reading that came too slowly to tell proves nothing either way. Returns {
 * held, provenUntil (the earliest moment the last reading of the transfer can
 * have been taken), reason }.
 */
export function transferHeldThrough({ transfer, readings, from, until, maxGapMs = 5000 }) {
  if (!transfer) return { held: false, reason: 'no transfer of it was identified in a sync slot', provenUntil: null };
  const window = readings.filter(reading => reading.at >= from).sort((a, b) => a.at - b.at);
  let previous = from;
  let provenUntil = null;
  let slow = 0;
  const gap = (ms, last = '') => `no reading of the sync slot for ${last}${secs(ms)} s${slow ? ` (${slow} more came too slowly to tell)` : ''}`;
  const ended = reason => ({ held: false, reason, provenUntil });
  for (const reading of window) {
    if (reading.at - previous > maxGapMs) return ended(gap(reading.at - previous));
    if (reading.unreadable) return ended(`the sync slot could not be read (${reading.unreadable})`);
    const same = sameTransfer(reading, transfer);
    if (same === 'other') return ended(durableStart(reading) ? 'the slot was held by other durable work' : 'the transfer had left the slot');
    if (same === 'unclear') {
      slow += 1;
      continue;
    }
    previous = reading.at;
    provenUntil = Number.isFinite(reading.sentAt) ? reading.sentAt : reading.at;
    slow = 0;
    if (provenUntil >= until) return { held: true, provenUntil };
  }
  if (until - previous > maxGapMs) return ended(gap(until - previous, 'the last '));
  if (provenUntil === null) return ended(gap(until - from));
  return ended('no reading was taken at or after the end of the window');
}

/** Whether a report found at `receivedAt` arrived while the transfer still held the slot (`busy` from transferHeldThrough). */
export const receivedWhileHeld = (receivedAt, busy) => busy.provenUntil !== null && receivedAt <= busy.provenUntil;
