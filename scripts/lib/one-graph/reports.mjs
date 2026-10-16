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
import { inScope, pairHeld, sharedMemoryScope } from '../qa/member-sharing.mjs';
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
   * within `bound` (default the configured bound; Infinity for a watch that
   * runs until it is closed) of `from` (default the end of the report's share
   * job, which a watch started before it waits for); `fromWhat` names that
   * moment in the report. `pending` pairs start their bound only when the
   * watch is armed (`handle.arm(from)`: the answer of a promotion, say).
   * `everyMs` reads more often than the configured interval; `notBefore` is a
   * moment before which the node cannot have shown what the pair waits for
   * (before the report was written, or before it was promoted): the first
   * miss of its dating.
   */
  const pairs = (caseId, record, nodes, kind, { bound = boundMs, from, fromWhat, everyMs, notBefore, pending = false } = {}) =>
    nodes.map(node => ({ caseId, record, node, kind, boundMs: bound, from, fromWhat, everyMs, notBefore, pending }));

  /**
   * Starts watching pairs at once: each read of each pair polls on its own
   * until it shows what the pair waits for, the pair's bound has passed, or
   * the watch is cancelled. Each read counts with the time it completed. A
   * pair's bound starts at its `from`; a watch started before the report's
   * share ended (from the moment the report is created, say) reads at once,
   * and its bound starts when the share ends, a read that found the report
   * before then counting with age 0. A `pending` pair reads at once too, and
   * its bound starts when the watch is armed. A read that showed a report present is
   * not made again; a pair that holds throughout (its absence, or `kept`)
   * keeps reading to the end of the bound. A reading that shows a report back
   * after it was absent is kept (`pair.reappeared`), and so is a reading that
   * shows a `kept` report missing at any time (`pair.lapsed`), each with the
   * moment it completed (`at`). Such a pair is read once more when its bound
   * has passed (`pair.confirm`, each read retried up to three times while it
   * fails). The observations are absolute: `pair.dating` keeps, for each
   * read, when the last read that did not show what the pair waits for was
   * sent (from `notBefore` on) and when the first that showed it was sent and
   * completed, one history for the delivery and for arrivalWindow;
   * `pair.progress` (each read's age at its first find within the bound) is
   * derived from it once the bound has its anchor (`pair.from`). Returns a
   * handle { pairs, done, cancel, close, arm }, not a promise, so that
   * whoever starts a watch does not wait; `close()` ends the bound of a pair
   * that runs until closed at that moment, and `arm(from)` starts the bound
   * of its pending pairs.
   */
  function watch(list) {
    const anchored = pair => pair.from !== null && pair.from !== undefined;
    // A pair's progress, derived from its reads' observations once its bound has
    // an anchor: each read's first find, by its age (0 for a find made before the
    // anchor), counted only within the bound.
    const progressOf = pair => Object.fromEntries(READS.map(which => {
      const { hit } = pair.dating[which];
      if (!hit || !anchored(pair)) return [which, null];
      const age = Math.max(0, hit.completedAt - pair.from);
      return [which, age < pair.boundMs ? age : null];
    }));
    for (const pair of list) {
      pair.from = pair.pending ? null : pair.from ?? pair.record.doneAt;
      pair.last = { view: null, partitions: null };
      const unseen = Number.isFinite(pair.notBefore) ? pair.notBefore : null;
      pair.dating = Object.fromEntries(READS.map(which => [which, { lastMissSentAt: unseen, hit: null }]));
      Object.defineProperty(pair, 'progress', { get: () => progressOf(pair), enumerable: true, configurable: true });
    }
    let cancelled = false;
    const absence = pair => PAIR_KINDS[pair.kind].want === 'gone';
    const kept = pair => PAIR_KINDS[pair.kind].throughout === true;
    const throughout = pair => absence(pair) || kept(pair);
    // The anchor of a pair's bound: the end of the report's share, or the moment a pending pair is armed.
    const arm = (pair, from = pair.pending ? null : pair.record.doneAt) => {
      if (anchored(pair) || from === null || from === undefined) return;
      pair.from = from;
      pair.pending = false;
    };
    // A read's observations, in absolute time: when it last missed what the pair waits for (before
    // its first find), its first find, and a reading that broke the pair (a report back after it had
    // left, or a report that must stay in the layer missing from it).
    const fold = (pair, which, seen, sentAt, completedAt) => {
      const dating = pair.dating[which];
      const missed = seen.satisfied === false && !seen.error;
      if (seen.satisfied && !dating.hit) dating.hit = { sentAt, completedAt };
      else if (missed && !dating.hit) dating.lastMissSentAt = sentAt;
      else if (missed && absence(pair)) pair.reappeared ??= { read: which, at: completedAt, seen };
      if (kept(pair) && missed) pair.lapsed ??= { read: which, at: completedAt, seen };
      pair.last[which] = seen;
    };
    // A read's watch is over once cancelled, the report never written, its bound passed, or
    // (for a pair that does not hold throughout) its find made; before its anchor, it waits for it.
    const over = (pair, which) => cancelled || Boolean(pair.record.error)
      || (anchored(pair) && (Date.now() - pair.from >= pair.boundMs || (Boolean(pair.dating[which].hit) && !throughout(pair))));
    const poll = async (pair, which) => {
      for (;;) {
        arm(pair);
        if (over(pair, which)) return;
        // A find made before the anchor needs no more reads, only the anchor.
        if (!pair.dating[which].hit || throughout(pair)) {
          const sentAt = Date.now();
          const seen = await read(which, pair.kind, pair.node, pair.record);
          fold(pair, which, seen, sentAt, Date.now());
          arm(pair);
          if (over(pair, which)) return;
        }
        const every = pair.everyMs ?? pollMs;
        await sleep(anchored(pair) ? Math.min(every, Math.max(0, pair.from + pair.boundMs - Date.now())) : every);
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
      if (!cancelled && throughout(pair) && anchored(pair) && pairHeld(pair.progress) && !pair.lapsed) await confirm(pair);
    };
    const done = Promise.all(list.map(settle)).then(() => undefined);
    const close = () => {
      for (const pair of list) if (anchored(pair) && !Number.isFinite(pair.boundMs)) pair.boundMs = Math.max(0, Date.now() - pair.from);
    };
    return { pairs: list, done, cancel: () => { cancelled = true; }, close, arm: from => { for (const pair of list) if (pair.pending) arm(pair, from); } };
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
    share, pairs, watch, promote, ownPublish, lifecycle,
    createAndShare: base.createAndShare, listingEntry: base.listingEntry, observeSubscription: base.observeSubscription,
  };
}

/** Waits for the watches and returns their pairs. */
export async function settled(handles) {
  await Promise.all(handles.map(handle => handle.done));
  return handles.flatMap(handle => handle.pairs);
}
