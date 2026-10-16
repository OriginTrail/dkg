import assert from 'node:assert/strict';
import test from 'node:test';
import { createObservation } from '../member-sharing/observation.mjs';

const LABEL = 'urn:issue3251:label';
const answer = rows => {
  const body = { result: { bindings: rows } };
  return { status: 200, json: body, text: JSON.stringify(body) };
};
const until = async (condition, ms = 2000) => {
  for (const end = Date.now() + ms; !condition() && Date.now() < end;) await new Promise(resolve => { setTimeout(resolve, 10); });
  return condition();
};

test('the two reads of a pair are made at once, and each keeps the time it completed', async () => {
  // Every query waits until the test answers it.
  const asked = [];
  const devnet = { api: (node, method, path, body) => new Promise(resolve => { asked.push({ kind: body.view ? 'view' : 'partitions', at: Date.now(), resolve }); }) };
  const io = createObservation(devnet, { boundMs: 60_000, definitionMs: 90_000, syncedMs: 90_000, stamp: 'S', predicate: LABEL });
  const record = { graph: { id: 'g', resolved: 'g' }, sub: null, subject: 'urn:issue3251:S:1', value: 'owner live root (1)', doneAt: Date.now(), error: null };
  const handle = io.watch([{ caseId: 1, record, node: { number: 8, label: 'node8 (member1)' } }]);
  const [pair] = handle.pairs;
  // Both reads are asked before either answers.
  assert.ok(await until(() => asked.length === 2), `asked: ${asked.map(read => read.kind).join(', ')}`);
  assert.deepEqual(asked.map(read => read.kind).sort(), ['partitions', 'view']);
  // The cross-partition read answers first; the view is still outstanding and does not hold it back.
  asked.find(read => read.kind === 'partitions').resolve(answer([{ g: 'did:dkg:context-graph:g/_shared_memory/0xauthor/1', p: LABEL, o: '"owner live root (1)"' }]));
  assert.ok(await until(() => pair.progress.partitions !== null));
  assert.equal(pair.progress.view, null);
  await new Promise(resolve => { setTimeout(resolve, 30); });
  asked.find(read => read.kind === 'view').resolve(answer([{ p: LABEL, o: '"owner live root (1)"' }]));
  await handle.done;
  assert.ok(pair.progress.view > pair.progress.partitions, JSON.stringify(pair.progress));
  // A read that found the write is not made again.
  assert.equal(asked.length, 2);
});

test('a slow read of one kind does not hold back the retries of the other (the example of the review)', async () => {
  // A 4 s bound. The view answers empty at first and holds the write from 100 ms on; the cross-partition read
  // takes 2.5 s to answer.
  const start = Date.now();
  const asked = [];
  const devnet = {
    async api(node, method, path, body) {
      const kind = body.view ? 'view' : 'partitions';
      asked.push(kind);
      if (kind === 'view') return answer(Date.now() - start >= 100 ? [{ p: LABEL, o: '"owner live root (1)"' }] : []);
      await new Promise(resolve => { setTimeout(resolve, 2500); });
      return answer([{ g: 'did:dkg:context-graph:g/_shared_memory/0xauthor/1', p: LABEL, o: '"owner live root (1)"' }]);
    },
  };
  const io = createObservation(devnet, { boundMs: 4_000, definitionMs: 90_000, syncedMs: 90_000, stamp: 'S', predicate: LABEL });
  const record = { graph: { id: 'g', resolved: 'g' }, sub: null, subject: 'urn:issue3251:S:1', value: 'owner live root (1)', doneAt: start, error: null };
  const handle = io.watch([{ caseId: 1, record, node: { number: 8, label: 'node8 (member1)' } }]);
  await handle.done;
  const { progress } = handle.pairs[0];
  // The view was asked again 2 s later, while the cross-partition read was still out; both hold within the bound.
  assert.ok(progress.view !== null && progress.view < 2500, JSON.stringify(progress));
  assert.ok(progress.partitions !== null && progress.partitions >= 2500 && progress.partitions < 4000, JSON.stringify(progress));
  assert.deepEqual(asked, ['view', 'partitions', 'view']);
});
