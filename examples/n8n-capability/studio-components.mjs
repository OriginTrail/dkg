import {
  parseStudioDefinition,
  parseStudioGraph,
} from '../../packages/studio-contracts/dist/studio-evidence.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizeComponentParameters } from './component-registry.mjs';
import {
  expandStudioComponents,
  studioAuthoringDefinition,
  parseStudioReusableComponent,
  parseStudioComponentExport,
  componentCapability,
  studioTerminalPorts,
} from '../../packages/studio-contracts/dist/studio-composition.js';

const predicate = 'https://origintrail.io/nos/studio/catalog/v1#workflowComponent';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ref = (digest) => 'urn:nos:component:workflow:' + digest;
const reject = (message) => {
  throw Object.assign(new Error(message), { status: 400, code: 'INVALID_WORKFLOW_COMPONENT' });
};

/** Recipes live in the account's execution graph: configured parameters are not public catalog data. */
export function createWorkflowComponents({
  agent,
  owner,
  graphId,
  studio,
  capabilities,
  normalize,
  persist,
  resultRows,
  literalValue,
  iriValue,
  programGraphAuthor,
}) {
  async function records() {
    const result = await agent.query(
      `SELECT ?g ?entry ?payload WHERE { GRAPH ?g { ?entry <${predicate}> ?payload } }`,
      { contextGraphId: graphId, view: 'working-memory', callerAgentAddress: owner },
    );
    const found = new Map();
    for (const row of resultRows(result)) {
      if (programGraphAuthor(row.g, graphId, 'wm')?.toLowerCase() !== owner.toLowerCase()) continue;
      const recipe = parseStudioReusableComponent(JSON.parse(literalValue(row.payload)));
      const sourceHash = hash(recipe),
        kaRef = ref(sourceHash);
      if (iriValue(row.entry) !== kaRef)
        reject('Reusable component catalog integrity check failed.');
      found.set(kaRef, { kaRef, sourceHash, recipe });
    }
    return [...found.values()];
  }
  async function available(recipe, inventory) {
    const { workflow } = await studio.get(recipe.workflow.kaRef, recipe.workflow.sourceHash);
    const { composition: _composition, ...body } = workflow.definition;
    if (!isDeepStrictEqual(normalize(body), normalize(recipe.definition)))
      reject('Component body differs from its source workflow.');
    const entry = recipe.definition.nodes.find((n) => n.id === recipe.definition.entryId);
    const descriptor = inventory.find(
      (c) => c.kaRef === entry?.kaRef && c.sourceHash === entry.sourceHash,
    )?.descriptor;
    if (
      !descriptor ||
      (recipe.inputContract
        ? !isDeepStrictEqual(recipe.inputContract, {
            input: descriptor.input,
            sampleItems: descriptor.sampleItems,
          })
        : descriptor.input !== 'items')
    )
      return false;
    return (
      workflow.approved &&
      recipe.definition.nodes.every((n) =>
        inventory.some(
          (c) =>
            c.kaRef === n.kaRef &&
            c.sourceHash === n.sourceHash &&
            c.descriptor.id === n.componentId &&
            c.available &&
            !c.retired,
        ),
      )
    );
  }
  function capability(item, inventory, enabled) {
    const c = componentCapability(item.kaRef, item.sourceHash, graphId, item.recipe, enabled);
    c.requiresExportAuthorization = item.recipe.definition.nodes.some((n) =>
      inventory.some(
        (leaf) =>
          leaf.kaRef === n.kaRef &&
          leaf.sourceHash === n.sourceHash &&
          leaf.requiresExportAuthorization,
      ),
    );
    return c;
  }
  async function list(inventory) {
    inventory ??= await capabilities();
    return Promise.all(
      (await records()).map(async (item) => {
        let enabled = false;
        try {
          enabled = await available(item.recipe, inventory);
        } catch {
          /* Missing/revoked exact sources remain unavailable. */
        }
        return capability(item, inventory, enabled);
      }),
    );
  }
  async function publish(value) {
    try {
      value = parseStudioComponentExport(value);
    } catch (error) {
      reject(error.message);
    }
    const { workflow } = await studio.get(value.kaRef, value.sourceHash);
    if (!workflow.approved || workflow.mode !== 'action')
      reject('Save and approve a native action workflow first.');
    const inventory = await capabilities();
    const authored = studioAuthoringDefinition(workflow.definition);
    const expansion = expandStudioComponents(
      authored,
      workflow.definition.composition?.components ?? [],
    );
    const { composition: _composition, ...definition } = workflow.definition;
    const inputs = structuredClone(definition.inputs ?? []);
    for (const input of value.inputs) {
      const targets = expansion.parameterTargets.get(
        JSON.stringify([input.nodeId, input.parameter]),
      );
      if (!targets?.length) reject('An exposed parameter is unavailable.');
      const specs = targets.map((t) => {
        const n = definition.nodes.find((n) => n.id === t.nodeId);
        const original = inventory.find(
          (c) => c.kaRef === n?.kaRef && c.sourceHash === n.sourceHash,
        )?.descriptor.parameters[t.parameter];
        // Public labels are chosen by the caller; compatibility is about the
        // validation constraints and the actual configured default of each field.
        return original && { ...original, label: input.label, default: n.params[t.parameter] };
      });
      if (!specs[0] || specs.some((s) => !isDeepStrictEqual(s, specs[0])))
        reject('Expose fields with matching parameter types, constraints and defaults.');
      const spec = specs[0];
      const prior = inputs.find((i) => i.name === input.name);
      if (prior) {
        if (
          prior.required !== input.required ||
          prior.label !== input.label ||
          !isDeepStrictEqual(prior.spec, spec)
        )
          reject('Shared inputs need matching labels, types and defaults.');
        prior.targets.push(...targets);
      } else
        inputs.push({
          name: input.name,
          label: input.label,
          targets,
          required: input.required,
          spec,
        });
    }
    const outputs = value.outputs.map((output) => ({
      name: output.name,
      ...expansion.outputTarget(output.nodeId, output.output),
    }));
    const entry = definition.nodes.find((n) => n.id === definition.entryId);
    const descriptor = inventory.find(
      (c) => c.kaRef === entry?.kaRef && c.sourceHash === entry.sourceHash,
    )?.descriptor;
    if (!descriptor) reject('A component dependency is unavailable.');
    const recipe = parseStudioReusableComponent({
      schemaVersion: 1,
      name: value.name,
      workflow: { kaRef: workflow.kaRef, sourceHash: workflow.sourceHash },
      definition,
      inputContract: { input: descriptor.input, sampleItems: descriptor.sampleItems },
      inputs,
      outputs,
    });
    // Compare sets, preserving the caller's public output order in the recipe.
    const terminals = studioTerminalPorts(definition, inventory);
    if (
      terminals.length !== outputs.length ||
      terminals.some(
        (port) => !outputs.some((o) => o.nodeId === port.nodeId && o.output === port.output),
      )
    )
      reject('Expose every terminal output port, and no other output ports.');
    if (!(await available(recipe, inventory))) reject('A component dependency is unavailable.');
    const sourceHash = hash(recipe),
      kaRef = ref(sourceHash),
      asset = 'workflow-component-' + sourceHash;
    await persist(
      agent,
      graphId,
      asset,
      owner,
      [{ subject: kaRef, predicate, object: JSON.stringify(JSON.stringify(recipe)) }],
      await agent.assertion.history(graphId, asset, { agentAddress: owner }),
      'wm',
      async () => {
        if (!(await available(recipe, await capabilities()))) reject('Component approval changed.');
      },
    );
    const readback = (await records()).find(
      (r) => r.kaRef === kaRef && r.sourceHash === sourceHash,
    );
    if (!readback || !isDeepStrictEqual(readback.recipe, recipe))
      reject('Component readback could not be verified.');
    return capability({ kaRef, sourceHash, recipe }, inventory, true);
  }
  async function prepareSave(value) {
    if (value?.composition)
      reject('Save the authoring graph; composition snapshots are resolved by the service.');
    const selected = value?.nodes?.filter((n) => n.componentId === 'workflow-component') ?? [];
    if (!selected.length) return value;
    // Validate structure first; named parameter targets may rely on native defaults.
    parseStudioGraph({ ...value, inputs: undefined });
    if (
      value.schemaVersion ||
      value.nodes.some((n) => ['schedule', 'webhook', 'run-program'].includes(n.componentId))
    )
      reject('Workflow components currently support native manual workflows.');
    const [catalog, inventory] = await Promise.all([records(), capabilities()]);
    value = { ...value, nodes: value.nodes.map(node => {
      if (node.componentId === 'workflow-component') return node;
      const descriptor = inventory.find(c => c.kaRef === node.kaRef && c.sourceHash === node.sourceHash
        && c.descriptor.id === node.componentId)?.descriptor;
      if (!descriptor) reject('A native component revision is unavailable.');
      return { ...node, params: normalizeComponentParameters(descriptor, JSON.stringify(node.params)) };
    }) };
    parseStudioGraph(value);
    const pins = [
      ...new Map(
        selected.map((node) => [JSON.stringify([node.kaRef, node.sourceHash]), node]),
      ).values(),
    ];
    const components = pins.map((node) => {
      const recipe = catalog.find(
        (c) => c.kaRef === node.kaRef && c.sourceHash === node.sourceHash,
      );
      if (!recipe) reject('The exact reusable component revision is unavailable.');
      return recipe;
    });
    const approvals = await Promise.all(components.map((c) => available(c.recipe, inventory)));
    if (approvals.some((approved) => !approved))
      reject('The exact reusable component revision is unavailable.');
    const expanded = normalize(expandStudioComponents(value, components).definition);
    // Check the same persisted representation the browser reads before native save
    // can produce effects. Unsupported normalization must never poison inventory.
    return parseStudioDefinition({ ...expanded, composition: {
      definition: { ...value, name: expanded.name }, components,
    } });
  }
  async function save(value, authorize) {
    let definition;
    try {
      definition = await prepareSave(value);
    } catch (error) {
      // No persistence has started. Keep native save/readback uncertainty outside this boundary.
      throw Object.assign(new Error(error.message), { status: 400, code: 'INVALID_WORKFLOW' });
    }
    return studio.save(definition, authorize);
  }
  return { list, publish, save };
}
