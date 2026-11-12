import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createWorkflowComponents } from '../studio-components.mjs';

/** Actual native service/provider, with every persistence/remote-effect seam counted. */
export async function verifySourceBudget(root, runtime, descriptor, template) {
  const { createStudioProvider } = await import(
    pathToFileURL(join(root, 'examples/n8n-capability/studio-provider.mjs'))
  );
  const { createStudioService } = await import(
    pathToFileURL(join(root, 'examples/n8n-capability/studio-service.mjs'))
  );
  const effects = { repository: 0, native: 0, upload: 0, approval: 0 };
  const unexpected = (kind) => () => {
    effects[kind]++;
    throw Error('Unexpected ' + kind + ' effect');
  };
  const repository = new Proxy({}, { get: () => unexpected('repository') });
  const graphId = 'test',
    owner = 'owner';
  const provider = createStudioProvider({
    repository,
    config: { n8nNative: { workflows: [] } },
    graphId,
    owner,
    headerCredential: { id: 'fixture', name: 'fixture' },
    fetchImpl: unexpected('native'),
  });
  const native = { ...template.nodes[0], descriptor, available: true };
  const studio = createStudioService({
    graphId,
    owner,
    repository,
    provider,
    client: { programs: { upload: unexpected('upload'), approve: unexpected('approval') } },
    listCapabilities: async () => [native],
  });
  const source = {
    ...template,
    nodes: [
      {
        ...template.nodes[0],
        params: { ...template.nodes[0].params, fields: { text: 'x'.repeat(1800) } },
      },
    ],
  };
  const entries = Array.from({ length: 12 }, (_, i) => {
    const recipe = {
      schemaVersion: 1,
      name: 'Large recipe ' + i,
      workflow: { kaRef: 'urn:demo:nos:studio:large', sourceHash: 'a'.repeat(64) },
      definition: source,
      inputs: [],
      outputs: [{ name: 'result', nodeId: source.entryId, output: 0 }],
    };
    const sourceHash = createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
    return { kaRef: 'urn:nos:component:workflow:' + sourceHash, sourceHash, recipe };
  });
  const service = createWorkflowComponents({
    owner,
    graphId,
    agent: {
      query: async () =>
        entries.map((e) => ({ entry: e.kaRef, payload: JSON.stringify(e.recipe) })),
    },
    studio: {
      get: async () => ({ workflow: { approved: true, definition: source } }),
      save: studio.save,
    },
    capabilities: async () => [native],
    normalize: runtime.normalizeStudio,
    resultRows: (v) => v,
    literalValue: (v) => v,
    iriValue: (v) => v,
    programGraphAuthor: () => owner,
  });
  const parent = {
    ...template,
    entryId: 'instance0',
    nodes: entries.map((e, i) => ({
      id: 'instance' + i,
      componentId: 'workflow-component',
      kaRef: e.kaRef,
      sourceHash: e.sourceHash,
      params: {},
      x: 0,
      y: 0,
    })),
    edges: entries
      .slice(1)
      .map((_, i) => ({ from: 'instance' + i, output: 0, to: 'instance' + (i + 1), input: 0 })),
  };
  assert.ok(JSON.stringify(parent).length < 16384, 'Compact request fits the HTTP admission limit');
  try {
    await assert.rejects(
      service.save(parent, () => {}),
      (error) => error.code === 'INVALID_WORKFLOW' && /source limit/.test(error.message),
    );
    assert.deepEqual(effects, { repository: 0, native: 0, upload: 0, approval: 0 });
  } finally {
    studio.stop();
  }
  // A complete serialized source below the same limit still round-trips.
  const small = runtime.compileStudio(template, {
    graphId,
    owner,
    fixture: true,
    providerId: 'W'.repeat(80),
  });
  const text = runtime.studioProgramSource(small);
  assert.ok(text.length < 65536);
  assert.equal(runtime.readStudio(text).kaRef, small.kaRef);
}
