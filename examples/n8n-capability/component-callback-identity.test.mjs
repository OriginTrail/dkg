import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { componentPiece, standaloneComponentWorkflow } from './component-workflows.mjs';
import { createStudioContext } from './studio-context.mjs';
import profile from './test-support/measurement-profile.mjs';

const { registry } = createStudioContext({ profile });
const credential = { id: 'fixture', name: 'Fixture' }, credentials = { httpHeaderAuth: credential };
function callback(nodes) {
  const request = nodes.find(node => node.type === 'n8n-nodes-base.httpRequest');
  return JSON.parse(JSON.stringify(vm.runInNewContext(request.parameters.jsonBody.slice(3, -2), {
    $workflow: { id: 'native-workflow' }, $execution: { id: '42' }, $input: { all: () => [{ json: { value: 1 } }] },
    $: name => { assert.equal(name, 'Receive input'); return { first: () => ({ json: { body: { invocationId: 'effect-id' } } }) }; },
  })));
}
for (const id of ['dkg-read', 'invoke-dkg-program', 'dkg-write']) {
  test(id + ' callback ownership is independent of generated node names', () => {
    const options = { registry, credentials, blockId: 'saved_block' };
    for (const name of ['Block original_name', 'Renamed visible node']) {
      const piece = componentPiece(id, name, () => '', options);
      assert.deepEqual(callback(piece.nodes), { effectId: 'effect-id', workflowId: 'native-workflow', executionId: '42',
        blockId: 'saved_block', items: [{ value: 1 }] });
    }
    const standalone = standaloneComponentWorkflow(id, 'native-workflow', credential, { registry, credentials });
    assert.equal(callback(standalone.nodes).blockId, 'Component');
  });
}
test('DKG pieces require an explicit valid block identity', () => {
  for (const blockId of [undefined, '', 'run:read', 'Block read'])
    assert.throws(() => componentPiece('dkg-read', 'Block read', () => '', { registry, credentials, blockId }), /block identity required/);
});
