// The reports of the one-graph promotion suite
// (scripts/devnet-test-one-graph-promotion.mjs): each one written, sealed and
// shared into the graph's sub-graph the way a client does it (the create and
// asynchronous share job of member-sharing/observation.mjs), the two reads a
// client makes of shared memory and of Verified Memory, the watches of the
// pairs (a report, a node, what the node must show), the curator's promotion
// of a report another node authored, and an author's own publish. The
// judgements are in ../qa/one-graph-promotion.mjs.

import { brief, sleep } from '../member-sharing/devnet.mjs';
import { createObservation } from '../member-sharing/observation.mjs';
import { foldRead, inScope, pairHeld, sharedMemoryScope } from '../qa/member-sharing.mjs';
import { inVerifiedScope, judgeGone, judgeReport, PAIR_KINDS, readOutcome, verifiedScope, writeRetryable } from '../qa/one-graph-promotion.mjs';
import { parseObservation } from '../qa/query-observation.mjs';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const READS = ['view', 'partitions'];

/**
 * `config` is { stamp, sub, predicate, type, boundMs, definitionMs, syncedMs,
 * pollMs }: the run's stamp (in every subject and asset name), the sub-graph
 * every report goes to, the predicate that carries a report's value, the
 * report's class, the default bound of a pair, the deadlines of a
 * subscription, and how often a read is made again (default 2 s).
 */
export function createReports(devnet, config) {
  const { api } = devnet;
  const { stamp, sub, predicate, type, boundMs, definitionMs, syncedMs, pollMs = 2000 } = config;
  // The client-like write, the listing and the subscription observer of the
  // member-sharing suite; its own watches are not used here. Its API calls go
  // through a tap that keeps each create's answer by asset name, so that a
  // refused create keeps its HTTP status and the server's own error.
  const createAnswers = new Map();
  const tapped = {
    ...devnet,
    api: async (node, method, path, body, options) => {
      const answer = await api(node, method, path, body, options);
      if (method === 'POST' && path === '/api/knowledge-assets' && typeof body?.name === 'string') createAnswers.set(body.name, answer);
      return answer;
    },
  };
  const base = createObservation(tapped, { boundMs, definitionMs, syncedMs, stamp, predicate });
  let sequence = 0;

  /** A report's triples, as judgeReport takes them: its class, its value, and a body of about 200 bytes. */
  const triples = record => [
    { name: 'class', predicate: RDF_TYPE, iri: type },
    { name: 'value', predicate, text: record.value },
    { name: 'body', predicate: `${type}Body`, text: `report ${record.sequence} of run ${stamp}: ${'payload '.repeat(22)}` },
  ];
  const quads = record => record.triples.map(triple => ({
    subject: record.subject, predicate: triple.predicate, object: 'iri' in triple ? triple.iri : `"${triple.text}"`, graph: '',
  }));

  /**
   * One report, written with its seal and shared into the sub-graph's shared
   * memory by `author`: the record every pair of it uses. Resolves once the
   * share job ended; `doneAt` is when (the start of a pair's bound), or
   * `error` says why the report was not written, and `refusal` keeps that
   * failure's evidence: { phase: 'create', status, error (the server's own),
   * code } for a create refused, { phase: 'share' } for a share job that did
   * not succeed. A create refused the way a client retries (writeRetryable:
   * the graph not yet synced for writes, say) is made again every `pollMs`
   * until `retryUntil`; `refused` then says how often and how long, and
   * `doneAt` still counts from the share that ended. `triples` are the
   * report's triples, which every read must find whole. `onStart(record)`
   * runs before the first create is sent.
   */
  async function share(author, graph, what, { retryUntil = 0, onStart } = {}) {
    sequence += 1;
    const record = {
      author, graph, sub, what, sequence,
      name: `og-${stamp.toLowerCase()}-${sequence}`,
      subject: `urn:one-graph:${stamp}:${sequence}`,
      value: `${what} (${sequence})`,
      doneAt: null, error: null,
    };
    record.triples = triples(record);
    onStart?.(record);
    const started = Date.now();
    for (;;) {
      const outcome = await base.createAndShare(author, { contextGraphId: graph.id, name: record.name, subGraphName: sub, quads: quads(record) },
        { createTimeoutMs: 120_000, jobTimeoutMs: 120_000, pollMs: 1000 });
      if (!outcome.error) {
        record.doneAt = outcome.doneAt;
        break;
      }
      if (!writeRetryable(outcome) || Date.now() >= retryUntil) {
        record.error = outcome.error;
        const answer = createAnswers.get(record.name);
        record.refusal = answer && (answer.status < 200 || answer.status >= 300)
          ? { phase: 'create', status: answer.status, error: typeof answer.json?.error === 'string' ? answer.json.error : answer.text, code: answer.json?.code }
          : { phase: 'share' };
        break;
      }
      record.refused = { code: outcome.code, times: (record.refused?.times ?? 0) + 1 };
      await sleep(pollMs);
    }
    createAnswers.delete(record.name);
    if (record.refused) record.refused.waitedMs = Date.now() - started;
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

  // A held kind needs the whole report: each of its triples, with the written object.
  const judge = (kind, rows, record) => (PAIR_KINDS[kind].want === 'gone' ? judgeGone(rows) : judgeReport(rows, record.triples ?? triples(record)));

  const inVm = kind => PAIR_KINDS[kind].layer === 'vm';

  /** The layer's view of the sub-graph: `verifiable-memory` or `shared-working-memory`. */
  async function readView(kind, node, record) {
    const answer = await queryRows(node, {
      contextGraphId: record.graph.id, view: inVm(kind) ? 'verifiable-memory' : 'shared-working-memory', subGraphName: record.sub,
      sparql: `SELECT ?p ?o WHERE { <${record.subject}> ?p ?o }`,
    });
    return readOutcome(kind, answer.rows ? judge(kind, answer.rows, record) : { error: answer.error });
  }

  /** The cross-partition read, kept to the layer's graphs of the sub-graph. */
  async function readPartitions(kind, node, record) {
    const answer = await queryRows(node, {
      contextGraphId: record.graph.id, includeContextGraphPartitions: true,
      sparql: `SELECT ?g ?p ?o WHERE { GRAPH ?g { <${record.subject}> ?p ?o } }`,
    });
    if (!answer.rows) return readOutcome(kind, { error: answer.error });
    let inLayer;
    if (inVm(kind)) {
      const scope = verifiedScope(record.graph.resolved, record.sub);
      inLayer = row => inVerifiedScope(row.g, scope);
    } else {
      const scope = sharedMemoryScope(record.graph.resolved, record.sub);
      inLayer = row => inScope(row.g, scope);
    }
    return readOutcome(kind, judge(kind, answer.rows.filter(inLayer), record));
  }
  const read = (which, kind, node, record) => (which === 'view' ? readView : readPartitions)(kind, node, record);

  /**
   * The pairs of one report: each of `nodes` must show `kind` (see PAIR_KINDS)
   * within `bound` (default the configured bound) of `from` (default the end
   * of the report's share job); `fromWhat` names that moment in the report.
   */
  const pairs = (caseId, record, nodes, kind, { bound = boundMs, from, fromWhat } = {}) =>
    nodes.map(node => ({ caseId, record, node, kind, boundMs: bound, from, fromWhat }));

  /**
   * Starts watching pairs at once: each read of each pair polls on its own
   * until it shows what the pair waits for, the pair's bound has passed, or
   * the watch is cancelled. Each read counts with the time it completed. A
   * read that showed a report present is not made again; one that waits for
   * the report's absence keeps reading to the end of the bound, and a
   * reading that shows the report back after it was absent is kept
   * (`pair.reappeared`). Such a pair is read once more when its bound has
   * passed (`pair.confirm`, each read retried up to three times while it
   * fails). `pair.dating` keeps, for each read, when the last read that did
   * not show what the pair waits for was sent and when the first that showed
   * it was sent and completed (what arrivalWindow takes). Returns a handle {
   * pairs, done, cancel }, not a promise, so that whoever starts a watch does
   * not wait.
   */
  function watch(list) {
    for (const pair of list) {
      pair.from = pair.from ?? pair.record.doneAt;
      pair.progress = { view: null, partitions: null };
      pair.last = { view: null, partitions: null };
      pair.dating = Object.fromEntries(READS.map(which => [which, { lastMissSentAt: null, hit: null }]));
    }
    let cancelled = false;
    const absence = pair => PAIR_KINDS[pair.kind].want === 'gone';
    const open = (pair, which) => !cancelled && !pair.record.error && Date.now() - pair.from < pair.boundMs
      && (pair.progress[which] === null || absence(pair));
    const poll = async (pair, which) => {
      while (open(pair, which)) {
        const sentAt = Date.now();
        const seen = await read(which, pair.kind, pair.node, pair.record);
        const completedAt = Date.now();
        const before = pair.progress[which];
        pair.progress = foldRead(pair.progress, which, { held: seen.satisfied, completedAt }, { from: pair.from, boundMs: pair.boundMs });
        if (before === null && pair.progress[which] !== null) pair.dating[which].hit = { sentAt, completedAt };
        else if (before === null && seen.satisfied === false && !seen.error) pair.dating[which].lastMissSentAt = sentAt;
        // Absent before, present now: the report is back in the layer within the bound.
        if (before !== null && seen.satisfied === false && !seen.error) pair.reappeared ??= { read: which, age: Date.now() - pair.from, seen };
        pair.last[which] = seen;
        if (!open(pair, which)) break;
        await sleep(Math.min(pollMs, Math.max(0, pair.from + pair.boundMs - Date.now())));
      }
    };
    // The check after the bound: each read until one answers, up to three times.
    const confirm = async pair => {
      await sleep(Math.max(0, pair.from + pair.boundMs - Date.now()));
      if (cancelled) return;
      pair.confirm = {};
      for (const which of READS) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (attempt > 0) await sleep(pollMs);
          pair.confirm[which] = await read(which, pair.kind, pair.node, pair.record);
          if (!pair.confirm[which].error) break;
        }
      }
    };
    const settle = async pair => {
      await Promise.all(READS.map(which => poll(pair, which)));
      if (absence(pair) && pairHeld(pair.progress)) await confirm(pair);
    };
    const done = Promise.all(list.map(settle)).then(() => undefined);
    return { pairs: list, done, cancel: () => { cancelled = true; } };
  }

  /**
   * Dates a report's arrival at `node` more closely than a pair's watch does,
   * as evidence of what the node was doing at that moment: both reads of
   * `kind` are made every `everyMs` (default 250 ms) from the moment the
   * dating starts (before the report is created, so the report cannot have
   * been there yet) until each read has found what the kind waits for,
   * `untilMs` has passed, or the dating is stopped. `dating` is what
   * arrivalWindow takes: for each read, when the last read that did not find
   * it was sent (the start counts as one) and when the first read that found
   * it was sent and completed. A pair's watch still decides the delivery and
   * its bound. Returns { dating, done, stop }; `stop()` resolves to `dating`.
   */
  function dateArrival(node, record, kind, { everyMs = 250, untilMs = 300_000 } = {}) {
    const startedAt = Date.now();
    const dating = Object.fromEntries(READS.map(which => [which, { lastMissSentAt: startedAt, hit: null, errors: 0 }]));
    let stopped = false;
    const poll = async which => {
      while (!stopped && !dating[which].hit && !record.error && Date.now() - startedAt < untilMs) {
        const sentAt = Date.now();
        const seen = await read(which, kind, node, record);
        if (seen.error) dating[which].errors += 1;
        else if (seen.satisfied) dating[which].hit = { sentAt, completedAt: Date.now() };
        else dating[which].lastMissSentAt = sentAt;
        if (!dating[which].hit && !stopped) await sleep(everyMs);
      }
    };
    const done = Promise.all(READS.map(poll)).then(() => dating);
    return { dating, done, stop: () => { stopped = true; return done; } };
  }

  /**
   * The curator's promotion of a report from the sub-graph's shared memory to
   * Verified Memory: the publish route of a finalized asset, with the author
   * selected among the authors resident at that name (the report's author,
   * not the curator). Resolves to { answer, at } (when the answer came).
   */
  async function promote(curator, record) {
    const answer = await api(curator, 'POST', `/api/knowledge-assets/${encodeURIComponent(record.name)}/vm/publish`, {
      contextGraphId: record.graph.id, subGraphName: record.sub, selectedAuthorAgentAddress: record.author.agentAddress,
    }, { timeoutMs: 300_000 });
    return { answer, at: Date.now() };
  }

  /** The author's own publish of its report, the same route without a selected author. */
  async function ownPublish(author, record) {
    const answer = await api(author, 'POST', `/api/knowledge-assets/${encodeURIComponent(record.name)}/vm/publish`, {
      contextGraphId: record.graph.id, subGraphName: record.sub,
    }, { timeoutMs: 300_000 });
    return { answer, at: Date.now() };
  }

  /** What a node's lifecycle record of a report says (its state and layer), for the run's notes. */
  async function lifecycle(node, record) {
    const query = new URLSearchParams({ contextGraphId: record.graph.id, subGraphName: record.sub, agentAddress: record.author.agentAddress });
    const answer = await api(node, 'GET', `/api/knowledge-assets/${encodeURIComponent(record.name)}?${query}`, undefined, { timeoutMs: 30_000 });
    if (answer.status !== 200 || !answer.json) return brief(answer);
    const { status, state, memoryLayer, swmCurrentAssertion, vmCurrentAssertion } = answer.json;
    return JSON.stringify({ status, state, memoryLayer, swm: Boolean(swmCurrentAssertion), vm: Boolean(vmCurrentAssertion) });
  }

  return {
    share, pairs, watch, dateArrival, promote, ownPublish, lifecycle,
    createAndShare: base.createAndShare, listingEntry: base.listingEntry, observeSubscription: base.observeSubscription,
  };
}

/** Waits for the watches and returns their pairs. */
export async function settled(handles) {
  await Promise.all(handles.map(handle => handle.done));
  return handles.flatMap(handle => handle.pairs);
}
