import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStudioFixtureContext } from './test-support/studio-service-fixture.mjs';
import { dkgComponentStore } from './dkg-components.mjs';
import { invocationInput } from './studio-inputs.mjs';
import { runInput, readOnlyDefinition } from './studio-mcp-contract.mjs';
import { nativeInputDigest } from './studio-native-execution.mjs';

const choice = (label, options) => ({ type: 'string', label, default: options[0], options, maxLength: 256 });
function fixture() {
  const effects = [];
  const graphs = ['graph-a', 'graph-b', 'revoked-graph'];
  const profile = {
    id: 'named-dkg-fixture', revision: 'c'.repeat(64), node: 'fixture-node',
    accountId: 'account-fixture', requiresNosActor: true,
    async authorize(actor) { assert.equal(actor.accountId, this.accountId); },
    workflowTools: {
      effect: 'read', readGraphs: ['graph-a'],
      validateArguments(args) { assert.deepEqual(Object.keys(args).sort(), ['graph', 'selector']); },
    },
    operations: {
      'dkg-read': {
        enabled: () => true,
        parameters: { node: choice('Node', ['fixture-node']), contextGraph: choice('Graph', graphs), dataset: choice('Selector', ['a', 'b']) },
        validateInput() {},
        validateNode(node) {
          if (node.params.node !== 'fixture-node' || !graphs.slice(0, 2).includes(node.params.contextGraph)) throw Error('Graph access revoked');
        },
        readRequest: node => ({ graph: node.params.contextGraph, selector: node.params.dataset }),
        readItems: (_rows, result) => result.records,
        async transport(request, { actor }) {
          effects.push({ kind: 'read', request, actor });
          return { ...request, records: [{ selector: request.selector }] };
        },
      },
      'dkg-write': {
        enabled: () => true,
        parameters: { node: choice('Node', ['fixture-node']), contextGraph: choice('Graph', ['target']) },
        targetGraph: 'target',
        validateInput() {},
        validateNode(node) { assert.equal(node.params.contextGraph, 'target'); },
        evidence(rows, context, read) {
          return { payload: { contextGraphId: 'target', digest: 'd'.repeat(64), name: context.invocationId, records: rows, sourceGraph: read.graph }, recordCount: rows.length };
        },
        async transport(request, { actor }) {
          effects.push({ kind: 'write', request, actor });
          return { ...request, readbackVerified: true, metadata: { status: 'wm-sealed', reservedUal: 'did:dkg:fixture:1' } };
        },
      },
    },
  };
  const f = createStudioFixtureContext(profile);
  const definition = f.definition(['dkg-read', 'dkg-write'], [[0, 0, 1, 0]]);
  definition.inputs = [
    { name: 'graph', label: 'Graph', required: true, spec: profile.operations['dkg-read'].parameters.contextGraph, targets: [{ nodeId: 'n0', parameter: 'contextGraph' }] },
    { name: 'selector', label: 'Selector', required: true, spec: profile.operations['dkg-read'].parameters.dataset, targets: [{ nodeId: 'n0', parameter: 'dataset' }] },
  ];
  return { ...f, profile, graph: definition, effects };
}

test('DKG resolves only confirmed invocation arguments, keeps account authority and replays exact read/write receipts', async t => {
  const f = fixture(), { compiler, registry } = f.context;
  const compiled = compiler.compileStudio(f.graph, { graphId: 'fixture', owner: 'fixture', headerCredential: { id: 'fixture', name: 'Fixture' } });
  const source = compiler.studioProgramSource(compiled);
  const saved = compiler.readStudio(source);
  assert.deepEqual(saved.definition.inputs, f.graph.inputs);
  const workflow = { definition: saved.definition, kaRef: saved.kaRef, sourceHash: 'b'.repeat(64) };
  const original = JSON.stringify(workflow);
  const actor = { id: 'owner', role: 'owner', accountId: f.profile.accountId };
  const base = { itemsJson: '[{}]', paramsJson: JSON.stringify(f.graph.nodes[0].params), executionId: '' };
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const store = dkgComponentStore(db, f.profile);
  const admitted = values => invocationInput(f.graph, values, base, registry);
  const scope = invocationId => ({ invocationId, revisionDigest: workflow.sourceHash });
  assert.throws(() => store.grant(workflow, scope('invalid'), admitted({ graph: 'revoked-graph', selector: 'a' }), actor), /revoked/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dkg_component_runs').get().n, 0);
  assert.equal(f.effects.length, 0);
  const packets = [];
  for (const [i, graph] of ['graph-a', 'graph-b'].entries()) {
    const input = admitted({ graph, selector: i ? 'b' : 'a' }), journal = scope('manual-' + i);
    packets.push(input);
    store.grant(workflow, journal, input, actor);
    store.grant(workflow, journal, input, actor);
    assert.throws(() => store.grant(workflow, journal, admitted({ graph, selector: i ? 'a' : 'b' }), actor), /different/);
    assert.throws(() => store.grant(workflow, journal, input, { ...actor, accountId: 'other' }), /owner|account/);
    const request = { effectId: 'effect-' + i, workflowId: 'native1', executionId: String(40 + i), blockId: 'n0', items: [{}] };
    const confirmed = { invocationId: request.effectId, input };
    const before = f.effects.length;
    await assert.rejects(store.call(request, workflow, journal, 'native1', {
      ...confirmed, input: { ...input, argumentsJson: '{"graph":"revoked-graph","selector":"a"}' },
    }), /exact input/);
    assert.equal(f.effects.length, before);
    const read = await store.call(request, workflow, journal, 'native1', confirmed);
    assert.equal(f.effects.at(-1).request.graph, graph);
    const write = { ...request, blockId: 'n1', items: read.items.map(row => ({ ...row, contextGraphId: 'forged-destination' })) };
    const result = await store.call(write, workflow, journal, 'native1', confirmed);
    assert.equal(result.items[0].contextGraphId, 'target');
    assert.equal(f.effects.at(-1).request.sourceGraph, graph);
    const count = f.effects.length;
    assert.deepEqual(await store.call(write, workflow, journal, 'native1', confirmed), result);
    assert.equal(f.effects.length, count);
    assert.equal(JSON.stringify(workflow), original);
    assert.equal(compiler.studioProgramSource(compiled), source);
  }
  assert.notEqual(nativeInputDigest(packets[0]), nativeInputDigest(packets[1]));
  assert.equal(f.effects.filter(e => e.kind === 'write').length, 2);
});

test('named agent arguments use the selected registry and the resolved read graph allowlist', () => {
  const f = fixture(), { compiler } = f.context;
  const definition = { ...f.graph, nodes: [f.graph.nodes[0]], edges: [] };
  readOnlyDefinition(definition, compiler);
  const workflow = { definition, kaRef: 'urn:fixture:read', grant: { workflowSha256: 'e'.repeat(64) } };
  const request = { kaRef: workflow.kaRef, workflowSha256: workflow.grant.workflowSha256, runKey: 'agent-named', arguments: { graph: 'graph-a', selector: 'b' } };
  const input = runInput(request, workflow, compiler);
  assert.deepEqual(JSON.parse(input.argumentsJson), request.arguments);
  assert.deepEqual(JSON.parse(input.itemsJson), [request.arguments]);
  assert.throws(() => runInput({ ...request, arguments: { ...request.arguments, graph: 'graph-b' } }, workflow, compiler), { code: 'STUDIO_INVALID_ARGUMENTS' });
  assert.throws(() => runInput({ ...request, arguments: { ...request.arguments, extra: true } }, workflow, compiler), { code: 'STUDIO_INVALID_ARGUMENTS' });
});
