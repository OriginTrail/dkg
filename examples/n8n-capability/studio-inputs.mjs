import { parseStudioGraph } from '../../packages/studio-contracts/dist/studio-graph.js';
/** Named values flow in the admitted invocation; saved graphs and native pins never change. */
import {
  parseStudioInputs,
  assertStudioInputBinding,
  normalizeStudioArguments,
  resolveStudioInputParams,
  studioInputValidationSource,
} from '../../packages/studio-contracts/dist/studio-inputs.js';
import {
  defaultComponentRegistry,
  componentExecutionDescriptor,
  normalizeComponentInput,
} from './component-registry.mjs';
import { nativeLiteral } from './component-workflows.mjs';

const fail = (message) => {
  throw Object.assign(new Error(message), { code: 'INVALID_WORKFLOW', status: 400 });
};
export function validateInvocationBindings(definition, registry = defaultComponentRegistry) {
  const { component } = registry;
  try {
    const inputs = parseStudioInputs(definition.inputs, definition, true);
    if (
      definition.schemaVersion ||
      definition.nodes.some((n) => ['schedule', 'webhook', 'run-program'].includes(n.componentId))
    )
      fail('Named arguments require a native manual workflow.');
    for (const input of inputs)
      for (const target of input.targets) {
        if (target.kind === 'input') continue;
        const node = definition.nodes.find((n) => n.id === target.nodeId);
        const spec = component(node.componentId).parameters[target.parameter];
        if (
          !spec ||
          (spec.type !== input.spec.type && !(spec.type === 'json' && spec.shape === 'any'))
        )
          fail('Workflow input type does not match its native parameter.');
        if (spec.type === input.spec.type) assertStudioInputBinding(input, { ...input, spec });
      }
    return inputs;
  } catch (error) {
    fail(error.message);
  }
}

export function invocationInput(definition, values, input, registry = defaultComponentRegistry) {
  const { component } = registry;
  if (definition.inputs === undefined) {
    if (values !== undefined) fail('This workflow does not declare named arguments.');
    return input;
  }
  let args;
  try {
    args = normalizeStudioArguments(definition.inputs, values);
    for (const node of definition.nodes) {
      const descriptor = componentExecutionDescriptor(component(node.componentId));
      normalizeComponentInput(descriptor, {
        itemsJson: JSON.stringify(descriptor.sampleItems),
        paramsJson: JSON.stringify(
          resolveStudioInputParams(node.params, definition.inputs, node.id, args),
        ),
        executionId: '',
      });
    }
  } catch (error) {
    fail(error.message);
  }
  const value = { ...input, argumentsJson: JSON.stringify(args) };
  if (JSON.stringify(value).length > 16384) fail('Workflow invocation exceeds the input budget.');
  return value;
}

export function invocationGrant(definition, grant) {
  if (definition.inputs === undefined) return grant;
  return {
    ...grant,
    inputSchema: {
      ...grant.inputSchema,
      properties: {
        ...grant.inputSchema.properties,
        argumentsJson: { type: 'string', maxLength: 8192 },
      },
      required: [...grant.inputSchema.required, 'argumentsJson'],
    },
  };
}

export function invocationParameter(definition, node, key) {
  const input = definition.inputs?.find((input) =>
    input.targets.some((t) => t.kind !== 'input' && t.nodeId === node.id && t.parameter === key),
  );
  return input
    ? `JSON.parse($('Receive input').first().json.body.input.argumentsJson)[${JSON.stringify(input.name)}]`
    : nativeLiteral(node.params[key]);
}

export function invocationParameters(definition, node) {
  if (definition.inputs === undefined) return nativeLiteral(JSON.stringify(node.params));
  return `JSON.stringify({${Object.keys(node.params)
    .map((key) => `[${JSON.stringify(key)}]: ${invocationParameter(definition, node, key)}`)
    .join(',')}})`;
}

/** Trusted source generator. Every substituted value is JSON, never executable user code. */
export function invocationProgramBody(compiled, descriptor, registry = defaultComponentRegistry) {
  const { component } = registry;
  const definition = compiled.definition;
  const root = definition.nodes.find((n) => n.id === definition.entryId);
  const checks = definition.nodes.map((node) => ({
    node,
    descriptor: componentExecutionDescriptor(component(node.componentId)),
  }));
  return `${studioInputValidationSource(definition.inputs.some((input) => input.targets.some((target) => target.kind === 'input')))}
export function run(input: unknown) {
  if (!studioRecord(input) || typeof input.argumentsJson !== 'string' || input.argumentsJson.length > 8192) throw new Error('Named workflow arguments required.');
  const { argumentsJson, ...base } = input;
  const inputs = ${JSON.stringify(definition.inputs)};
  const args = normalizeStudioArguments(inputs, JSON.parse(argumentsJson));
  for (const { node, descriptor } of ${JSON.stringify(checks)}) {
    normalize(descriptor, { itemsJson: JSON.stringify(descriptor.sampleItems), paramsJson: JSON.stringify(resolveStudioInputParams(node.params, inputs, node.id, args)), executionId: '' });
  }
  const value = normalize(${JSON.stringify(descriptor)}, base);
  if (value.paramsJson !== ${JSON.stringify(JSON.stringify(root.params))} || value.executionId) throw new Error('Use the saved workflow parameters.');
  const admitted = { ...value, argumentsJson: JSON.stringify(args) };
  if (JSON.stringify(admitted).length > 16384) throw new Error('Workflow invocation exceeds the input budget.');
  return invoke_tool('urn:dkg:tool:n8n', admitted);
}\n`;
}

/** Called only after the journal input matches the confirmed native execution input. */
export function invocationDefinition(definition, input, registry = defaultComponentRegistry) {
  if (definition.inputs === undefined) return definition;
  const admitted = invocationInput(definition, JSON.parse(input.argumentsJson), input, registry);
  const args = JSON.parse(admitted.argumentsJson);
  return {
    ...definition,
    nodes: definition.nodes.map((node) => ({
      ...node,
      params: resolveStudioInputParams(node.params, definition.inputs, node.id, args),
    })),
  };
}

/** Compile data bindings into the existing per-node input guard; callers supply only literal data. */
export function invocationItem(definition, node, item = '$json') {
  const values = Object.entries(node.inputValues ?? {}).map(
    ([key, value]) => `[${JSON.stringify(key)}]: ${nativeLiteral(value)}`,
  );
  for (const input of definition.inputs ?? [])
    for (const target of input.targets)
      if (target.kind === 'input' && target.nodeId === node.id)
        values.push(
          `[${JSON.stringify(target.parameter)}]: JSON.parse($('Receive input').first().json.body.input.argumentsJson)[${JSON.stringify(input.name)}]`,
        );
  return values.length ? `({ ...${item}, ${values.join(',')} })` : item;
}
export function normalizeInputValueNodes(value, normalize) {
  const definition = normalize({
    ...value,
    nodes: value.nodes.map(({ inputValues: _inputValues, ...node }) => node),
  });
  return parseStudioGraph({
    ...definition,
    nodes: definition.nodes.map((node) => {
      const original = value.nodes.find((item) => item.id === node.id);
      return original?.inputValues === undefined
        ? node
        : { ...node, inputValues: original.inputValues };
    }),
  });
}

/** Named MCP admission shares manual validation and the existing read-profile restrictions. */
export function namedMcpInput(value, workflow, registry = defaultComponentRegistry) {
  const { component, profile } = registry;
  const root = workflow.definition.nodes.find((node) => node.id === workflow.definition.entryId);
  const input = invocationInput(
    workflow.definition,
    value.arguments,
    normalizeComponentInput(component(root.componentId), {
      itemsJson: '[{}]',
      paramsJson: JSON.stringify(root.params),
      executionId: '',
    }),
    registry,
  );
  if (root.componentId === 'dkg-read') {
    const args = JSON.parse(input.argumentsJson);
    profile.workflowTools.validateArguments(args);
    const resolved = invocationDefinition(workflow.definition, input, registry).nodes.find(
      (node) => node.id === root.id,
    );
    if (!profile.workflowTools.readGraphs.includes(resolved.params.contextGraph))
      throw Error('STUDIO_READ_PROFILE_REQUIRED');
    input.itemsJson = JSON.stringify([args]);
  }
  return input;
}
