import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { parseStudioCapability } from '../../../packages/studio-contracts/dist/studio-evidence.js';

/** Exercise the native HTTP handler without opening a listener. */
export async function verifyInventory(root, state, descriptor, savedWorkflow) {
  const { createCapabilityBridge } = await import(
    pathToFileURL(join(root, 'examples/n8n-capability/bridge.mjs'))
  );
  const owner = '0x1111111111111111111111111111111111111111',
    graphId = 'private';
  const sha = 'a'.repeat(64),
    kaRef = 'urn:demo:n8n:component:edit-fields:unit';
  const payloadRow = (graph, entry, value) => ({
    g: `did:dkg:context-graph:${graph}/_working_memory/${owner}/1`,
    entry,
    payload: { value: JSON.stringify(value) },
  });
  let failure = 'query',
    saves = 0,
    sourceReads = 0;
  const assets = new Map(),
    mutations = [];
  const recipeRows = [];
  const bridge = createCapabilityBridge({
    owner,
    graphId,
    config: {},
    definitions: [{ kind: 'component', kaRef, descriptor }],
    studioOptions: { state: join(state, 'inventory-test') },
    agent: {
      assertion: {
        history: async (_graph, name) => assets.get(name)?.history,
        create: async (graph, name, lane) => {
          assert.equal(graph, graphId);
          assert.equal(lane.agentAddress, owner);
          mutations.push('create');
          assets.set(name, { history: { memoryLayer: 'WM' }, quads: [] });
        },
        query: async (_graph, name) => assets.get(name)?.quads ?? [],
        write: async (graph, name, quads, lane) => {
          assert.equal(graph, graphId);
          assert.equal(lane.agentAddress, owner);
          mutations.push('write');
          assets.get(name).quads.push(...quads);
        },
        finalize: async (graph, name, lane) => {
          assert.equal(graph, graphId);
          assert.equal(lane.authorAgentAddress, owner);
          mutations.push('finalize');
          assets.get(name).history.wmCurrentAssertion = 'sealed-' + name;
          for (const quad of assets.get(name).quads)
            recipeRows.push(payloadRow(graphId, quad.subject, JSON.parse(JSON.parse(quad.object))));
        },
      },
      query: async (query) => {
        if (query.includes('#workflowComponent')) {
          if (failure === 'query') throw Error('Recipe query unavailable');
          if (failure === 'none') return { bindings: recipeRows };
          return {
            bindings: [
              payloadRow(graphId, 'urn:nos:component:workflow:' + sha, { schemaVersion: 1 }),
            ],
          };
        }
        return { bindings: [{ program: kaRef }] };
      },
    },
    client: {
      programs: {
        listApprovals: async () => [],
        getSource: async () => ({
          sourceHash: sha,
          authorAgentAddress: owner,
          label: 'Edit Fields',
          version: '1.0.0',
        }),
        getApproval: async () => ({
          binding: {
            enabled: true,
            n8n: {},
            contextGraphId: graphId,
            operationIri: kaRef,
            executorAgentAddress: owner,
            allowedCallerAgentAddresses: [owner],
            program: {
              contextGraphId: graphId,
              programIri: kaRef,
              programLayer: 'wm',
              sourceHash: sha,
              authorAgentAddress: owner,
            },
          },
        }),
      },
    },
  });
  bridge.studio.list = async () => [savedWorkflow];
  bridge.studio.get = async (ref, hash) => {
    sourceReads++;
    assert.equal(ref, savedWorkflow.kaRef);
    assert.equal(hash, savedWorkflow.sourceHash);
    return { workflow: { ...savedWorkflow, approved: true, mode: 'action' } };
  };
  bridge.studio.save = async () => {
    saves++;
    throw Error('Must not reach native save');
  };
  async function request(path, value, authorization = 'Bearer l1-owner-a') {
    let status, body;
    const req = {
      method: value ? 'POST' : 'GET',
      url: path,
      headers: { authorization },
      async *[Symbol.asyncIterator]() {
        if (value) yield JSON.stringify(value);
      },
    };
    await bridge.handle(
      req,
      {
        writeHead: (code) => {
          status = code;
        },
        end: (value) => {
          body = JSON.parse(value);
        },
      },
      path,
    );
    return { status, body };
  }
  try {
    for (failure of ['query', 'malformed']) {
      const response = await request('/spike/ka/accounts/account-a/capabilities/studio');
      assert.equal(response.status, 200);
      assert.equal(response.body.capabilities.length, 1);
      assert.equal(response.body.capabilities[0].kaRef, kaRef);
      assert.deepEqual(response.body.capabilities.map(parseStudioCapability), response.body.capabilities);
      assert.throws(() => parseStudioCapability({ ...response.body.capabilities[0], kaRef: 'urn:unknown:component:edit-fields' }));
      assert.deepEqual(response.body.workflows, [savedWorkflow]);
      const parent = {
        ...savedWorkflow.definition,
        nodes: [
          {
            ...savedWorkflow.definition.nodes[0],
            componentId: 'workflow-component',
            kaRef: 'urn:nos:component:workflow:' + sha,
            sourceHash: sha,
          },
        ],
      };
      const denied = await request('/spike/ka/accounts/account-a/capabilities/studio/save', parent);
      assert.equal(denied.status, 400);
      assert.equal(denied.body.code, 'INVALID_WORKFLOW');
      assert.equal(saves, 0);
    }
    failure = 'none';
    const route = '/spike/ka/accounts/account-a/capabilities/studio/components';
    const value = {
      kaRef: savedWorkflow.kaRef,
      sourceHash: savedWorkflow.sourceHash,
      name: 'Published through HTTP',
      inputs: [
        {
          name: 'fields',
          label: 'Fields',
          required: true,
          nodeId: savedWorkflow.definition.entryId,
          parameter: 'fields',
        },
      ],
      outputs: [{ name: 'result', nodeId: savedWorkflow.definition.entryId, output: 0 }],
    };
    for (const authorization of ['Bearer l1-viewer-a', 'Bearer unknown', '']) {
      const before = sourceReads;
      const denied = await request(route, value, authorization);
      assert.equal(denied.status, 403);
      assert.equal(sourceReads, before, 'Unauthorized publication must not read a workflow');
      assert.equal(mutations.length, 0, 'Unauthorized publication must not persist a recipe');
    }
    const published = await request(route, value);
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.descriptor.id, 'workflow-component');
    assert.equal(published.body.available, true);
    assert.equal(published.body.name, value.name);
    assert.deepEqual(published.body.reusable.inputs[0].targets, [
      { nodeId: value.inputs[0].nodeId, parameter: 'fields' },
    ]);
    assert.deepEqual(mutations, ['create', 'write', 'finalize']);
    assert.equal(recipeRows.length, 1);
    const recipe = JSON.parse(recipeRows[0].payload.value);
    assert.deepEqual(recipe, published.body.reusable);
    assert.equal(
      published.body.sourceHash,
      createHash('sha256').update(JSON.stringify(recipe)).digest('hex'),
    );
    const inventory = await request('/spike/ka/accounts/account-a/capabilities/studio');
    assert.equal(inventory.status, 200);
    assert.deepEqual(inventory.body.capabilities.map(parseStudioCapability), inventory.body.capabilities);
    assert.deepEqual(
      inventory.body.capabilities.find((c) => c.kaRef === published.body.kaRef),
      published.body,
    );
    assert.equal(saves, 0, 'Publication must not save or execute a native workflow');
  } finally {
    bridge.close();
  }
}
