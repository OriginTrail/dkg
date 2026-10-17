// The observations of the issue-3251 member-sharing suite
// (scripts/devnet-test-issue-3251-member-sharing.mjs): writes made the way a
// client makes them, the two reads a client makes, the watches that read each
// pair (a write, a node that must hold it) within its bound, and the observer
// of a member's subscription. The judgements are in ../qa/member-sharing.mjs.

import { brief, sleep, waitFor } from './devnet.mjs';
import { foldRead, foldSubscription, freshSubscription, inScope, judgeHeld, listingObservation, pairHeld, sharedMemoryScope } from '../qa/member-sharing.mjs';
import { parseObservation } from '../qa/query-observation.mjs';

/**
 * `config` is { boundMs, definitionMs, syncedMs, stamp, predicate }: the bound
 * of a pair, the deadlines of a subscription, the run's stamp (in every
 * subject and asset name) and the predicate every write uses.
 */
export function createObservation(devnet, config) {
  const { api } = devnet;
  const { boundMs, definitionMs, syncedMs, stamp, predicate } = config;
  let sequence = 0;

  // Each node's history with each graph's definition: whether anything ever
  // showed the node holding it (its subscription's observer, a write the node
  // accepted, a refused write whose listing still showed it), or that its
  // observed subscription never did. Kept here, where those observations are
  // made; the report takes a snapshot of it when it judges a write.
  const definitions = new Map();
  const definitionKey = (node, graph) => `${typeof node === 'object' ? node.number : node}|${graph.id}`;
  const noteDefinition = (node, graph, seen) => {
    const key = definitionKey(node, graph);
    if (seen) definitions.set(key, true);
    else if (!definitions.has(key)) definitions.set(key, false);
  };
  /** Whether anything so far showed `node` holding `graph`'s definition: true, false (its observed subscription never did), or undefined. */
  const definitionSeen = (node, graph) => definitions.get(definitionKey(node, graph));

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

  /** A node's own listing entry for the graph; `defined` = it holds the definition. */
  async function listingEntry(node, graph) {
    const answer = await api(node, 'GET', '/api/context-graph/list');
    const seen = listingObservation(answer.status, answer.text, graph.id);
    return seen.readable ? seen : { readable: false, why: `${seen.reason}, ${brief(answer)}` };
  }

  /**
   * One asset with a subject of its own: the record the watches of the write
   * use. A refused write keeps the refusal's code and whether its author held
   * the graph's definition right after it. Either way the outcome goes into
   * the author's history with the definition: a write the node accepted was
   * made while the author held it.
   */
  async function write(author, graph, sub, what) {
    sequence += 1;
    const record = {
      author, graph, sub, what, sequence,
      subject: `urn:issue3251:${stamp}:${sequence}`,
      value: `${what} (${sequence})`,
      doneAt: null, error: null, errorCode: undefined, definitionHeld: undefined,
    };
    const outcome = await createAndShare(author, {
      contextGraphId: graph.id, name: `i3251-${stamp.toLowerCase()}-${sequence}`, subGraphName: sub,
      quads: [{ subject: record.subject, predicate, object: `"${record.value}"`, graph: '' }],
    }, { createTimeoutMs: 120_000, jobTimeoutMs: 120_000, pollMs: 1000 });
    if (!outcome.error) {
      record.doneAt = outcome.doneAt;
      noteDefinition(author, graph, true);
      return record;
    }
    record.error = outcome.error;
    record.errorCode = outcome.code;
    const listed = await listingEntry(author, graph);
    record.definitionHeld = listed.readable ? listed.defined : undefined;
    if (record.definitionHeld === true) noteDefinition(author, graph, true);
    return record;
  }

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
  const written = record => ({ predicate, value: record.value });

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
   * Starts watching pairs (write, node that must hold it) at once: each read
   * of each pair polls on its own until it finds the write, the pair's bound
   * has passed, or the watch is cancelled. Call it when the bound starts
   * (right after the write, the subscribe, the return), so that no pair is
   * judged without having been read inside its bound. A pair's bound starts at
   * `from` (default: the end of the write's share job). Each read counts with
   * the time it completed itself and is not made again once it found the
   * write; a slow read of one kind, or of another pair, never delays the
   * retries of another. Returns a handle { pairs, done, cancel }, not a
   * promise, so that whoever starts a watch does not wait for it; `cancel`
   * stops its reads.
   */
  function watch(pairs) {
    for (const pair of pairs) {
      pair.from = pair.from ?? pair.record.doneAt;
      pair.progress = { view: null, partitions: null };
      pair.last = { view: null, partitions: null };
    }
    let cancelled = false;
    const open = (pair, kind) => !cancelled && !pair.record.error && pair.progress[kind] === null && Date.now() - pair.from < boundMs;
    const poll = async (pair, kind, read) => {
      while (open(pair, kind)) {
        const seen = await read(pair.node, pair.record);
        pair.progress = foldRead(pair.progress, kind, { held: seen.held, completedAt: Date.now() }, { from: pair.from, boundMs });
        pair.last[kind] = seen;
        if (!open(pair, kind)) break;
        await sleep(Math.min(2000, Math.max(0, pair.from + boundMs - Date.now())));
      }
    };
    const done = Promise.all(pairs.flatMap(pair => READS.map(([kind, read]) => poll(pair, kind, read)))).then(() => undefined);
    return { pairs, done, cancel: () => { cancelled = true; } };
  }

  /** A write, and at once the watch of the nodes that must hold it (a handle, see watch). */
  async function writeAndWatch(caseId, author, graph, sub, what, nodes) {
    const record = await write(author, graph, sub, what);
    return watch(nodes.map(node => ({ caseId, record, node })));
  }

  /**
   * Started right after a member subscribed: one poller of the member's listing
   * for the graph. It records when the member first held the graph's definition
   * (deadline `definitionMs`: without it the member's own writes are refused)
   * and when it first listed the graph as synced (deadline `syncedMs`), and the
   * listing as read at each deadline, which is the evidence for the known gaps.
   * Nothing asks again: a definition lost on the way is a failure. Returns a
   * handle { node, graph, done, cancel }: `done` resolves to the observation
   * (see foldSubscription), or null once cancelled.
   */
  function observeSubscription(node, graph, from) {
    const deadlines = { definitionMs, syncedMs };
    let cancelled = false;
    const done = (async () => {
      let observation = freshSubscription();
      for (;;) {
        if (cancelled) return null;
        const listed = await listingEntry(node, graph);
        observation = foldSubscription(observation, listed, Date.now() - from, deadlines);
        if (observation.definedAt !== null) noteDefinition(node, graph, true);
        if (observation.done) {
          if (observation.definedAt === null) noteDefinition(node, graph, false);
          return observation;
        }
        // Read again in 2 s, or at the next deadline still open if that is sooner.
        const open = [observation.atDefinitionDeadline === null && from + definitionMs, observation.atSyncedDeadline === null && from + syncedMs]
          .filter(Boolean).filter(at => at > Date.now());
        await sleep(Math.max(0, Math.min(2000, ...open.map(at => at - Date.now()))));
      }
    })();
    return { node, graph, done, cancel: () => { cancelled = true; } };
  }

  return { createAndShare, listingEntry, write, watch, writeAndWatch, observeSubscription, definitionSeen };
}

/** When a pair was held (both reads), or null. */
export const heldAt = pair => (pair.progress && pairHeld(pair.progress) ? pair.from + Math.max(pair.progress.view, pair.progress.partitions) : null);

/** Waits for the watches and returns their pairs. */
export async function watched(handles) {
  await Promise.all(handles.map(handle => handle.done));
  return handles.flatMap(handle => handle.pairs);
}
