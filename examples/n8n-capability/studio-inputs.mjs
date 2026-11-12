import { normalizeComponentEnvelope } from './component-envelope.mjs';
import { entryValidationSource } from './guest-sources/studio-entry-v9.mjs';
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
  componentValidationSource,
} from './component-registry.mjs';
import { nativeLiteral } from './component-workflows.mjs';
import { normalizeBoundEntry } from './studio-entry-input.mjs';
import { normalizeBoundEntrySource } from './guest-sources/studio-entry-v7.mjs';

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

/** Manual and MCP admission validate the same packet the generated Program receives. */
export function workflowInvocationInput(compiled, values, input, descriptor, registry = defaultComponentRegistry) {
  const admitted = invocationInput(compiled.definition, values, input, registry);
  const { argumentsJson, ...base } = admitted;
  const root = compiled.definition.nodes.find(node => node.id === compiled.definition.entryId);
  const value = [7, 8, 9].includes(compiled.compiler)
    ? normalizeBoundEntry(root, compiled.definition.inputs ?? [], JSON.parse(argumentsJson ?? '{}'),
      descriptor, base, normalizeComponentInput, resolveStudioInputParams, normalizeComponentEnvelope)
    : normalizeComponentInput(descriptor, base);
  return { ...value, ...(argumentsJson === undefined ? {} : { argumentsJson }) };
}

export function invocationParameter(definition, node, key) {
  const input = definition.inputs?.find((input) =>
    input.targets.some((t) => t.kind !== 'input' && t.nodeId === node.id && t.parameter === key),
  );
  return input
    ? `$('Admit arguments').first().json.values[${JSON.stringify(input.name)}]`
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
  if ([7, 8, 9].includes(compiled.compiler)) return boundInvocationProgramBody(compiled, descriptor, registry);
  const { component } = registry;
  const definition = compiled.definition;
  const root = definition.nodes.find((n) => n.id === definition.entryId);
  const checks = definition.nodes.map((node) => ({
    node,
    descriptor: componentExecutionDescriptor(component(node.componentId)),
  }));
  return `${studioInputValidationSource(definition.inputs.some((input) => input.targets.some((target) => target.kind === 'input')) ? 'data-v1' : 'parameters-v1')}
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

function boundInvocationProgramBody(compiled, descriptor, registry) {
  const { definition } = compiled;
  const root = definition.nodes.find(node => node.id === definition.entryId);
  const checks = definition.nodes.map(node => ({ node,
    descriptor: componentExecutionDescriptor(registry.component(node.componentId)) }));
  return `${studioInputValidationSource(compiled.compiler >= 8 ? 'data-v2' : 'data-v1')}
${compiled.compiler === 9 ? entryValidationSource : normalizeBoundEntrySource}
export function run(input: unknown) {
  if (!studioRecord(input)) throw new Error('Workflow input required.');
  const { argumentsJson, ...base } = input;
  ${definition.inputs !== undefined
    ? "if (typeof argumentsJson !== 'string' || argumentsJson.length > 8192) throw new Error('Named workflow arguments required.');"
    : "if (argumentsJson !== undefined) throw new Error('This workflow does not declare named arguments.');"}
  const inputs = ${JSON.stringify(definition.inputs ?? [])};
  const args = normalizeStudioArguments(inputs, ${definition.inputs !== undefined ? 'JSON.parse(argumentsJson)' : '{}'});
  for (const { node, descriptor } of ${JSON.stringify(checks)}) {
    normalize(descriptor, { itemsJson: JSON.stringify(descriptor.sampleItems), paramsJson: JSON.stringify(resolveStudioInputParams(node.params, inputs, node.id, args)), executionId: '' });
  }
  const value = normalizeBoundEntry(${JSON.stringify(root)}, inputs, args, ${JSON.stringify(descriptor)}, base, normalize, resolveStudioInputParams${compiled.compiler === 9 ? ", normalizeComponentEnvelope" : ""});
  if (value.paramsJson !== ${JSON.stringify(JSON.stringify(root.params))} || value.executionId) throw new Error('Use the saved workflow parameters.');
  const admitted = ${definition.inputs !== undefined ? '{ ...value, argumentsJson: JSON.stringify(args) }' : 'value'};
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
          `[${JSON.stringify(target.parameter)}]: $('Admit arguments').first().json.values[${JSON.stringify(input.name)}]`,
        );
  return values.length ? `({ ...${item}, ${values.join(',')} })` : item;
}
/** Named MCP admission shares manual validation and the existing read-profile restrictions. */
export function namedMcpInput(value, workflow, registry = defaultComponentRegistry) {
  const { component, profile } = registry;
  const root = workflow.definition.nodes.find((node) => node.id === workflow.definition.entryId);
  const input = workflowInvocationInput(
    workflow,
    value.arguments,
    {
      itemsJson: '[{}]',
      paramsJson: JSON.stringify(root.params),
      executionId: '',
    },
    component(root.componentId),
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

/** Native admission is required even when another approved Program dispatches this grant. */
export function nativeArgumentAdmission(definition, registry = defaultComponentRegistry) {
  const checks = definition.nodes.map(node => ({ node,
    descriptor: componentExecutionDescriptor(registry.component(node.componentId)) }));
  return `(() => { ${studioInputValidationSource('data-v2')}
    ${componentValidationSource()}
    const raw = $('Receive input').first().json.body.input.argumentsJson;
    if (typeof raw !== 'string' || raw.length > 8192) throw new Error('Named workflow arguments required.');
    const inputs = ${nativeLiteral(definition.inputs)};
    const values = normalizeStudioArguments(inputs, JSON.parse(raw));
    for (const { node, descriptor } of ${nativeLiteral(checks)}) {
      normalize(descriptor, { itemsJson: JSON.stringify(descriptor.sampleItems),
        paramsJson: JSON.stringify(resolveStudioInputParams(node.params, inputs, node.id, values)), executionId: '' });
    }
    return { values };
  })()`;
}
