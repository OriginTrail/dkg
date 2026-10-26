// Tests of the one-graph promotion suite's reports (scripts/lib/one-graph/reports.mjs
// and their judgements): where a report is held, in shared memory or Verified
// Memory, when it has left, and the watch of each pair.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  arrivalWindow, inVerifiedScope, judgeGone, judgeReport, pairOutcome, readOutcome, verifiedScope, writeRetryable,
} from '../qa/one-graph-promotion.mjs';
import { sharedMemoryScope } from '../qa/member-sharing.mjs';
import { promotionRound } from '../one-graph/promotion-round.mjs';
import { createReports, settled } from '../one-graph/reports.mjs';
import { author, BODY, CG, LABEL, node, RDF_TYPE } from './one-graph-fixtures.mjs';

test('Verified Memory of a sub-graph is its content graph and the per-asset graphs below it, nothing else', () => {
  const scope = verifiedScope(CG, 'reports');
  const base = `did:dkg:context-graph:${CG}`;
  for (const graph of [`${base}/reports`, `<${base}/reports>`, `${base}/reports/_verifiable_memory/0xauthor/7`, { type: 'uri', value: `${base}/reports/_verifiable_memory/x` }]) {
    assert.equal(inVerifiedScope(graph, scope), true, JSON.stringify(graph));
  }
  for (const graph of [
    base, `${base}/reports/_shared_memory`, `${base}/reports/_shared_memory/0xauthor/7`, `${base}/reports/_working_memory/0xa/1`,
    `${base}/reports/assertion/0xa/name`, `${base}/reports/_meta`, `${base}/_verifiable_memory/0xa/1`, `${base}/reportsX`, `${base}/reports_verifiable_memory/x`,
  ]) assert.equal(inVerifiedScope(graph, scope), false, graph);
  const root = verifiedScope(CG);
  assert.equal(inVerifiedScope(base, root), true);
  assert.equal(inVerifiedScope(`${base}/_verifiable_memory/0xa/1`, root), true);
  assert.equal(inVerifiedScope(`${base}/reports/_verifiable_memory/0xa/1`, root), false);
});

test('a report has left a layer only when no triple of its subject is left there', () => {
  assert.deepEqual(judgeGone([]), { gone: true, found: 0 });
  // Its value gone, its body or its class still there: it has not left.
  assert.deepEqual(judgeGone([{ p: 'urn:one-graph:ReportBody', o: '"x"' }]), { gone: false, found: 1 });
  assert.deepEqual(judgeGone([{ p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'urn:one-graph:Report' }]), { gone: false, found: 1 });
  assert.deepEqual(judgeGone([{ p: `<${LABEL}>`, o: '"x"' }, { p: LABEL, o: '"y"' }]), { gone: false, found: 2 });
});

test('a read that failed satisfies no pair, not even one waiting for absence', () => {
  assert.deepEqual(readOutcome('gone', { error: 'HTTP 503' }), { satisfied: false, error: 'HTTP 503' });
  assert.deepEqual(readOutcome('unpublished', { error: 'x' }), { satisfied: false, error: 'x' });
  assert.deepEqual(readOutcome('gone', { gone: true, found: 0 }), { satisfied: true, found: 0 });
  assert.deepEqual(readOutcome('gone', { gone: false, found: 1 }), { satisfied: false, found: 1 });
  assert.deepEqual(readOutcome('vm', { held: true }), { satisfied: true });
  assert.deepEqual(readOutcome('swm', { held: false, different: '"z"' }), { satisfied: false, different: '"z"' });
  assert.throws(() => readOutcome('nowhere', { held: true }), /unknown pair kind/);
});

const record = { author, graph: { key: 'main' }, sub: 'reports', value: 'edgeA report 1 (1)', error: null };
const pairOf = (kind, progress, extra = {}) => ({ record, node, kind, boundMs: 60_000, progress, last: { view: null, partitions: null }, ...extra });

test('a pair holds once both reads showed it, and says where and when', () => {
  assert.deepEqual(pairOutcome(pairOf('swm', { view: 1200, partitions: 2600 }), { boundMs: 60_000 }),
    { outcome: 'pass', text: '"edgeA report 1 (1)" by node8 (edgeA) in main/reports at node9 (edgeB): in shared memory 3 s after the share' });
  assert.match(pairOutcome(pairOf('vm', { view: 4000, partitions: 5000 }, { fromWhat: 'promotion' }), { boundMs: 60_000 }).text,
    /: in Verified Memory 5 s after the promotion$/);
  assert.match(pairOutcome(pairOf('gone', { view: 7000, partitions: 9000 }, { fromWhat: 'promotion', confirm: { view: { satisfied: true }, partitions: { satisfied: true } } }), { boundMs: 60_000 }).text,
    /: left shared memory 9 s after the promotion, and out of it to the end of the 60 s$/);
  assert.match(pairOutcome(pairOf('unpublished', { view: 100, partitions: 100 }, { fromWhat: 'refused publish', confirm: { view: { satisfied: true }, partitions: { satisfied: true } } }), { boundMs: 60_000 }).text,
    /: absent from Verified Memory at every reading from the refused publish to the end of the 60 s$/);
  assert.match(pairOutcome(pairOf('absent', { view: 100, partitions: 300 }, { fromWhat: 'check', boundMs: 30_000, confirm: { view: { satisfied: true }, partitions: { satisfied: true } } }), { boundMs: 60_000 }).text,
    /: absent from shared memory 0 s after the check, and out of it to the end of the 30 s$/);
});

test('a pair that did not hold names each read that missed it and what that read last saw', () => {
  const missed = pairOf('vm', { view: 3000, partitions: null }, { fromWhat: 'promotion', last: { view: { satisfied: true }, partitions: { satisfied: false, error: 'HTTP 503 busy' } } });
  const result = pairOutcome(missed, { boundMs: 60_000 });
  assert.equal(result.outcome, 'fail');
  assert.equal(result.text, '"edgeA report 1 (1)" by node8 (edgeA) in main/reports at node9 (edgeB): NOT in Verified Memory: not in the cross-partition read (HTTP 503 busy) 60 s after the promotion (shown by the view after 3 s)');
  const still = pairOf('gone', { view: null, partitions: null }, { fromWhat: 'promotion', last: { view: { satisfied: false, found: 1 }, partitions: { satisfied: false, found: 2 } } });
  assert.equal(pairOutcome(still, { boundMs: 60_000 }).text,
    '"edgeA report 1 (1)" by node8 (edgeA) in main/reports at node9 (edgeB): STILL in the shared-working-memory view of reports (1 row(s) of it) and in the cross-partition read (2 row(s) of it) 60 s after the promotion');
  const found = pairOf('absent', { view: null, partitions: 1000 }, { fromWhat: 'late Edge subscribed', boundMs: 90_000, last: { view: { satisfied: false, found: 1 }, partitions: { satisfied: true } } });
  assert.equal(pairOutcome(found, { boundMs: 60_000 }).text,
    '"edgeA report 1 (1)" by node8 (edgeA) in main/reports at node9 (edgeB): FOUND in the shared-working-memory view of reports (1 row(s) of it) 90 s after the late Edge subscribed (absent from the cross-partition read after 1 s)');
  const inVm = pairOf('unpublished', { view: null, partitions: null }, { fromWhat: 'own publish', last: { view: { satisfied: false, found: 1 }, partitions: { satisfied: false, found: 1 } } });
  assert.match(pairOutcome(inVm, { boundMs: 60_000 }).text, /: FOUND in the verifiable-memory view of reports \(1 row\(s\) of it\) and in the cross-partition read \(1 row\(s\) of it\) 60 s after the own publish$/);
  const different = pairOf('swm', { view: null, partitions: null }, { last: { view: { satisfied: false, different: '"other"' }, partitions: null } });
  assert.match(pairOutcome(different, { boundMs: 60_000 }).text, /holds another value: "other"\) nor in the cross-partition read \(never read\) 60 s after the share$/);
});

test('a report back in shared memory after it had left fails, at any reading or at the last, and so does a last check that could not be read', () => {
  const back = pairOf('gone', { view: 2000, partitions: 3000 }, { fromWhat: 'promotion', confirm: { view: { satisfied: false, found: 1 }, partitions: { satisfied: true } } });
  const result = pairOutcome(back, { boundMs: 60_000 });
  assert.equal(result.outcome, 'fail');
  assert.match(result.text, /left shared memory 3 s after the promotion, then was in the shared-working-memory view of reports \(1 row\(s\) of it\) again when the 60 s had passed$/);
  const between = pairOf('gone', { view: 2000, partitions: 3000 }, {
    from: 1_000_000, fromWhat: 'promotion', reappeared: { read: 'partitions', at: 1_010_400, seen: { satisfied: false, found: 2 } },
    confirm: { view: { satisfied: true }, partitions: { satisfied: true } },
  });
  assert.equal(pairOutcome(between, { boundMs: 60_000 }).text,
    '"edgeA report 1 (1)" by node8 (edgeA) in main/reports at node9 (edgeB): left shared memory 3 s after the promotion, then was in the cross-partition read (2 row(s) of it) again 10 s after it');
  const unreadable = pairOf('gone', { view: 2000, partitions: 3000 }, { fromWhat: 'promotion', confirm: { view: { satisfied: false, error: 'HTTP 0 timeout' }, partitions: { satisfied: true } } });
  assert.deepEqual(pairOutcome(unreadable, { boundMs: 60_000 }), {
    outcome: 'fail',
    text: '"edgeA report 1 (1)" by node8 (edgeA) in main/reports at node9 (edgeB): left shared memory 3 s after the promotion, but the shared-working-memory view of reports (HTTP 0 timeout) could not be read when the 60 s had passed, so the absence to the end is not known',
  });
  // No check after the bound at all (the watch was cancelled): not known either.
  assert.equal(pairOutcome(pairOf('gone', { view: 2000, partitions: 3000 }), { boundMs: 60_000 }).outcome, 'fail');
});

test('a report that was never written fails each pair of it', () => {
  const unwritten = { ...pairOf('swm', { view: null, partitions: null }), record: { ...record, error: 'the author refused the asset: HTTP 400' } };
  assert.deepEqual(pairOutcome(unwritten, { boundMs: 60_000 }), {
    outcome: 'fail', text: '"edgeA report 1 (1)" by node8 (edgeA) in main/reports at node9 (edgeB): not written, the author refused the asset: HTTP 400',
  });
});

test('a create refused because the graph is not ready for writes yet is retried; any other refusal is not', () => {
  for (const code of ['CONTEXT_GRAPH_NOT_WRITABLE', 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE', 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE']) {
    assert.equal(writeRetryable({ error: 'refused', code }), true, code);
  }
  for (const outcome of [{ error: 'refused', code: 'CONTEXT_GRAPH_NOT_FOUND' }, { error: 'refused' }, { error: 'job failed', code: undefined }, { doneAt: 1 }, null]) {
    assert.equal(writeRetryable(outcome), false, JSON.stringify(outcome));
  }
});

/**
 * createReports over a node whose query route answers from `present(age,
 * body)`: whether the report's subject is in the asked layer at that age (ms
 * since the start). The partitions read gets a row in the sub-graph's shared
 * memory, the view read a row of its own.
 */

function scriptedReports(present) {
  const started = Date.now();
  const cg = '0xabc/one-graph-main-1';
  const devnet = {
    api: async (_node, _method, _path, body) => {
      const rows = present(Date.now() - started, body)
        ? [{ ...(body.includeContextGraphPartitions ? { g: `${sharedMemoryScope(cg, 'reports')}/0xaa/1` } : {}), p: LABEL, o: '"r (1)"' }]
        : [];
      return { status: 200, json: null, text: JSON.stringify({ result: { type: 'bindings', bindings: rows } }) };
    },
  };
  const io = createReports(devnet, {
    stamp: 'S', sub: 'reports', predicate: LABEL, type: 'urn:one-graph:Report', boundMs: 600, definitionMs: 1000, syncedMs: 1000, pollMs: 40,
  });
  const report = { author, graph: { key: 'main', id: cg, resolved: cg }, sub: 'reports', subject: 'urn:one-graph:S:1', value: 'r (1)', doneAt: started, error: null };
  return { io, report, started };
}

test('an absence watch reads through its whole bound, and a report back in the layer before the last check fails', async () => {
  // Gone at once, back from 150 ms to 350 ms, gone again well before the bound of 600 ms ends.
  const { io, report, started } = scriptedReports(age => age >= 150 && age < 350);
  const handle = io.watch(io.pairs(4, report, [node], 'gone', { from: started, fromWhat: 'promotion', bound: 600 }));
  await handle.done;
  const [pair] = handle.pairs;
  assert.deepEqual([pair.confirm.view.satisfied, pair.confirm.partitions.satisfied], [true, true]);
  const result = pairOutcome(pair, { boundMs: 600 });
  assert.equal(result.outcome, 'fail');
  assert.match(result.text, /: left shared memory 0 s after the promotion, then was in the (shared-working-memory view of reports|cross-partition read) \(1 row\(s\) of it\) again 0 s after it$/);
});

test('an absence watch passes a report that left the layer within the bound and stayed out, and keeps its first absence', async () => {
  const { io, report, started } = scriptedReports(age => age < 200);
  const handle = io.watch(io.pairs(4, report, [node], 'gone', { from: started, fromWhat: 'promotion', bound: 600 }));
  await handle.done;
  const [pair] = handle.pairs;
  assert.equal(pair.reappeared, undefined);
  assert.ok(pair.progress.view >= 200 && pair.progress.partitions >= 200, JSON.stringify(pair.progress));
  assert.deepEqual(pairOutcome(pair, { boundMs: 600 }).outcome, 'pass');
  // A report that never left within the bound fails as still there.
  const stuck = scriptedReports(() => true);
  const kept = stuck.io.watch(stuck.io.pairs(4, stuck.report, [node], 'gone', { from: stuck.started, fromWhat: 'promotion', bound: 300 }));
  await kept.done;
  assert.match(pairOutcome(kept.pairs[0], { boundMs: 300 }).text, /: STILL in the shared-working-memory view of reports \(1 row\(s\) of it\) and in the cross-partition read \(1 row\(s\) of it\) 0 s after the promotion$/);
});

test('an absence watch fails a report whose value left the layer but whose body is still there', async () => {
  const started = Date.now();
  const cg = '0xabc/one-graph-main-1';
  const devnet = {
    api: async (_node, _method, _path, body) => {
      const rows = [{ ...(body.includeContextGraphPartitions ? { g: `${sharedMemoryScope(cg, 'reports')}/0xaa/1` } : {}), p: 'urn:one-graph:ReportBody', o: '"report 1"' }];
      return { status: 200, json: null, text: JSON.stringify({ result: { type: 'bindings', bindings: rows } }) };
    },
  };
  const io = createReports(devnet, { stamp: 'S', sub: 'reports', predicate: LABEL, type: 'urn:one-graph:Report', boundMs: 300, definitionMs: 1000, syncedMs: 1000, pollMs: 40 });
  const report = { author, graph: { key: 'main', id: cg, resolved: cg }, sub: 'reports', subject: 'urn:one-graph:S:1', value: 'r (1)', doneAt: started, error: null };
  const handle = io.watch(io.pairs(4, report, [node], 'gone', { from: started, fromWhat: 'promotion', bound: 300 }));
  await handle.done;
  assert.match(pairOutcome(handle.pairs[0], { boundMs: 300 }).text, /: STILL in the shared-working-memory view of reports \(1 row\(s\) of it\) and in the cross-partition read \(1 row\(s\) of it\) 0 s after the promotion$/);
});

test('an absence watch whose reads fail after the first absence does not pass', async () => {
  const started = Date.now();
  const cg = '0xabc/one-graph-main-1';
  const devnet = {
    api: async () => (Date.now() - started < 60
      ? { status: 200, json: null, text: JSON.stringify({ result: { type: 'bindings', bindings: [] } }) }
      : { status: 503, json: { error: 'store unavailable' }, text: '{"error":"store unavailable"}' }),
  };
  const io = createReports(devnet, { stamp: 'S', sub: 'reports', predicate: LABEL, type: 'urn:one-graph:Report', boundMs: 400, definitionMs: 1000, syncedMs: 1000, pollMs: 30 });
  const report = { author, graph: { key: 'main', id: cg, resolved: cg }, sub: 'reports', subject: 'urn:one-graph:S:1', value: 'r (1)', doneAt: started, error: null };
  const handle = io.watch(io.pairs(4, report, [node], 'gone', { from: started, fromWhat: 'promotion', bound: 400 }));
  await handle.done;
  const [pair] = handle.pairs;
  assert.notEqual(pair.progress.view, null);
  const result = pairOutcome(pair, { boundMs: 400 });
  assert.equal(result.outcome, 'fail');
  assert.match(result.text, /could not be read when the 0 s had passed, so the absence to the end is not known$/);
});

test('a report is held only whole: its class, its value and its body, each with the written object', () => {
  const expected = [
    { name: 'class', predicate: RDF_TYPE, iri: 'urn:one-graph:Report' },
    { name: 'value', predicate: LABEL, text: 'r (1)' },
    { name: 'body', predicate: BODY, text: 'report 1 of run S: payload' },
  ];
  const whole = [{ p: RDF_TYPE, o: 'urn:one-graph:Report' }, { p: LABEL, o: '"r (1)"' }, { p: BODY, o: '"report 1 of run S: payload"' }];
  assert.deepEqual(judgeReport(whole, expected), { held: true });
  // SPARQL-results cells, a bracketed IRI, and another predicate of the subject beside: held.
  assert.deepEqual(judgeReport([
    { p: `<${RDF_TYPE}>`, o: { type: 'uri', value: 'urn:one-graph:Report' } }, { p: { type: 'uri', value: LABEL }, o: { type: 'literal', value: 'r (1)' } },
    whole[2], { p: 'urn:x:other', o: '"x"' },
  ], expected), { held: true });
  // The value alone: the class and the body were lost.
  assert.deepEqual(judgeReport([whole[1]], expected), { held: false, missing: ['class', 'body'] });
  assert.deepEqual(judgeReport([], expected), { held: false });
  assert.deepEqual(judgeReport([{ p: 'urn:x:other', o: '"x"' }], expected), { held: false });
  // An altered body, a class given as a text, a second value beside the written one.
  assert.deepEqual(judgeReport([whole[0], whole[1], { p: BODY, o: '"report 1 of run S: pay"' }], expected), { held: false, different: 'its body "report 1 of run S: pay"' });
  assert.deepEqual(judgeReport([{ p: RDF_TYPE, o: '"urn:one-graph:Report"' }, whole[1], whole[2]], expected), { held: false, different: 'its class "urn:one-graph:Report"' });
  assert.deepEqual(judgeReport([...whole, { p: LABEL, o: '"r (2)"' }], expected), { held: false, different: 'its value "r (2)"' });
  assert.deepEqual(readOutcome('vm', judgeReport([whole[1]], expected)), { satisfied: false, missing: ['class', 'body'] });
});

// A node whose layers hold what `layers()` answers ({ swm, vm }: quads as written, or null), behind the create and share routes.
function layeredNode(cg, layers) {
  const written = [];
  const rowsOf = (quads, graph) => (quads ?? []).map(quad => ({ ...(graph ? { g: graph } : {}), p: quad.predicate, o: quad.object }));
  const api = async (_node, method, path, body) => {
    if (method === 'POST' && path === '/api/knowledge-assets') {
      written.push(...body.quads);
      return { status: 200, json: {}, text: '{}' };
    }
    if (method === 'POST' && path.endsWith('/swm/share-async')) return { status: 200, json: { jobId: 'j1' }, text: '{"jobId":"j1"}' };
    if (method === 'GET' && path.startsWith('/api/knowledge-assets/swm/share-jobs/')) return { status: 200, json: { state: 'succeeded' }, text: '{"state":"succeeded"}' };
    if (path !== '/api/query') return { status: 404, json: null, text: 'not used' };
    const { swm, vm } = layers();
    const rows = body.view === 'shared-working-memory' ? rowsOf(swm)
      : body.view === 'verifiable-memory' ? rowsOf(vm)
        : [...rowsOf(swm, `${sharedMemoryScope(cg, 'reports')}/0xaa/1`), ...rowsOf(vm, `did:dkg:context-graph:${cg}/reports/_verifiable_memory/1`)];
    return { status: 200, json: null, text: JSON.stringify({ result: { type: 'bindings', bindings: rows } }) };
  };
  return { written, api };
}

test('a placement check needs the whole report in the layer, as share() wrote it: class, value and body', async () => {
  const cg = '0xabc/one-graph-main-1';
  let layers = { swm: null, vm: null };
  const stub = layeredNode(cg, () => layers);
  const io = createReports({ api: stub.api }, { stamp: 'S', sub: 'reports', predicate: LABEL, type: 'urn:one-graph:Report', boundMs: 300, definitionMs: 1000, syncedMs: 1000, pollMs: 30 });
  const record = await io.share(author, { key: 'main', id: cg, resolved: cg }, 'r');
  assert.equal(record.error, null);
  assert.deepEqual(stub.written.map(quad => quad.predicate), [RDF_TYPE, LABEL, BODY]);
  const whole = stub.written;
  const placed = async kind => {
    const handle = io.watch(io.pairs(4, record, [node], kind, { from: Date.now(), bound: 300 }));
    await handle.done;
    return pairOutcome(handle.pairs[0], { boundMs: 300 });
  };
  layers = { swm: whole, vm: null };
  assert.equal((await placed('swm')).outcome, 'pass');
  // Only the value in shared memory: its class and body were lost.
  layers = { swm: whole.filter(quad => quad.predicate === LABEL), vm: null };
  const partial = await placed('swm');
  assert.equal(partial.outcome, 'fail');
  assert.match(partial.text, /NOT in shared memory: not in the shared-working-memory view of reports \(without its class and its body\) nor in the cross-partition read \(without its class and its body\)/);
  // Verified Memory with an altered body, then whole.
  layers = { swm: null, vm: whole.map(quad => (quad.predicate === BODY ? { ...quad, object: '"report 1 of run S: cut"' } : quad)) };
  const altered = await placed('vm');
  assert.equal(altered.outcome, 'fail');
  assert.match(altered.text, /NOT in Verified Memory: not in the verifiable-memory view of reports \(holds another value: its body "report 1 of run S: cut"\)/);
  layers = { swm: null, vm: whole.filter(quad => quad.predicate !== RDF_TYPE) };
  assert.match((await placed('vm')).text, /\(without its class\)/);
  layers = { swm: null, vm: whole };
  assert.equal((await placed('vm')).outcome, 'pass');
});

// A node that answers the whole report while `present(age)` holds (age from the stub's start), in both layers' reads of shared memory.
function wholeReportNode(cg, present) {
  const started = Date.now();
  const rows = [{ p: RDF_TYPE, o: 'urn:one-graph:Report' }, { p: LABEL, o: '"r (1)"' }, { p: BODY, o: '"report 1 of run S: payload"' }];
  return {
    started,
    api: async (_node, _method, _path, body) => {
      const bindings = present(Date.now() - started)
        ? rows.map(row => ({ ...(body.includeContextGraphPartitions ? { g: `${sharedMemoryScope(cg, 'reports')}/0xaa/1` } : {}), ...row }))
        : [];
      return { status: 200, json: null, text: JSON.stringify({ result: { type: 'bindings', bindings } }) };
    },
  };
}

const wholeReport = (cg, doneAt) => ({
  author, graph: { key: 'main', id: cg, resolved: cg }, sub: 'reports', subject: 'urn:one-graph:S:1', value: 'r (1)', doneAt, error: null,
  triples: [
    { name: 'class', predicate: RDF_TYPE, iri: 'urn:one-graph:Report' }, { name: 'value', predicate: LABEL, text: 'r (1)' },
    { name: 'body', predicate: BODY, text: 'report 1 of run S: payload' },
  ],
});

const reportsOver = api => createReports({ api }, { stamp: 'S', sub: 'reports', predicate: LABEL, type: 'urn:one-graph:Report', boundMs: 600, definitionMs: 1000, syncedMs: 1000, pollMs: 40 });

test('a watch started before the share ended reads at once, and its bound starts when the share ends', async () => {
  const cg = '0xabc/one-graph-main-1';
  // The report reaches the node at 100 ms; the share ends at 250 ms.
  const early = wholeReportNode(cg, age => age >= 100);
  const report = wholeReport(cg, null);
  const io = reportsOver(early.api);
  const handle = io.watch(io.pairs(6, report, [node], 'swm', { everyMs: 20, notBefore: early.started }));
  await new Promise(resolve => setTimeout(resolve, 250));
  report.doneAt = Date.now();
  await handle.done;
  const [pair] = handle.pairs;
  assert.equal(pair.from, report.doneAt);
  assert.deepEqual(pair.progress, { view: 0, partitions: 0 });
  assert.equal(pairOutcome(pair, { boundMs: 600 }).text, '"r (1)" by node8 (edgeA) in main/reports at node9 (edgeB): in shared memory 0 s after the share');
  // The same reads date the arrival, before the share ended.
  const window = arrivalWindow(pair.dating);
  assert.ok(window.after < early.started + 100 && window.by >= early.started + 100 && window.by < report.doneAt, JSON.stringify(window));
  // A share that fails while its watch waits: the pair fails as not written, and the watch ends.
  const failing = wholeReport(cg, null);
  const never = io.watch(io.pairs(6, failing, [node], 'swm', { everyMs: 20, notBefore: Date.now() }));
  await new Promise(resolve => setTimeout(resolve, 60));
  failing.error = 'the share job ended failed: null';
  await never.done;
  assert.match(pairOutcome(never.pairs[0], { boundMs: 600 }).text, /: not written, the share job ended failed: null$/);
});

test('a report that must stay in shared memory fails at the first reading that misses it, even if it comes back', async () => {
  const cg = '0xabc/one-graph-main-1';
  const kept = async (present, { closeAfter = 300, bound = Infinity } = {}) => {
    const stub = wholeReportNode(cg, present);
    const io = reportsOver(stub.api);
    const handle = io.watch(io.pairs(4, wholeReport(cg, stub.started), [node], 'kept', { from: stub.started, fromWhat: 'start of the promotions', bound }));
    await new Promise(resolve => setTimeout(resolve, closeAfter));
    handle.close();
    await handle.done;
    return pairOutcome(handle.pairs[0], { boundMs: 600 });
  };
  // There at every reading: held once the watch is closed.
  const steady = await kept(() => true);
  assert.equal(steady.outcome, 'pass');
  assert.match(steady.text, /: in shared memory at every reading from the start of the promotions to the end of the 0 s$/);
  // Gone for a while during the promotions, then back: a failure, not an eventual presence.
  const dipped = await kept(age => age < 80 || age >= 160);
  assert.equal(dipped.outcome, 'fail');
  assert.match(dipped.text, /: MISSING from (the shared-working-memory view of reports|the cross-partition read) 0 s after the start of the promotions, though it must stay in shared memory$/);
  // Missing at the first reading and present later: a failure too.
  assert.equal((await kept(age => age >= 100)).outcome, 'fail');
  // Missing only at the final confirmation: an in-flight periodic read must
  // still see the report even if it finishes after close().
  let pair;
  const stub = wholeReportNode(cg, () => !pair.confirm);
  const io = reportsOver(stub.api);
  [pair] = io.pairs(4, wholeReport(cg, stub.started), [node], 'kept', { from: stub.started, fromWhat: 'start of the promotions', bound: Infinity });
  const handle = io.watch([pair]);
  await handle.readOnce();
  handle.close();
  await handle.done;
  assert.match(pairOutcome(handle.pairs[0], { boundMs: 600 }).text, /: in shared memory at every reading, then MISSING from the shared-working-memory view of reports and from the cross-partition read when the 0 s had passed$/);
});

test('a pending watch reads from before the promotion and starts its bound when armed; a refused promotion cancels it', async () => {
  const cg = '0xabc/one-graph-main-1';
  // The node holds the report in Verified Memory from 80 ms on; the promotion's answer comes at 200 ms.
  const started = Date.now();
  const rows = [{ p: RDF_TYPE, o: 'urn:one-graph:Report' }, { p: LABEL, o: '"r (1)"' }, { p: BODY, o: '"report 1 of run S: payload"' }];
  const vmGraph = `did:dkg:context-graph:${cg}/reports/_verifiable_memory/1`;
  const api = async (_node, _method, _path, body) => {
    const inVm = Date.now() - started >= 80;
    const bindings = body.view === 'verifiable-memory' ? (inVm ? rows : [])
      : body.view === 'shared-working-memory' ? (inVm ? [] : rows)
        : (inVm ? rows.map(row => ({ g: vmGraph, ...row })) : rows.map(row => ({ g: `${sharedMemoryScope(cg, 'reports')}/0xaa/1`, ...row })));
    return { status: 200, json: null, text: JSON.stringify({ result: { type: 'bindings', bindings } }) };
  };
  const io = reportsOver(api);
  const record = wholeReport(cg, started - 60_000);
  const options = { pending: true, notBefore: started, fromWhat: 'promotion', everyMs: 20, bound: 400 };
  const handle = io.watch([...io.pairs(6, record, [node], 'vm', options), ...io.pairs(6, record, [node], 'gone', options)]);
  await new Promise(resolve => setTimeout(resolve, 200));
  const at = Date.now();
  handle.arm(at);
  await handle.done;
  const [vm, gone] = handle.pairs;
  assert.equal(vm.from, at);
  assert.deepEqual(vm.progress, { view: 0, partitions: 0 });
  assert.equal(pairOutcome(vm, { boundMs: 400 }).text, '"r (1)" by node8 (edgeA) in main/reports at node9 (edgeB): in Verified Memory 0 s after the promotion');
  assert.equal(pairOutcome(gone, { boundMs: 400 }).outcome, 'pass');
  // Dated before the answer, from the reads made since the promotion was sent.
  const window = arrivalWindow(vm.dating);
  assert.ok(window.after >= started && window.after < started + 80 && window.by >= started + 80 && window.by < at, JSON.stringify({ window, started, at }));
  // A refused promotion: the watch is cancelled and ends without a bound.
  const refused = io.watch(io.pairs(6, record, [node], 'vm', options));
  refused.cancel();
  await refused.done;
  assert.equal(refused.pairs[0].from, null);
});

test('a refused publish fails at any reading that finds the report in Verified Memory, even before the answer and though it is gone later', { timeout: 10_000 }, async () => {
  const cg = '0xabc/one-graph-main-1';
  const vmGraph = `did:dkg:context-graph:${cg}/reports/_verifiable_memory/1`;
  const rows = [{ p: RDF_TYPE, o: 'urn:one-graph:Report' }, { p: LABEL, o: '"r (1)"' }, { p: BODY, o: '"report 1 of run S: payload"' }];
  const watched = async inVmUntil => {
    const started = Date.now();
    const api = async (_node, _method, _path, body) => {
      const inVm = Date.now() - started < inVmUntil;
      const bindings = body.view === 'verifiable-memory' ? (inVm ? rows : [])
        : body.view ? [] : (inVm ? rows.map(row => ({ g: vmGraph, ...row })) : []);
      return { status: 200, json: null, text: JSON.stringify({ result: { type: 'bindings', bindings } }) };
    };
    const io = reportsOver(api);
    // Watched from before the publish is sent, armed when its refusal comes at 150 ms.
    const handle = io.watch(io.pairs(3, wholeReport(cg, started - 60_000), [node], 'unpublished', { pending: true, fromWhat: 'own publish', bound: 300, everyMs: 20 }));
    await new Promise(resolve => setTimeout(resolve, 150));
    handle.arm(Date.now());
    await handle.done;
    return pairOutcome(handle.pairs[0], { boundMs: 300 });
  };
  // In Verified Memory for the first 80 ms, then removed: the side effect was seen, so the check fails.
  const seen = await watched(80);
  assert.equal(seen.outcome, 'fail');
  assert.match(seen.text, /: FOUND in (the verifiable-memory view of reports|the cross-partition read) \(3 row\(s\) of it\) 0 s after the own publish, though it must never be in Verified Memory$/);
  // Never in Verified Memory: it holds.
  const never = await watched(0);
  assert.equal(never.outcome, 'pass');
  assert.match(never.text, /: absent from Verified Memory at every reading from the own publish to the end of the 0 s$/);
});

test('a report the curator did not select fails at any reading that finds it in Verified Memory, though it is still in shared memory', { timeout: 10_000 }, async () => {
  const cg = '0xabc/one-graph-main-1';
  const rows = [{ p: RDF_TYPE, o: 'urn:one-graph:Report' }, { p: LABEL, o: '"r (1)"' }, { p: BODY, o: '"report 1 of run S: payload"' }];
  const placed = async inVm => {
    const started = Date.now();
    const api = async (_node, _method, _path, body) => {
      const swmRows = rows;
      const vmRows = inVm ? rows : [];
      const bindings = body.view === 'shared-working-memory' ? swmRows
        : body.view === 'verifiable-memory' ? vmRows
          : [...swmRows.map(row => ({ g: `${sharedMemoryScope(cg, 'reports')}/0xaa/1`, ...row })), ...vmRows.map(row => ({ g: `did:dkg:context-graph:${cg}/reports/_verifiable_memory/1`, ...row }))];
      return { status: 200, json: null, text: JSON.stringify({ result: { type: 'bindings', bindings } }) };
    };
    const io = reportsOver(api);
    const record = wholeReport(cg, started - 60_000);
    const options = { from: started, fromWhat: 'start of the promotions', bound: 200 };
    const handle = io.watch([...io.pairs(4, record, [node], 'kept', options), ...io.pairs(4, record, [node], 'unpromoted', options)]);
    await handle.done;
    return handle.pairs.map(pair => pairOutcome(pair, { boundMs: 200 }));
  };
  // Carried into Verified Memory by another report's promotion, and still in shared memory: the shared-memory check holds, the other fails.
  const [kept, leaked] = await placed(true);
  assert.equal(kept.outcome, 'pass');
  assert.equal(leaked.outcome, 'fail');
  assert.match(leaked.text, /: FOUND in (the verifiable-memory view of reports|the cross-partition read) \(3 row\(s\) of it\) 0 s after the start of the promotions, though it must never be in Verified Memory$/);
  // Only in shared memory: both hold.
  const [keptOnly, absent] = await placed(false);
  assert.deepEqual([keptOnly.outcome, absent.outcome], ['pass', 'pass']);
  assert.match(absent.text, /: absent from Verified Memory at every reading from the start of the promotions to the end of the 0 s$/);
});

test('a report that arrives in the last interval before the deadline is read in time: the last interval is shortened', { timeout: 10_000 }, async () => {
  const cg = '0xabc/one-graph-main-1';
  // Reads every 100 ms with a bound of 500 ms; the report reaches the node at 430 ms, after the read at 400 ms.
  const stub = wholeReportNode(cg, age => age >= 430);
  const io = reportsOver(stub.api);
  const handle = io.watch(io.pairs(2, wholeReport(cg, stub.started), [node], 'swm', { from: stub.started, bound: 500, everyMs: 100 }));
  await handle.done;
  const [pair] = handle.pairs;
  const result = pairOutcome(pair, { boundMs: 500 });
  assert.equal(result.outcome, 'pass', result.text);
  // Found by a read that went out after the report arrived and came back before the deadline.
  assert.ok(pair.dating.view.hit.sentAt - stub.started >= 430 && pair.dating.view.hit.completedAt - stub.started < 500, JSON.stringify(pair.dating.view));
});

test('case 4 watches each candidate until its own promotion: a promotion that carries another candidate into Verified Memory fails', { timeout: 15_000 }, async () => {
  const cg = '0xabc/one-graph-main-1';
  const vmGraph = `did:dkg:context-graph:${cg}/reports/_verifiable_memory/1`;
  const swmGraph = `${sharedMemoryScope(cg, 'reports')}/0xaa/1`;
  const layers = new Map();
  const rowsOf = n => [{ p: RDF_TYPE, o: 'urn:one-graph:Report' }, { p: LABEL, o: `"r (${n})"` }, { p: BODY, o: `"report ${n}"` }];
  const api = async (_node, _method, _path, body) => {
    const n = Number(/<urn:one-graph:R:(\d+)>/.exec(body.sparql)[1]);
    const { swm, vm } = layers.get(n);
    const bindings = body.view === 'shared-working-memory' ? (swm ? rowsOf(n) : [])
      : body.view === 'verifiable-memory' ? (vm ? rowsOf(n) : [])
        : [...(swm ? rowsOf(n).map(row => ({ g: swmGraph, ...row })) : []), ...(vm ? rowsOf(n).map(row => ({ g: vmGraph, ...row })) : [])];
    return { status: 200, json: null, text: JSON.stringify({ result: { type: 'bindings', bindings } }) };
  };
  const report = n => {
    layers.set(n, { swm: true, vm: false });
    return {
      author, graph: { key: 'main', id: cg, resolved: cg }, sub: 'reports', name: `og-r-${n}`, subject: `urn:one-graph:R:${n}`, value: `r (${n})`,
      doneAt: Date.now() - 60_000, error: null,
      triples: [{ name: 'class', predicate: RDF_TYPE, iri: 'urn:one-graph:Report' }, { name: 'value', predicate: LABEL, text: `r (${n})` }, { name: 'body', predicate: BODY, text: `report ${n}` }],
    };
  };
  const [a1, b1, c1, other] = [1, 2, 3, 4].map(report);
  const io = reportsOver(api);
  const outcomes = [];
  const settle = async handles => {
    const pairs = await settled(handles);
    for (const pair of pairs) outcomes.push({ value: pair.record.value, kind: pair.kind, ...pairOutcome(pair, { boundMs: 600 }) });
    return pairs;
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  // Promoting a1 also carries b1 into Verified Memory, leaving it in shared memory until its own promotion.
  const promote = async record => {
    if (record === a1) {
      layers.set(1, { swm: false, vm: true });
      layers.set(2, { swm: true, vm: true });
      await wait(150);
    } else {
      layers.set(Number(record.subject.split(':').at(-1)), { swm: false, vm: true });
      await wait(50);
    }
    return Date.now();
  };
  const { promoted } = await promotionRound({ io, caseId: 4, nodes: [node], candidates: [a1, b1, c1], others: [other], promote, settle });
  assert.deepEqual(promoted.map(record => record.value), ['r (1)', 'r (2)', 'r (3)']);
  const failed = outcomes.filter(outcome => outcome.outcome === 'fail');
  // b1, watched until its own promotion, was seen in Verified Memory before it was selected.
  assert.equal(failed.length, 1, JSON.stringify(failed));
  assert.deepEqual([failed[0].value, failed[0].kind], ['r (2)', 'unpromoted']);
  assert.match(failed[0].text, /: FOUND in .* after the start of the promotions, though it must never be in Verified Memory$/);
  // Everything else holds: the other report, each candidate until its promotion, and every promotion's placement.
  assert.ok(outcomes.some(outcome => outcome.value === 'r (4)' && outcome.kind === 'unpromoted' && outcome.outcome === 'pass'));
  assert.ok(outcomes.some(outcome => outcome.value === 'r (2)' && outcome.kind === 'kept' && outcome.outcome === 'pass'));
  assert.ok(['r (1)', 'r (2)', 'r (3)'].every(value => outcomes.some(outcome => outcome.value === value && outcome.kind === 'vm' && outcome.outcome === 'pass')));
});
