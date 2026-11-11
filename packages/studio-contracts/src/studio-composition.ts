import { STUDIO_MAX_INPUTS, STUDIO_MAX_OUTPUTS } from './studio-interface-limits.js';
import { canonicalJson } from './canonical-json.js';
import {
  parseStudioInputs,
  validateComponentValue,
  assertStudioInputBinding,
} from './studio-inputs.js';
import type { StudioComponentInput } from './studio-inputs.js';
export { validateComponentValue, type StudioComponentInput } from './studio-inputs.js';
import { parseStudioGraph } from './studio-graph.js';
import { studioRecord, bounded, sha, blockId, programIri } from './studio-values.js';
import type {
  StudioDefinition,
  StudioGraph,
  StudioBlock,
  StudioEdge,
} from './workflow-definition.js';
import type { StudioCapability, StudioDescriptor } from './studio-evidence.js';

export type StudioComponentOutput = { name: string; nodeId: string; output: number };
/** Immutable recipe. The body is already expanded and retains every native source pin. */
export type StudioReusableComponent = {
  schemaVersion: 1;
  name: string;
  workflow: { kaRef: string; sourceHash: string };
  definition: StudioGraph;
  inputContract?: Pick<StudioDescriptor, 'input' | 'sampleItems'>;
  inputs: StudioComponentInput[];
  outputs: StudioComponentOutput[];
};
export type StudioComposition = {
  definition: StudioGraph;
  components: { kaRef: string; sourceHash: string; recipe: StudioReusableComponent }[];
};
export type StudioComponentExport = {
  kaRef: string;
  sourceHash: string;
  name: string;
  inputs: { name: string; label: string; nodeId: string; parameter: string; required: boolean }[];
  outputs: StudioComponentOutput[];
};
export const isWorkflowComponent = (node: Pick<StudioBlock, 'componentId'>) =>
  node.componentId === 'workflow-component';
export function studioAuthoringDefinition(definition: StudioDefinition): StudioGraph {
  const { composition, ...graph } = definition;
  return composition?.definition ?? graph;
}
const fail = (message: string): never => {
  throw new Error(message);
};
const name = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z][A-Za-z0-9_]{0,29}$/.test(value) &&
  !['constructor', 'prototype', '__proto__'].includes(value);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Request shape only. Resolving pins, fields and terminal ports requires the saved workflow. */
export function parseStudioComponentExport(value: unknown): StudioComponentExport {
  const closed = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    studioRecord(value) && Object.keys(value).every((key) => keys.includes(key));
  if (
    !closed(value, ['kaRef', 'sourceHash', 'name', 'inputs', 'outputs']) ||
    !programIri(value.kaRef) ||
    !value.kaRef.startsWith('urn:demo:nos:studio:') ||
    !sha(value.sourceHash) ||
    !bounded(value.name, 80) ||
    !value.name.trim() ||
    !Array.isArray(value.inputs) ||
    !Array.isArray(value.outputs) ||
    !value.outputs.length ||
    value.outputs.length > STUDIO_MAX_OUTPUTS
  )
    return fail('Describe the component interface.');
  for (const input of value.inputs)
    if (
      !closed(input, ['name', 'label', 'nodeId', 'parameter', 'required']) ||
      !name(input.name) ||
      !bounded(input.label, 100) ||
      !input.label.trim() ||
      !blockId(input.nodeId) ||
      !name(input.parameter) ||
      typeof input.required !== 'boolean'
    )
      return fail('Describe each exposed input field.');
  // Repeated names deliberately group several fields into one public input.
  if (new Set(value.inputs.map((input) => input.name)).size > STUDIO_MAX_INPUTS)
    return fail(`Use up to ${STUDIO_MAX_INPUTS} component inputs.`);
  for (const output of value.outputs)
    if (
      !closed(output, ['name', 'nodeId', 'output']) ||
      !name(output.name) ||
      !blockId(output.nodeId) ||
      !Number.isInteger(output.output) ||
      Number(output.output) < 0 ||
      Number(output.output) >= STUDIO_MAX_OUTPUTS
    )
      return fail('Describe each exposed output port.');
  return value as StudioComponentExport;
}

export function parseStudioReusableComponent(value: unknown): StudioReusableComponent {
  if (!studioRecord(value)) return fail('Invalid reusable component.');
  // Graph validation lives below composition parsing, so nested snapshots never recurse.
  const definition = parseStudioGraph(value.definition);
  const recipe = value as StudioReusableComponent;
  if (
    recipe.schemaVersion !== 1 ||
    typeof recipe.name !== 'string' ||
    !recipe.name.trim() ||
    recipe.name.length > 80 ||
    !studioRecord(recipe.workflow) ||
    !bounded(recipe.workflow.kaRef, 240) ||
    !recipe.workflow.kaRef.startsWith('urn:demo:nos:studio:') ||
    !sha(recipe.workflow.sourceHash) ||
    definition.schemaVersion !== undefined ||
    definition.nodes.some(
      (n) =>
        isWorkflowComponent(n) || ['schedule', 'webhook', 'run-program'].includes(n.componentId),
    ) ||
    !Array.isArray(recipe.inputs) ||
    recipe.inputs.length > STUDIO_MAX_INPUTS ||
    !Array.isArray(recipe.outputs) ||
    !recipe.outputs.length ||
    recipe.outputs.length > STUDIO_MAX_OUTPUTS
  )
    fail(`Use a native action workflow with one to ${STUDIO_MAX_OUTPUTS} exposed output ports.`);
  if (
    recipe.inputContract !== undefined &&
    (!studioRecord(recipe.inputContract) ||
      typeof recipe.inputContract.input !== 'string' ||
      !recipe.inputContract.input ||
      recipe.inputContract.input.length > 20 ||
      !Array.isArray(recipe.inputContract.sampleItems) ||
      recipe.inputContract.sampleItems.length > 20 ||
      recipe.inputContract.sampleItems.some(
        (item) => !item || typeof item !== 'object' || Array.isArray(item),
      ))
  )
    fail('Invalid component input contract.');
  parseStudioInputs(recipe.inputs, definition);
  if (
    definition.inputs?.some((input) => {
      const exposed = recipe.inputs.find((candidate) => candidate.name === input.name);
      return !exposed || canonicalJson(exposed) !== canonicalJson(input);
    })
  )
    fail('Reusable components must retain their workflow input interface.');
  const names = new Set<string>();
  const ports = new Set<string>();
  for (const output of recipe.outputs) {
    if (!studioRecord(output)) fail('Invalid component output.');
    const key = JSON.stringify([output.nodeId, output.output]);
    if (
      !name(output.name) ||
      names.has(output.name) ||
      ports.has(key) ||
      !recipe.definition.nodes.some((n) => n.id === output.nodeId) ||
      !Number.isInteger(output.output) ||
      output.output < 0 ||
      output.output >= STUDIO_MAX_OUTPUTS ||
      recipe.definition.edges.some((e) => e.from === output.nodeId && e.output === output.output)
    )
      fail('Expose unique terminal output ports.');
    names.add(output.name);
    ports.add(key);
  }
  return recipe;
}

export function expandStudioComponents(
  authored: StudioGraph,
  components: StudioComposition['components'],
) {
  if (authored.composition)
    fail('Compose the authoring definition, not an already expanded graph.');
  const nodes: StudioBlock[] = [],
    edges: StudioEdge[] = [];
  const members = new Map<string, string[]>();
  const entries = new Map<string, string>();
  const exits = new Map<string, { nodeId: string; output: number }[]>();
  const parameterTargets = new Map<string, StudioComponentInput['targets']>();
  const used = new Set(authored.nodes.map((n) => n.id));
  let sequence = 0;
  // Pin the legacy runtime's English collation: changing to code-point order
  // would renumber existing snapshots (notably I/i). Never use the host locale.
  for (const node of [...authored.nodes].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
    if (!isWorkflowComponent(node)) {
      members.set(node.id, [node.id]);
      nodes.push(clone(node));
      entries.set(node.id, node.id);
      for (const parameter of Object.keys(node.params))
        parameterTargets.set(JSON.stringify([node.id, parameter]), [
          { nodeId: node.id, parameter },
        ]);
      continue;
    }
    const entry = components.find(
      (c) => c.kaRef === node.kaRef && c.sourceHash === node.sourceHash,
    );
    if (!entry) fail('The exact reusable component revision is unavailable.');
    const recipe = entry!.recipe;
    if (Object.keys(node.params).some((key) => !recipe.inputs.some((i) => i.name === key)))
      fail('Unknown component input.');
    const ids = new Map<string, string>();
    for (const inner of [...recipe.definition.nodes].sort((a, b) =>
      a.id.localeCompare(b.id, 'en'),
    )) {
      let id: string;
      do {
        id = 'wc' + ++sequence;
      } while (used.has(id));
      used.add(id);
      ids.set(inner.id, id);
    }
    members.set(node.id, [...ids.values()]);
    const innerNodes = clone(recipe.definition.nodes);
    for (const input of recipe.inputs) {
      const value = Object.hasOwn(node.params, input.name)
        ? node.params[input.name]
        : input.required
          ? undefined
          : input.spec.default;
      const binding = authored.inputs?.find((i) =>
        i.targets.some(
          (t) => t.kind !== 'input' && t.nodeId === node.id && t.parameter === input.name,
        ),
      );
      if (binding) {
        assertStudioInputBinding(binding, input);
      } else {
        validateComponentValue(input, value);
        for (const target of input.targets) {
          const inner = innerNodes.find((n) => n.id === target.nodeId)!;
          if (target.kind === 'input')
            inner.inputValues = { ...inner.inputValues, [target.parameter]: clone(value) };
          else inner.params[target.parameter] = clone(value);
        }
      }
      parameterTargets.set(
        JSON.stringify([node.id, input.name]),
        input.targets.map((t) => ({ ...t, nodeId: ids.get(t.nodeId)! })),
      );
    }
    for (const inner of innerNodes) {
      const rest = { ...inner };
      delete rest.groupId;
      nodes.push({
        ...rest,
        id: ids.get(inner.id)!,
        label: `${node.label ?? recipe.name} / ${inner.label ?? inner.componentId}`.slice(0, 80),
        x: node.x,
        y: node.y,
        ...(node.groupId ? { groupId: node.groupId } : {}),
      });
    }
    edges.push(
      ...recipe.definition.edges.map((e) => ({ ...e, from: ids.get(e.from)!, to: ids.get(e.to)! })),
    );
    entries.set(node.id, ids.get(recipe.definition.entryId)!);
    exits.set(
      node.id,
      recipe.outputs.map((o) => ({ nodeId: ids.get(o.nodeId)!, output: o.output })),
    );
  }
  const outputTarget = (id: string, output: number) => {
    const mapped = exits.get(id);
    if (mapped && !mapped[output]) fail('Unknown component output port.');
    return mapped?.[output] ?? { nodeId: id, output };
  };
  for (const edge of authored.edges) {
    if (exits.has(edge.to) && edge.input !== 0) fail('A workflow component has one input stream.');
    const from = outputTarget(edge.from, edge.output);
    edges.push({
      from: from.nodeId,
      output: from.output,
      to: entries.get(edge.to) ?? edge.to,
      input: edge.input,
    });
  }
  const definition: StudioGraph = {
    ...clone(authored),
    // The native runtime canonicalizes these identity fields. Keep the submitted
    // compact graph in the snapshot, but compare/execute its canonical expansion.
    id: authored.id.toLowerCase(),
    name: authored.name.trim(),
    entryId: entries.get(authored.entryId) ?? authored.entryId,
    nodes,
    edges,
    ...(authored.inputs === undefined
      ? {}
      : {
          inputs: authored.inputs.map((input) => ({
            ...clone(input),
            targets: input.targets.flatMap((target) => {
              if (target.kind === 'input') {
                const nodeId = entries.get(target.nodeId);
                if (!nodeId) return fail('Workflow input target is unavailable.');
                return [{ ...target, nodeId }];
              }
              const mapped = parameterTargets.get(
                JSON.stringify([target.nodeId, target.parameter]),
              );
              if (!mapped) return fail('Workflow input target is unavailable.');
              return mapped;
            }),
          })),
        }),
  };
  if (definition.inputs) parseStudioInputs(definition.inputs, definition, true);
  return { definition, parameterTargets, outputTarget, members };
}

export function componentCapability(
  kaRef: string,
  sourceHash: string,
  graphId: string,
  recipe: StudioReusableComponent,
  available: boolean,
): StudioCapability {
  return {
    kaRef,
    sourceHash,
    graphId,
    kind: 'component',
    name: recipe.name,
    version: sourceHash.slice(0, 12),
    available,
    reusable: recipe,
    descriptor: {
      id: 'workflow-component',
      name: recipe.name,
      category: 'Workflows',
      nodeType: 'nos.workflow',
      version: 1,
      input: recipe.inputContract?.input ?? 'items',
      outputs: recipe.outputs.map((o) => o.name),
      mode: 'action',
      parameters: Object.fromEntries(
        recipe.inputs.map((i) => [i.name, { ...i.spec, label: i.label }]),
      ),
      sampleItems: clone(recipe.inputContract?.sampleItems ?? [{}]),
    },
  };
}

/** Terminal ports in graph/node order; catalog entries must match exact source pins. */
export function studioTerminalPorts(definition: StudioDefinition, catalog: StudioCapability[]) {
  return definition.nodes.flatMap((node) => {
    const descriptor = catalog.find(
      (c) => c.kaRef === node.kaRef && c.sourceHash === node.sourceHash,
    )?.descriptor;
    if (!descriptor) return fail('A component dependency is unavailable.');
    return descriptor.outputs.flatMap((_, output) =>
      definition.edges.some((e) => e.from === node.id && e.output === output)
        ? []
        : [{ nodeId: node.id, output }],
    );
  });
}
