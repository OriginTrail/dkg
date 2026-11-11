import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { programAdmission } from './studio-program-vm.mjs';
import { createHash } from 'node:crypto';
import { studioInputValidationSource } from '../../../packages/studio-contracts/dist/studio-inputs.js';
import { expandStudioComponents } from '../../../packages/studio-contracts/dist/studio-composition.js';

import { nativeExpression } from './studio-native-expression.mjs';
function parameter(compiled, name, key) {
  const node = compiled.workflow.nodes.find((node) => node.name === name);
  assert.ok(node, name);
  return node.parameters[key];
}

/** Native compiler/service/MCP journal; transports are isolated fixtures, no live services. */
export async function verifyInvocation(root) {
  // Golden hash from the previously shipped compiler-6 helper; source pins cannot drift.
  assert.equal(
    createHash('sha256').update(studioInputValidationSource()).digest('hex'),
    '659f658e310fc8dfe6fbbe92a21c7241125f4e43eaa3ed964594213893431e92',
  );
  const module = (name) => import(pathToFileURL(join(root, 'examples/n8n-capability', name)));
  const runtime = await module('studio-definition.mjs');
  const { invocationInput } = await module('studio-inputs.mjs');
  const { environment, definition, catalog, graphId, owner } = await module(
    'test-support/studio-service-fixture.mjs',
  );
  const { createStudioMcpService } = await module('studio-mcp-service.mjs');
  const f = environment();
  try {
    f.setCatalog(
      catalog.map((c) => ({
        ...c,
        kaRef: c.kaRef.replace('urn:demo:n8n:component:', 'urn:nos:component:'),
      })),
    );
    const graph = definition(['edit-fields', 'limit'], [[0, 0, 1, 0]]);
    graph.nodes.forEach((n) => {
      n.kaRef = n.kaRef.replace('urn:demo:n8n:component:', 'urn:nos:component:');
    });
    graph.inputs = [
      {
        name: 'fields',
        label: 'Fields',
        required: true,
        spec: { type: 'json', label: 'Fields', default: {}, maxLength: 2048 },
        targets: [{ nodeId: 'n0', parameter: 'fields' }],
      },
      {
        name: 'count',
        label: 'Count',
        required: false,
        spec: { type: 'integer', label: 'Count', default: 2, min: 1, max: 5 },
        targets: [{ nodeId: 'n1', parameter: 'count' }],
      },
    ];
    const saved = await f.service.save(graph);
    const source = f.sources.get(saved.kaRef).source;
    const compiled = runtime.readStudio(source);
    assert.equal(compiled.compiler, 9);
    assert.deepEqual(compiled.definition.inputs, graph.inputs);
    const pin = [
      saved.kaRef,
      saved.sourceHash,
      compiled.grant.workflowSha256,
      compiled.grant.workflowId,
    ];
    const nativeCreates = f.calls.filter(
      ([method, path]) => method === 'POST' && path === '/workflows',
    ).length;
    f.restart();
    assert.deepEqual(
      (await f.service.get(saved.kaRef, saved.sourceHash)).workflow.definition.inputs,
      graph.inputs,
    );
    const args = [{ fields: { city: 'Belgrade' } }, { count: 3, fields: { city: 'Ljubljana' } }];
    for (let i = 0; i < args.length; i++) {
      await f.service.run({
        kaRef: saved.kaRef,
        sourceHash: saved.sourceHash,
        itemsJson: '[{}]',
        invocationId: `123e4567-e89b-42d3-a456-42661417400${i}`,
        arguments: args[i],
      });
      assert.equal(f.sources.get(saved.kaRef).source, source);
      const current = runtime.readStudio(source);
      assert.deepEqual(
        [saved.kaRef, saved.sourceHash, current.grant.workflowSha256, current.grant.workflowId],
        pin,
      );
    }
    assert.equal(
      f.calls.filter(([method, path]) => method === 'POST' && path === '/workflows').length,
      nativeCreates,
    );
    assert.deepEqual(
      f.invocations.map((v) => JSON.parse(v.inputs[0].argumentsJson)),
      [
        { count: 2, fields: { city: 'Belgrade' } },
        { count: 3, fields: { city: 'Ljubljana' } },
      ],
    );
    const emitted = runtime.compileStudio(graph, { fixture: true, graphId, owner });
    for (const invocation of f.invocations) {
      const packet = invocation.inputs[0];
      const args = JSON.parse(packet.argumentsJson);
      // invocationParameters is consumed by normalize inside the emitted guard.
      // Observe JSON parsing without replacing or modifying any generated source.
      for (const node of graph.nodes) {
        const checked = nativeExpression(
          emitted, parameter(emitted, `Block ${node.id} check 0`, 'jsonOutput'),
          packet,
          { original: 'kept' },
        );
        const expected =
          node.componentId === 'limit'
            ? { ...node.params, count: args.count }
            : { ...node.params, fields: args.fields };
        assert.ok(
          checked.parsed.some((value) => JSON.stringify(value) === JSON.stringify(expected)),
        );
        assert.deepEqual(checked.result, { original: 'kept' });
      }
      assert.equal(
        nativeExpression(emitted, parameter(emitted, 'Block n1', 'maxItems'), packet).result,
        args.count,
      );
      assert.deepEqual(
        nativeExpression(emitted, parameter(emitted, 'Block n0', 'jsonOutput'), packet, { original: 'kept' })
          .result,
        graph.nodes[0].params.keepInput === 'yes'
          ? { original: 'kept', ...args.fields }
          : args.fields,
      );
    }

    const before = f.invocations.length;
    for (const argumentsValue of [{}, { fields: {}, count: 99 }, { fields: {}, extra: true }])
      await assert.rejects(
        f.service.run({
          kaRef: saved.kaRef,
          sourceHash: saved.sourceHash,
          itemsJson: '[{}]',
          invocationId: '123e4567-e89b-42d3-a456-426614174009',
          arguments: argumentsValue,
        }),
        { code: 'INVALID_WORKFLOW' },
      );
    assert.equal(f.invocations.length, before);

    const guest = programAdmission(source);
    const packet = f.invocations[0].inputs[0];
    assert.deepEqual(JSON.parse(JSON.stringify(guest.run(packet))), packet);
    assert.equal(guest.calls.length, 1);
    assert.throws(() => guest.run({ ...packet, argumentsJson: '{"fields":{},"count":99}' }));
    assert.equal(guest.calls.length, 1);
    assert.throws(
      () => invocationInput(compiled.definition, { fields: { x: 'x'.repeat(3000) } }, packet),
      /parameter|bounded|Fields/i,
    );

    let dispatches = 0;
    const actor = {
      id: 'owner',
      role: 'owner',
      accountId: 'test-account',
      startedBy: 'agent:test',
      agentVersion: 'v1',
      toolDigest: 'a'.repeat(64),
      approvalDecisionId: 'approved',
    };
    const mcp = createStudioMcpService({
      repository: f.repository,
      accountId: actor.accountId,
      profile: null,
      runner: {
        async prepare() {
          return 'version1';
        },
        async dispatch(_workflow, _key, input) {
          dispatches++;
          assert.ok(input.argumentsJson);
          return String(dispatches);
        },
        async inspect() {
          return { status: 'succeeded', output: { items: [], ports: {} } };
        },
      },
    });
    const request = {
      kaRef: saved.kaRef,
      workflowSha256: compiled.grant.workflowSha256,
      runKey: 'named-agent-one',
      arguments: args[0],
    };
    await mcp.run(request, actor);
    await mcp.run({ ...request, arguments: { fields: { city: 'Belgrade' }, count: 2 } }, actor);
    assert.equal(dispatches, 1);
    await assert.rejects(mcp.run({ ...request, arguments: args[1] }, actor), { code: 'STUDIO_RUN_KEY_CONFLICT' });
    assert.equal(dispatches, 1);
    await assert.rejects(mcp.run({ ...request, runKey: 'invalid', arguments: {} }, actor), {
      code: 'STUDIO_INVALID_ARGUMENTS',
    });
    assert.equal(f.repository.mcp.run(actor.accountId, 'invalid'), undefined);
    await mcp.run({ ...request, runKey: 'named-agent-two', arguments: args[1] }, actor);
    assert.equal(dispatches, 2);
    const recipe = {
      schemaVersion: 1,
      name: 'Named child',
      workflow: { kaRef: saved.kaRef, sourceHash: saved.sourceHash },
      definition: graph,
      inputs: graph.inputs,
      outputs: [{ name: 'rows', nodeId: 'n1', output: 0 }],
    };
    const digest = createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
    const entry = { kaRef: 'urn:nos:component:workflow:' + digest, sourceHash: digest, recipe };
    const authored = {
      ...graph,
      name: 'Composed arguments',
      entryId: 'first',
      nodes: ['first', 'second'].map((id) => ({
        ...graph.nodes[0],
        id,
        componentId: 'workflow-component',
        kaRef: entry.kaRef,
        sourceHash: digest,
        params: {},
      })),
      edges: [{ from: 'first', to: 'second', output: 0, input: 0 }],
      inputs: graph.inputs.map((input) => ({
        ...input,
        targets: ['first', 'second'].map((nodeId) => ({ nodeId, parameter: input.name })),
      })),
    };
    const expanded = expandStudioComponents(authored, [entry]).definition;
    const composed = await f.service.save({
      ...expanded,
      composition: { definition: authored, components: [entry] },
    });
    f.restart();
    const reopened = (await f.service.get(composed.kaRef, composed.sourceHash)).workflow;
    assert.deepEqual(reopened.definition.composition.definition, authored);
    assert.equal(reopened.definition.inputs[0].targets.length, 2);
    const composedSource = f.sources.get(composed.kaRef).source;
    for (let i = 0; i < args.length; i++) {
      await f.service.run({
        kaRef: composed.kaRef,
        sourceHash: composed.sourceHash,
        itemsJson: '[{}]',
        invocationId: `123e4567-e89b-42d3-a456-42661417402${i}`,
        arguments: args[i],
      });
      assert.equal(f.sources.get(composed.kaRef).source, composedSource);
    }
    // An invocation value is a record field for routing, not a replacement comparison rule.
    const route = definition(['switch'], []);
    route.id = '00000000-0000-4000-8000-000000000002';
    route.nodes[0].kaRef = route.nodes[0].kaRef.replace(
      'urn:demo:n8n:component:',
      'urn:nos:component:',
    );
    route.nodes[0].params = { field: 'status', equals: 'approved' };
    route.inputs = [
      {
        name: 'status',
        label: 'Status',
        required: true,
        spec: { type: 'string', label: 'Status', default: '', maxLength: 40 },
        targets: [{ nodeId: 'n0', parameter: 'status', kind: 'input' }],
      },
    ];
    // All native data blocks share the same data guard, including joins and loop topology.
    const checkedComponents = [];
    for (const capability of catalog) {
      const descriptor = capability.descriptor;
      if (
        ['schedule', 'webhook', 'run-program'].includes(descriptor.id) ||
        descriptor.id.startsWith('dkg-')
      )
        continue;
      const graph =
        descriptor.inputs === 2
          ? definition(
              ['edit-fields', descriptor.id],
              [
                [0, 0, 1, 0],
                [0, 0, 1, 1],
              ],
            )
          : descriptor.id === 'loop-items'
            ? definition(
                ['loop-items', 'edit-fields'],
                [
                  [0, 1, 1, 0],
                  [1, 0, 0, 0],
                ],
              )
            : definition([descriptor.id], []);
      for (const node of graph.nodes)
        node.kaRef = node.kaRef.replace('urn:demo:n8n:component:', 'urn:nos:component:');
      const nodeId = descriptor.inputs === 2 ? 'n1' : 'n0';
      graph.inputs = [
        { ...route.inputs[0], targets: [{ nodeId, parameter: 'status', kind: 'input' }] },
      ];
      const emitted = runtime.compileStudio(graph, { fixture: true, graphId, owner });
      const item = descriptor.sampleItems[0] ?? {};
      for (let port = 0; port < (descriptor.inputs ?? 1); port++) {
        const value = nativeExpression(
          emitted, parameter(emitted, `Block ${nodeId} check ${port}`, 'jsonOutput'),
          { argumentsJson: '{"status":"approved"}' },
          item,
        ).result;
        assert.deepEqual(value, { ...item, status: 'approved' }, descriptor.id);
      }
      checkedComponents.push(descriptor.id);
    }
    assert.ok(checkedComponents.length >= 29, JSON.stringify(checkedComponents));
    const routed = await f.service.save(route);
    f.restart();
    const openedRoute = (await f.service.get(routed.kaRef, routed.sourceHash)).workflow;
    assert.deepEqual(openedRoute.definition.inputs, route.inputs);
    const nativeRoute = runtime.compileStudio(openedRoute.definition, {
      fixture: true,
      graphId,
      owner,
    });
    const routeProgram = programAdmission(f.sources.get(routed.kaRef).source);
    for (const [status, output] of [
      ['approved', 0],
      ['rejected', 1],
    ]) {
      const packet = { itemsJson: '[{"other":7}]', paramsJson: JSON.stringify(nativeRoute.definition.nodes[0].params),
        executionId: '', argumentsJson: JSON.stringify({ status }) };
      assert.deepEqual(JSON.parse(JSON.stringify(routeProgram.run(packet))), packet);
      const row = nativeExpression(
        nativeRoute, parameter(nativeRoute, 'Block n0 check 0', 'jsonOutput'),
        packet,
        { other: 7 },
      ).result;
      assert.deepEqual(row, { other: 7, status });
      assert.equal(
        nativeExpression(nativeRoute, parameter(nativeRoute, 'Block n0', 'output'), packet, row).result,
        output,
      );
    }
    assert.equal(routeProgram.calls.length, 2);
    for (const argumentsJson of ['{}', '{"status":1}', '{"status":"{{ $json.secret }}"}',
      JSON.stringify({ status: 'x'.repeat(41) })]) {
      assert.throws(() => routeProgram.run({ itemsJson: '[{}]', executionId: '',
        paramsJson: JSON.stringify(nativeRoute.definition.nodes[0].params), argumentsJson }));
    }
    assert.equal(routeProgram.calls.length, 2, 'Invalid data-field arguments cannot dispatch a tool');
    assert.deepEqual(nativeRoute.definition.nodes[0].params, {
      field: 'status',
      equals: 'approved',
    });
    const routeRecipe = {
      schemaVersion: 1,
      name: 'Route by status',
      workflow: { kaRef: routed.kaRef, sourceHash: routed.sourceHash },
      definition: route,
      inputs: route.inputs,
      outputs: [
        { name: 'approved', nodeId: 'n0', output: 0 },
        { name: 'other', nodeId: 'n0', output: 1 },
      ],
    };
    const routeHash = createHash('sha256').update(JSON.stringify(routeRecipe)).digest('hex');
    const routeEntry = {
      kaRef: 'urn:nos:component:workflow:' + routeHash,
      sourceHash: routeHash,
      recipe: routeRecipe,
    };
    const host = {
      ...route,
      id: '00000000-0000-4000-8000-000000000003',
      nodes: [
        {
          ...route.nodes[0],
          componentId: 'workflow-component',
          kaRef: routeEntry.kaRef,
          sourceHash: routeHash,
          params: {},
        },
      ],
      inputs: [
        { ...route.inputs[0], name: 'decision', targets: [{ nodeId: 'n0', parameter: 'status' }] },
      ],
    };
    for (const dynamic of [true, false]) {
      const authored = dynamic
        ? host
        : { ...host, inputs: [], nodes: [{ ...host.nodes[0], params: { status: 'approved' } }] };
      const expanded = expandStudioComponents(authored, [routeEntry]).definition;
      const saved = await f.service.save({
        ...expanded,
        composition: { definition: authored, components: [routeEntry] },
      });
      f.restart();
      const reopened = (await f.service.get(saved.kaRef, saved.sourceHash)).workflow.definition;
      assert.deepEqual(reopened.composition.definition, authored);
      const emitted = runtime.compileStudio(reopened, { fixture: true, graphId, owner });
      const inner = emitted.definition.nodes[0];
      for (const [decision, branch] of [
        ['approved', 0],
        ['rejected', 1],
      ]) {
        const packet = { argumentsJson: JSON.stringify(dynamic ? { decision } : {}) };
        const row = nativeExpression(
          emitted, parameter(emitted, `Block ${inner.id} check 0`, 'jsonOutput'),
          packet,
        ).result;
        assert.deepEqual(row, { status: dynamic ? decision : 'approved' });
        assert.equal(
          nativeExpression(emitted, parameter(emitted, `Block ${inner.id}`, 'output'), packet, row).result,
          dynamic ? branch : 0,
        );
      }
    }
    await assert.rejects(
      mcp.run({ ...request, runKey: 'forbidden' }, { ...actor, role: 'viewer' }),
      { code: 'STUDIO_MCP_FORBIDDEN' },
    );
    assert.equal(dispatches, 2);
    return { dataInputComponents: checkedComponents };
  } finally {
    f.close();
  }
}
