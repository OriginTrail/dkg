import test from 'node:test';
import { createHash } from 'node:crypto';
import { assertStudioSourceBudget, STUDIO_SOURCE_LIMIT } from './studio-source-budget.mjs';
import assert from 'node:assert/strict';
import { createWorkflowComponents } from './studio-components.mjs';
import { normalizeStudio } from './studio-definition.mjs';
import { environment, catalog } from './test-support/studio-service-fixture.mjs';
import {
  parseStudioDefinition,
  parseStudioGraph,
} from '../../packages/studio-contracts/dist/studio-evidence.js';
import { studioAuthoringDefinition } from '../../packages/studio-contracts/dist/studio-composition.js';
const sha = 'a'.repeat(64);
const native = {
  kaRef: 'urn:nos:component:set:pin',
  sourceHash: sha,
  available: true,
  descriptor: {
    id: 'edit-fields',
    input: 'items',
    sampleItems: [{}],
    outputs: ['main'],
    parameters: { fields: { type: 'json', label: 'Fields', default: {} } },
  },
};
const definition = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  name: 'Set fields',
  entryId: 'set',
  nodes: [
    {
      id: 'set',
      componentId: 'edit-fields',
      kaRef: native.kaRef,
      sourceHash: sha,
      params: { fields: { value: 1 } },
      x: 0,
      y: 0,
    },
  ],
  edges: [],
};
function fixture() {
  const leaf = structuredClone(native);
  const state = { obsolete: false, queryError: false };
  const queries = [],
    writes = [],
    reads = [];
  const rows = [];
  const saved = new Map();
  const original = {
    kaRef: 'urn:demo:nos:studio:original',
    sourceHash: sha,
    definition: structuredClone(definition),
    approved: true,
    mode: 'action',
  };
  saved.set(original.kaRef, original);
  let saves = 0;
  const service = createWorkflowComponents({
    owner: 'owner',
    graphId: 'private',
    agent: {
      query: async (...args) => {
        queries.push(args);
        if (state.queryError) throw Error('catalog offline');
        return rows;
      },
      assertion: { history: async () => [] },
    },
    studio: {
      get: async (ref, hash) => {
        reads.push({ ref, hash });
        await state.onRead?.();
        const workflow = saved.get(ref);
        if (!workflow || hash !== workflow.sourceHash) throw Error('wrong pin');
        return { workflow };
      },
      save: async (body) => {
        saves++;
        if (state.saveError) throw state.saveError;
        return { ...original, definition: body };
      },
    },
    capabilities: async () => [leaf],
    normalize: (d) => {
      if (state.obsolete && d.nodes.some((n) => n.params.profileRevision === 'old'))
        throw Error('Obsolete profile revision');
      return state.normalize ? state.normalize(d) : d;
    },
    persist: async (_a, _g, _name, _owner, quads, _h, _layer, authorize) => {
      writes.push({ graphId: _g, owner: _owner, layer: _layer });
      await authorize();
      const q = quads[0];
      rows.push({ g: 'trusted', entry: q.subject, payload: JSON.parse(q.object) });
    },
    resultRows: (v) => v,
    iriValue: (v) => v,
    literalValue: (v) => v,
    programGraphAuthor: (g) => (g === 'trusted' ? 'owner' : 'foreign'),
  });
  const request = {
    kaRef: original.kaRef,
    sourceHash: sha,
    name: 'Reusable set',
    inputs: [
      { name: 'fields', label: 'Fields', nodeId: 'set', parameter: 'fields', required: true },
    ],
    outputs: [{ name: 'result', nodeId: 'set', output: 0 }],
  };
  return {
    service,
    original,
    rows,
    request,
    saves: () => saves,
    saved,
    leaf,
    state,
    queries,
    writes,
    reads,
  };
}
test('publishes with readback; inventory reads DKG recipes; save resolves server-owned pins', async () => {
  const f = fixture(),
    c = await f.service.publish(f.request);
  assert.match(c.kaRef, /^urn:nos:component:workflow:/);
  assert.equal((await f.service.list())[0].available, true);
  const parent = {
    ...definition,
    nodes: [
      {
        ...definition.nodes[0],
        componentId: 'workflow-component',
        kaRef: c.kaRef,
        sourceHash: c.sourceHash,
        params: { fields: { value: 2 } },
      },
    ],
  };
  const result = await f.service.save(parent);
  assert.deepEqual(result.definition.nodes[0].params.fields, { value: 2 });
  assert.deepEqual(result.definition.composition.definition, parent);
  assert.equal(f.saves(), 1);
  await assert.rejects(f.service.save({ ...parent, composition: {} }), /snapshots/);
  f.original.approved = false;
  assert.equal((await f.service.list())[0].available, false);
  await assert.rejects(f.service.save(parent), { code: 'INVALID_WORKFLOW' });
  assert.equal(f.saves(), 1);
});
test('rejects catalog tampering, nonexistent fields and wrong output ports', async () => {
  const f = fixture();
  await assert.rejects(f.service.publish({ ...f.request, sourceHash: undefined }), /interface/);
  await assert.rejects(
    f.service.publish({ ...f.request, inputs: [{ ...f.request.inputs[0], parameter: 'missing' }] }),
    /parameter/,
  );
  await assert.rejects(
    f.service.publish({ ...f.request, outputs: [{ name: 'wrong', nodeId: 'set', output: 3 }] }),
    /output/,
  );
  await f.service.publish(f.request);
  const body = JSON.parse(f.rows[0].payload);
  body.name = 'tampered';
  f.rows[0].payload = JSON.stringify(body);
  await assert.rejects(f.service.list(), /integrity/);
});
test('DKG recipe ingestion validates the graph even when the content hash matches', async () => {
  const f = fixture();
  await f.service.publish(f.request);
  const recipe = JSON.parse(f.rows[0].payload);
  recipe.definition.entryId = 'missing';
  f.rows[0].payload = JSON.stringify(recipe);
  const hash = createHash('sha256').update(f.rows[0].payload).digest('hex');
  f.rows[0].entry = 'urn:nos:component:workflow:' + hash;
  await assert.rejects(f.service.list(), /could not be verified/);
  assert.equal(f.saves(), 0);
});
test('re-export flattens a component interface onto native fields, preserving original source pins', async () => {
  const f = fixture(),
    c = await f.service.publish(f.request);
  const authored = {
    ...definition,
    nodes: [
      {
        ...definition.nodes[0],
        componentId: 'workflow-component',
        kaRef: c.kaRef,
        sourceHash: c.sourceHash,
      },
    ],
  };
  const parent = await f.service.save(authored);
  parent.kaRef = 'urn:demo:nos:studio:parent';
  f.saved.set(parent.kaRef, parent);
  const nested = await f.service.publish({ ...f.request, kaRef: parent.kaRef });
  assert.equal(nested.reusable.definition.nodes[0].componentId, 'edit-fields');
  assert.equal(nested.reusable.inputs[0].targets[0].nodeId, 'wc1');
  assert.equal(nested.reusable.definition.nodes[0].sourceHash, sha);
});

test('obsolete profiles disable only the affected recipe and refuse its use', async () => {
  const f = fixture();
  const good = await f.service.publish(f.request);
  const oldSource = structuredClone(f.original);
  oldSource.kaRef = 'urn:demo:nos:studio:old';
  oldSource.definition.nodes[0].params.profileRevision = 'old';
  f.saved.set(oldSource.kaRef, oldSource);
  const obsolete = await f.service.publish({
    ...f.request,
    kaRef: oldSource.kaRef,
    name: 'Old profile',
  });
  f.state.obsolete = true;
  const listed = await f.service.list();
  assert.equal(listed.length, 2);
  assert.equal(listed.find((c) => c.kaRef === obsolete.kaRef).available, false);
  const parent = {
    ...definition,
    nodes: [
      {
        ...definition.nodes[0],
        componentId: 'workflow-component',
        kaRef: obsolete.kaRef,
        sourceHash: obsolete.sourceHash,
      },
    ],
  };
  await assert.rejects(f.service.save(parent), { code: 'INVALID_WORKFLOW' });
  assert.equal(f.saves(), 0);
  assert.equal(listed.find((c) => c.kaRef === good.kaRef).available, true);
});
test('publication and inventory inherit export authorization from the exact leaf', async () => {
  const f = fixture();
  f.leaf.requiresExportAuthorization = true;
  const published = await f.service.publish(f.request);
  assert.equal(published.requiresExportAuthorization, true);
  assert.deepEqual((await f.service.list())[0], published);
});
test('pins file input metadata and rejects changes to that trusted contract', async () => {
  const f = fixture();
  f.leaf.descriptor.input = 'file';
  f.leaf.descriptor.sampleItems = [{ file: { name: 'data.csv', data: 'YQo=' } }];
  const c = await f.service.publish(f.request);
  assert.equal(c.descriptor.input, 'file');
  assert.deepEqual(c.descriptor.sampleItems, f.leaf.descriptor.sampleItems);
  assert.deepEqual((await f.service.list())[0], c);
  f.leaf.descriptor.input = 'items';
  assert.equal((await f.service.list())[0].available, false);
});
test('keeps private scope and excludes foreign recipes from inventory and save', async () => {
  const f = fixture();
  const c = await f.service.publish(f.request);
  assert.deepEqual(f.writes, [{ graphId: 'private', owner: 'owner', layer: 'wm' }]);
  assert.ok(
    f.queries.every(
      ([, scope]) =>
        scope.contextGraphId === 'private' &&
        scope.view === 'working-memory' &&
        scope.callerAgentAddress === 'owner',
    ),
  );
  f.rows[0].g = 'foreign';
  assert.deepEqual(await f.service.list(), []);
  await assert.rejects(
    f.service.save({
      ...definition,
      nodes: [
        {
          ...definition.nodes[0],
          componentId: 'workflow-component',
          kaRef: c.kaRef,
          sourceHash: c.sourceHash,
        },
      ],
    }),
    /unavailable/,
  );
  assert.equal(f.saves(), 0);
});
test('automatic separate inputs stay separate while matching explicit names share targets', async () => {
  const f = fixture();
  f.original.definition.nodes.push({ ...definition.nodes[0], id: 'second' });
  f.original.definition.edges.push({ from: 'set', output: 0, to: 'second', input: 0 });
  const request = {
    ...f.request,
    inputs: [
      f.request.inputs[0],
      { ...f.request.inputs[0], nodeId: 'second', name: 'secondFields' },
    ],
    outputs: [{ name: 'result', nodeId: 'second', output: 0 }],
  };
  assert.equal((await f.service.publish(request)).reusable.inputs.length, 2);
  request.inputs[1].name = request.inputs[0].name;
  const c = await f.service.publish(request);
  assert.equal(c.reusable.inputs.length, 1);
  assert.deepEqual(
    c.reusable.inputs[0].targets.map((t) => t.nodeId),
    ['set', 'second'],
  );
});

test('preserves uncertainty from native persistence after successful composition admission', async () => {
  const f = fixture();
  const c = await f.service.publish(f.request);
  const error = new Error('Native persistence readback lost');
  f.state.saveError = error;
  await assert.rejects(
    f.service.save({
      ...definition,
      nodes: [
        {
          ...definition.nodes[0],
          componentId: 'workflow-component',
          kaRef: c.kaRef,
          sourceHash: c.sourceHash,
        },
      ],
    }),
    (e) => e === error && !e.code,
  );
  assert.equal(f.saves(), 1);
});

test('shared inputs ignore native labels but retain public labels, constraints and configured defaults', async () => {
  const f = fixture();
  f.leaf.descriptor.parameters.query = {
    type: 'json',
    label: 'Query',
    default: {},
    maxLength: 2048,
  };
  f.leaf.descriptor.parameters.headers = {
    type: 'json',
    label: 'Headers',
    default: {},
    maxLength: 2048,
  };
  f.original.definition.nodes[0].params = { fields: { value: 1 }, query: {}, headers: {} };
  const request = {
    ...f.request,
    inputs: ['query', 'headers'].map((parameter) => ({
      name: 'shared',
      label: 'Request options',
      nodeId: 'set',
      parameter,
      required: true,
    })),
  };
  const c = await f.service.publish(request);
  assert.equal(c.reusable.inputs.length, 1);
  const saved = await f.service.save({
    ...definition,
    nodes: [
      {
        ...definition.nodes[0],
        componentId: 'workflow-component',
        kaRef: c.kaRef,
        sourceHash: c.sourceHash,
        params: { shared: { token: 'value' } },
      },
    ],
  });
  assert.deepEqual(saved.definition.nodes[0].params.query, { token: 'value' });
  assert.deepEqual(saved.definition.nodes[0].params.headers, { token: 'value' });
  await assert.rejects(
    f.service.publish({
      ...request,
      inputs: [request.inputs[0], { ...request.inputs[1], label: 'Different public label' }],
    }),
    /matching labels/,
  );
  f.leaf.descriptor.parameters.headers.maxLength = 512;
  await assert.rejects(f.service.publish(request), /matching labels/);
  f.leaf.descriptor.parameters.headers.maxLength = 2048;
  f.original.definition.nodes[0].params.headers = { changed: true };
  await assert.rejects(f.service.publish(request), /matching labels/);
});

test('save resolves and checks each selected exact recipe once without fetching unrelated sources', async () => {
  const f = fixture();
  const selected = await f.service.publish(f.request);
  const otherSource = structuredClone(f.original);
  otherSource.kaRef = 'urn:demo:nos:studio:unrelated';
  f.saved.set(otherSource.kaRef, otherSource);
  await f.service.publish({ ...f.request, kaRef: otherSource.kaRef, name: 'Unrelated' });
  f.saved.delete(otherSource.kaRef);
  f.reads.length = 0;
  const authored = {
    ...definition,
    entryId: 'first',
    nodes: ['first', 'second'].map((id) => ({
      ...definition.nodes[0],
      id,
      componentId: 'workflow-component',
      kaRef: selected.kaRef,
      sourceHash: selected.sourceHash,
    })),
    edges: [{ from: 'first', output: 0, to: 'second', input: 0 }],
  };
  await f.service.save(authored);
  assert.deepEqual(f.reads, [{ ref: f.original.kaRef, hash: sha }]);
  assert.equal(f.saves(), 1);
  f.original.approved = false;
  await assert.rejects(f.service.save(authored), { code: 'INVALID_WORKFLOW' });
  assert.equal(f.saves(), 1);
  // Unrelated records still undergo integrity checking even though their sources are not fetched.
  const tampered = JSON.parse(f.rows[1].payload);
  tampered.name = 'changed';
  f.rows[1].payload = JSON.stringify(tampered);
  await assert.rejects(f.service.save(authored), /integrity/);
  assert.equal(f.saves(), 1);
});

test('enforces the complete serialized source limit at the exact readback boundary', () => {
  assert.equal(
    assertStudioSourceBudget('s'.repeat(STUDIO_SOURCE_LIMIT)).length,
    STUDIO_SOURCE_LIMIT,
  );
  assert.throws(() => assertStudioSourceBudget('s'.repeat(STUDIO_SOURCE_LIMIT + 1)), {
    code: 'INVALID_WORKFLOW',
    status: 400,
  });
});

test('resolves all recipe pins before starting independent admission checks concurrently', async () => {
  const f = fixture();
  const first = await f.service.publish(f.request);
  const second = await f.service.publish({ ...f.request, name: 'Second recipe' });
  const parent = {
    ...definition,
    entryId: 'instance0',
    nodes: [first, second, first].map((c, i) => ({
      ...definition.nodes[0],
      id: 'instance' + i,
      componentId: 'workflow-component',
      kaRef: c.kaRef,
      sourceHash: c.sourceHash,
    })),
    edges: [0, 1].map((i) => ({
      from: 'instance' + i,
      output: 0,
      to: 'instance' + (i + 1),
      input: 0,
    })),
  };
  f.reads.length = 0;
  const missing = structuredClone(parent);
  missing.nodes[1].sourceHash = 'f'.repeat(64);
  await assert.rejects(f.service.save(missing), { code: 'INVALID_WORKFLOW' });
  assert.equal(f.reads.length, 0);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.state.onRead = () => gate;
  const saving = f.service.save(parent);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      f.reads.length,
      2,
      'Distinct recipes begin admission without awaiting each other; duplicates are checked once',
    );
    assert.equal(f.saves(), 0);
  } finally {
    release();
  }
  const saved = await saving;
  assert.equal(f.saves(), 1);
  assert.deepEqual(
    saved.definition.composition.components.map((c) => c.kaRef),
    [first.kaRef, second.kaRef],
  );
});

test('publishes and saves aggregate defaults above 2 KiB while retaining native step limits', async () => {
  const f = fixture();
  f.original.definition.nodes = ['set', 'second'].map((id, i) => ({
    ...definition.nodes[0],
    id,
    params: { fields: { text: String(i).repeat(1200) } },
  }));
  f.original.definition.edges = [{ from: 'set', output: 0, to: 'second', input: 0 }];
  for (const node of f.original.definition.nodes)
    assert.ok(JSON.stringify(node.params).length < 2048);
  parseStudioGraph(f.original.definition);
  const c = await f.service.publish({
    ...f.request,
    inputs: ['set', 'second'].map((nodeId, i) => ({
      name: 'fields' + i,
      label: 'Fields ' + i,
      nodeId,
      parameter: 'fields',
      required: true,
    })),
    outputs: [{ name: 'result', nodeId: 'second', output: 0 }],
  });
  assert.equal((await f.service.list())[0].available, true);
  const parent = {
    ...definition,
    nodes: [
      {
        ...definition.nodes[0],
        componentId: 'workflow-component',
        kaRef: c.kaRef,
        sourceHash: c.sourceHash,
        params: Object.fromEntries(
          Object.entries(c.descriptor.parameters).map(([key, spec]) => [key, spec.default]),
        ),
      },
    ],
  };
  assert.ok(JSON.stringify(parent.nodes[0].params).length > 2048);
  assert.ok(JSON.stringify(parent).length < 16384);
  assert.deepEqual(parseStudioGraph(JSON.parse(JSON.stringify(parent)), true), parent);
  const saved = await f.service.save(parent);
  const reopened = parseStudioDefinition(JSON.parse(JSON.stringify(saved.definition)));
  assert.deepEqual(studioAuthoringDefinition(reopened), parent);
  assert.deepEqual(
    reopened.nodes.map((n) => n.params),
    f.original.definition.nodes.map((n) => n.params),
  );
  assert.equal(f.saves(), 1);
  // Compact admission permits the aggregate; expanded native admission still rejects one oversized leaf.
  const oversizedLeaf = structuredClone(parent);
  oversizedLeaf.nodes[0].params.fields0 = { text: 'x'.repeat(2048) };
  parseStudioGraph(oversizedLeaf);
  await assert.rejects(f.service.save(oversizedLeaf), { code: 'INVALID_WORKFLOW' });
  assert.equal(f.saves(), 1);
  const oversizedCompact = structuredClone(parent);
  oversizedCompact.nodes[0].params.fields0 = { text: 'x'.repeat(16384) };
  assert.throws(() => parseStudioGraph(oversizedCompact));
  await assert.rejects(f.service.save(oversizedCompact), { code: 'INVALID_WORKFLOW' });
  assert.equal(f.saves(), 1);
});

test('rejects malformed export requests before workflow or catalog reads', async () => {
  const f = fixture();
  for (const request of [
    null,
    { ...f.request, name: '' },
    { ...f.request, inputs: [null] },
    { ...f.request, inputs: [{ ...f.request.inputs[0], required: 'yes' }] },
    { ...f.request, outputs: [{ name: 'result', nodeId: 'set', output: -1 }] },
  ])
    await assert.rejects(f.service.publish(request), {
      code: 'INVALID_WORKFLOW_COMPONENT',
      status: 400,
    });
  assert.equal(f.reads.length, 0);
  assert.equal(f.queries.length, 0);
  assert.equal(f.writes.length, 0);
});

test('mixed native/reusable defaults survive native save and reopen', async () => {
  const f = fixture(), runtime = environment();
  try {
    f.state.normalize = normalizeStudio;
    f.leaf.descriptor = catalog.find(c => c.descriptor.id === 'edit-fields').descriptor;
    f.original.definition = normalizeStudio(f.original.definition);
    const component = await f.service.publish(f.request);
    const parent = { ...definition, name: ' Defaulted composition ', entryId: 'before',
      nodes: [
        { ...definition.nodes[0], id: 'before', params: {} },
        { ...definition.nodes[0], componentId: 'workflow-component', kaRef: component.kaRef,
          sourceHash: component.sourceHash, params: { fields: { city: 'Belgrade' } } },
      ], edges: [{ from: 'before', to: 'set', output: 0, input: 0 }],
      inputs: [{ name: 'keep', label: 'Keep fields', required: false,
        spec: { type: 'string', label: 'Keep fields', default: 'yes', maxLength: 256, options: ['yes', 'no'] },
        targets: [{ nodeId: 'before', parameter: 'keepInput' }] }] };
    const prepared = (await f.service.save(parent)).definition;
    assert.deepEqual(parent.nodes[0].params, {}, 'Admission must not mutate the submitted draft');
    assert.deepEqual(prepared.composition.definition.nodes[0].params, { fields: { team: 'DKG' }, keepInput: 'yes' });
    assert.equal(prepared.composition.definition.name, 'Defaulted composition');
    runtime.setCatalog([{ ...catalog.find(c => c.descriptor.id === 'edit-fields'), kaRef: native.kaRef }]);
    const saved = await runtime.service.save(prepared);
    runtime.restart();
    const reopened = (await runtime.service.get(saved.kaRef, saved.sourceHash)).workflow;
    assert.deepEqual(reopened.definition, prepared);
    assert.deepEqual(parseStudioDefinition(reopened.definition), prepared);
    assert.deepEqual(normalizeStudio(prepared), prepared);
    await runtime.service.run({ kaRef: saved.kaRef, sourceHash: saved.sourceHash, itemsJson: '[{}]',
      invocationId: '123e4567-e89b-42d3-a456-426614174021', arguments: {} });
    assert.equal(runtime.invocations.length, 1);
    const tampered = structuredClone(prepared);
    tampered.composition.definition.nodes[0].params.fields = { forged: true };
    assert.throws(() => parseStudioDefinition(tampered));
    assert.throws(() => normalizeStudio(tampered));
  } finally { runtime.close(); }
});
