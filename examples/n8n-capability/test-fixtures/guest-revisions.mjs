import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
/** Stable deployed compiler examples; baselines were captured from ca32f84 and the child extension at 962387a. */
export async function guestRevisionHashes(root = new URL('../', import.meta.url)) {
  const load = name => import(new URL(name, root));
  const hashes = {};
  for (const suffix of ['-v1', '']) {
    const registry = await load('component-registry' + suffix + '.mjs');
    const native = await load('component-workflows' + suffix + '.mjs');
    for (const descriptor of registry.componentRegistry.filter(c => c.id !== 'run-program')) {
      hashes['component' + suffix + '/' + descriptor.id] = hash(registry.componentProgramSource(descriptor.id));
      hashes['native' + suffix + '/' + descriptor.id] = hash(JSON.stringify(native.standaloneComponentWorkflow(descriptor.id, 'fixture-flow', { id: 'fixture', name: 'Fixture' })));
    }
  }
  const definition = { id: '123e4567-e89b-42d3-a456-426614174099', name: 'Frozen source', entryId: 'first', edges: [], nodes: [{
    id: 'first', componentId: 'filter', kaRef: 'urn:demo:n8n:component:filter:fixture', sourceHash: 'a'.repeat(64), params: { field: 'name', equals: 'Ana' }, x: 0, y: 0,
  }] };
  const options = { fixture: true, graphId: 'source-fixture', owner: '0x' + '1'.repeat(40) };
  const studio = await load('studio-definition.mjs'), legacy = await load('studio-definition-v1.mjs');
  const check = (name, compiled, generate) => {
    const source = generate(compiled), readback = studio.readStudio(source);
    hashes[name + '/source'] = hash(source); hashes[name + '/kaRef'] = readback.kaRef;
  };
  check('studio-v1', legacy.compileStudio(definition, options), legacy.studioProgramSource);
  const compiled = studio.compileStudio(definition, options);
  for (const compiler of [undefined, 4, 5]) check('studio-' + (compiler ?? 2), { ...compiled, compiler }, studio.studioProgramSource);
  const program = { ...definition.nodes[0], componentId: 'run-program', kaRef: 'urn:program:one', params: {
    operationIri: 'urn:operation:one', version: '1.0.0', inputMode: 'each-item', inputMapping: '{{ $json }}',
  } };
  check('program-v1', studio.compileStudio({ ...definition, nodes: [program] }), studio.studioProgramSource);
  return hashes;
}
