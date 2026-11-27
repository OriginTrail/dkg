import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { definition, environment } from './test-support/studio-service-fixture.mjs';

async function fixture(t, count) {
  const f = environment(); t.after(() => f.close());
  for (let index = 0; index < count; index++)
    await f.service.save({ ...definition(), id: randomUUID(), name: 'Saved workflow ' + index }, () => {});
  return f;
}
test('saved-workflow listing bounds metadata reads at four and retains repository order across unavailable revisions', { timeout: 10000 }, async t => {
  const f = await fixture(t, 8), order = f.repository.list(), gates = order.map(() => Promise.withResolvers());
  const first = Promise.withResolvers(), second = Promise.withResolvers(), calls = [];
  const original = f.client.programs.getSource, unavailable = new Map([[1, 'PROGRAM_NOT_FOUND'], [3, 'INVALID_WORKFLOW'], [5, 'WORKFLOW_CAPABILITY_CHANGED']]);
  let active = 0, peak = 0;
  t.after(() => { for (const gate of gates) gate.resolve(); });
  f.approvals.get(order[6]).binding.enabled = false;
  f.client.programs.getSource = async pin => {
    const index = order.indexOf(pin.programIri);
    calls.push(index); active++; peak = Math.max(peak, active);
    if (calls.length === 4) first.resolve();
    if (calls.length === 8) second.resolve();
    await gates[index].promise; active--;
    if (unavailable.has(index)) throw Object.assign(new Error('unavailable revision'), { code: unavailable.get(index) });
    return original(pin);
  };
  const listing = f.service.list();
  await first.promise;
  assert.deepEqual(calls, [0, 1, 2, 3]); assert.equal(active, 4);
  for (const index of [3, 2, 1, 0]) gates[index].resolve();
  await second.promise; assert.equal(active, 4);
  for (const index of [7, 6, 5, 4]) gates[index].resolve();
  const result = await listing;
  assert.equal(peak, 4); assert.equal(active, 0);
  assert.deepEqual(result.map(w => w.kaRef), order.filter((_, index) => !unavailable.has(index)));
  assert.equal(result.find(w => w.kaRef === order[6]).approved, false);
  assert.deepEqual(f.repository.list(), order, 'unavailable revisions retain their saved pins');
});
for (const method of ['getSource', 'getApproval'])
  test(`saved-workflow listing propagates unexpected ${method} failures`, async t => {
    const f = await fixture(t, 2), failure = Object.assign(new Error('metadata denied'), { status: 403 });
    f.client.programs[method] = async () => { throw failure; };
    await assert.rejects(f.service.list(), error => error === failure);
    assert.equal(f.repository.list().length, 2);
  });
