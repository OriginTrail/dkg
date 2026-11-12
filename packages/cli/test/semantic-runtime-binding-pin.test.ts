import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupRuntimeFixtures, toolFixture, request, graph, caller } from './_helpers/semantic-runtime-api-fixture.js';
afterEach(cleanupRuntimeFixtures);
async function setup() {
  const f = await toolFixture('export function run(input) { return { result: input.a - input.b }; }', { graphId: graph }, []);
  await f.approve();
  const inspect = await request(f.target, 'owner', 'GET', '/api/programs/bindings?contextGraphId=' + graph + '&operationIri=' + encodeURIComponent(f.operation.operationIri));
  const invoke = (pin: unknown, id = randomUUID()) => request(f.target, 'caller', 'POST', '/api/programs/execute', {
    contextGraphId: graph, operationIri: f.operation.operationIri, invocationId: id,
    inputs: [{ a: 8, b: 3 }], expectedBindingDigest: pin,
  });
  return { ...f, pin: inspect.body.bindingDigest, invoke };
}
it('executes the pinned Program and replays its receipt without executing twice', async () => {
  const f = await setup(), id = randomUUID();
  const execute = vi.spyOn(f.target.runtime!.typescript!, 'execute');
  const first = await f.invoke(f.pin, id);
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ persisted: true, bindingDigest: f.pin });
  expect(JSON.parse(first.body.outputs[0])).toEqual({ result: 5 });
  expect((await f.invoke(f.pin, id)).body.outputs).toEqual(first.body.outputs);
  expect(execute).toHaveBeenCalledTimes(1);
});
it('refuses a replaced approval before any guest execution', async () => {
  const f = await setup();
  const current = await f.manager.programs.getApproval(f.operation);
  await f.manager.programs.updateApproval({ ...f.permissions, ...f.operation, program: f.program, allowedCallers: [caller], typescript: { children: [] }, expectedRevision: current.revision });
  const execute = vi.spyOn(f.target.runtime!.typescript!, 'execute');
  const result = await f.invoke(f.pin);
  expect(result.status).toBe(409);
  expect(result.body.code).toBe('PROGRAM_BINDING_CHANGED');
  expect(execute).not.toHaveBeenCalled();
});
it.each([null, '', 'not-a-digest', 1])('rejects malformed pin %s', async pin => {
  const f = await setup();
  const result = await f.invoke(pin);
  expect(result.status).toBe(400);
  expect(result.body.code).toBe('INVALID_BINDING_DIGEST');
});
