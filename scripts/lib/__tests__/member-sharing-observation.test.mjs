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
