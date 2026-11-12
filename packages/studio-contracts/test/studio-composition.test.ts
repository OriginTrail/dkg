import { recipe } from './studio-composition-fixture.js';
import { describe, it, expect, vi } from 'vitest';
import {
  expandStudioComponents,
  componentCapability,
  studioAuthoringDefinition,
  studioTerminalPorts,
  parseStudioReusableComponent,
} from '../src/studio-composition.js';
import type { StudioReusableComponent } from '../src/studio-composition.js';
import {
  parseStudioWorkflow,
  parseStudioCapability,
  parseStudioDefinition,
} from '../src/studio-evidence.js';
import type { StudioGraph } from '../src/workflow-definition.js';
const sha = 'a'.repeat(64);
const ref = 'urn:nos:component:workflow:' + sha;
const components = [{ kaRef: ref, sourceHash: sha, recipe }];
const parent = (): StudioGraph => ({
  id: '123e4567-e89b-42d3-a456-426614174001',
  name: 'Two greetings',
  entryId: 'first',
  nodes: ['first', 'second'].map((id, i) => ({
    id,
    componentId: 'workflow-component',
    kaRef: ref,
    sourceHash: sha,
    params: { fields: { greeting: i ? 'Goodbye' : 'Hello' } },
    x: i * 300,
    y: 0,
  })),
  edges: [{ from: 'first', output: 0, to: 'second', input: 0 }],
});
describe('complete recipe parsing boundary', () => {
  it('accepts unknown input without rewriting valid serialized recipes', () => {
    const serialized = JSON.stringify(recipe);
    const value: unknown = JSON.parse(serialized);
    expect(parseStudioReusableComponent(value)).toBe(value);
    expect(JSON.stringify(parseStudioReusableComponent(value))).toBe(serialized);
  });
  const malformed: [string, (value: StudioReusableComponent) => void][] = [
    [
      'missing entry',
      (value) => {
        value.definition.entryId = 'missing';
      },
    ],
    [
      'invalid native pin',
      (value) => {
        value.definition.nodes[0]!.sourceHash = 'bad';
      },
    ],
    [
      'dangling edge',
      (value) => {
        value.definition.edges.push({ from: 'set', to: 'missing', output: 0, input: 0 });
      },
    ],
    [
      'nested snapshot',
      (value) => {
        Object.assign(value.definition, { composition: {} });
      },
    ],
    [
      'oversized native params',
      (value) => {
        value.definition.nodes[0]!.params = { fields: 'x'.repeat(2048) };
      },
    ],
    [
      'invalid target',
      (value) => {
        value.inputs[0]!.targets[0]!.parameter = 'missing';
      },
    ],
    [
      'invalid spec',
      (value) => {
        Object.assign(value.inputs[0]!.spec, { options: [null] });
      },
    ],
    [
      'invalid bounds',
      (value) => {
        Object.assign(value.inputs[0]!.spec, { min: 2, max: 1 });
      },
    ],
    [
      'null input',
      (value) => {
        Object.assign(value.inputs, { 0: null });
      },
    ],
    [
      'invalid output',
      (value) => {
        value.outputs[0]!.nodeId = 'missing';
      },
    ],
  ];
  it.each(malformed)(
    'rejects %s at direct, capability and saved-snapshot ingestion',
    (_name, mutate) => {
      const value = structuredClone(recipe);
      const capability = componentCapability(ref, sha, 'private', value, true);
      const authored = parent();
      const snapshot = {
        ...expandStudioComponents(authored, [{ ...components[0]!, recipe: value }]).definition,
        composition: { definition: authored, components: [{ ...components[0]!, recipe: value }] },
      };
      // Build valid derived representations first; malformed snapshots cannot hide behind
      // a constructor assertion or an execution-body mismatch.
      expect(() => parseStudioCapability(capability)).not.toThrow();
      expect(() => parseStudioDefinition(snapshot)).not.toThrow();
      mutate(value);
      expect(() => parseStudioReusableComponent(value)).toThrow();
      expect(() => parseStudioCapability(capability)).toThrow();
      expect(() => parseStudioDefinition(snapshot)).toThrow();
    },
  );
});
describe('workflow composition', () => {
  it('expands two instances with independent parameters, pins and port wiring', () => {
    const authored = parent();
    const result = expandStudioComponents(authored, components);
    expect(result.definition.nodes.map((n) => n.params.fields)).toEqual([
      { greeting: 'Hello' },
      { greeting: 'Goodbye' },
    ]);
    expect(new Set(result.definition.nodes.map((n) => n.id)).size).toBe(2);
    expect(result.definition.edges).toEqual([{ from: 'wc1', output: 0, to: 'wc2', input: 0 }]);
    expect(result.definition.nodes.every((n) => n.sourceHash === sha)).toBe(true);
    expect(recipe.definition.nodes[0]!.params.fields).toEqual({ greeting: 'Hello' });
    expect(authored.nodes[0]!.componentId).toBe('workflow-component');
    expect(result.parameterTargets.get(JSON.stringify(['second', 'fields']))).toEqual([
      { nodeId: 'wc2', parameter: 'fields' },
    ]);
  });
  it('round trips compact authoring and rejects tampered execution bodies', () => {
    const authored = parent(),
      expanded = expandStudioComponents(authored, components).definition;
    const workflow = {
      definition: { ...expanded, composition: { definition: authored, components } },
      kaRef: 'urn:demo:nos:studio:parent',
      sourceHash: sha,
      graphId: 'private',
      approved: true,
      requiresExportAuthorization: false,
      mode: 'action',
      activation: { active: false },
      readbackVerified: true,
    };
    expect(
      studioAuthoringDefinition(
        parseStudioWorkflow(JSON.parse(JSON.stringify(workflow))).definition,
      ),
    ).toEqual(authored);
    workflow.definition.nodes[0]!.params.fields = { greeting: 'tampered' };
    expect(() => parseStudioWorkflow(workflow)).toThrow();
  });
  it('rejects wrong pins, missing required inputs and unknown ports', () => {
    const authored = parent();
    authored.nodes[0]!.sourceHash = 'b'.repeat(64);
    expect(() => expandStudioComponents(authored, components)).toThrow(/revision/);
    const missing = parent();
    missing.nodes[0]!.params = {};
    expect(() => expandStudioComponents(missing, components)).toThrow(/Provide/);
    const port = parent();
    port.edges[0]!.output = 1;
    expect(() => expandStudioComponents(port, components)).toThrow(/output/);
  });
  it('avoids existing native IDs and resolves public outputs and nested export targets', () => {
    const authored = parent();
    authored.nodes.push({ ...recipe.definition.nodes[0]!, id: 'wc1' });
    const result = expandStudioComponents(authored, components);
    expect(new Set(result.definition.nodes.map((n) => n.id)).size).toBe(3);
    expect(result.outputTarget('first', 0)).toEqual({ nodeId: 'wc2', output: 0 });
  });
  it('rejects recursive recipes and triggers, and parses generated catalog entries', () => {
    expect(
      parseStudioCapability(componentCapability(ref, sha, 'private', recipe, true)).reusable,
    ).toEqual(recipe);
    const recursive = structuredClone(recipe);
    recursive.definition.nodes[0]!.componentId = 'workflow-component';
    expect(() => parseStudioReusableComponent(recursive)).toThrow();
    recursive.definition.nodes[0]!.componentId = 'schedule';
    expect(() => parseStudioReusableComponent(recursive)).toThrow();
  });
});

it('preserves file input contracts through capability parsing and rejects descriptor tampering', () => {
  const file = {
    ...recipe,
    inputContract: { input: 'file', sampleItems: [{ file: { name: 'a.csv', data: 'YQo=' } }] },
  };
  const c = componentCapability(ref, sha, 'private', file, true);
  expect(parseStudioCapability(c).descriptor.input).toBe('file');
  expect(c.descriptor.sampleItems).toEqual(file.inputContract.sampleItems);
  c.descriptor.input = 'items';
  expect(() => parseStudioCapability(c)).toThrow();
});
it('discovers only unconnected ports in stable order and requires exact catalog pins', () => {
  const native = componentCapability(ref, sha, 'private', recipe, true);
  native.kaRef = recipe.definition.nodes[0]!.kaRef;
  native.descriptor.outputs = ['yes', 'no'];
  const definition = {
    ...recipe.definition,
    nodes: [recipe.definition.nodes[0]!, { ...recipe.definition.nodes[0]!, id: 'next' }],
    edges: [{ from: 'set', output: 0, to: 'next', input: 0 }],
  };
  expect(studioTerminalPorts(definition, [native])).toEqual([
    { nodeId: 'set', output: 1 },
    { nodeId: 'next', output: 0 },
    { nodeId: 'next', output: 1 },
  ]);
  expect(() =>
    studioTerminalPorts(definition, [{ ...native, sourceHash: 'b'.repeat(64) }]),
  ).toThrow(/dependency/);
});

it('canonicalizes runtime identity fields while retaining the submitted compact graph', () => {
  const authored = parent();
  authored.name = '  Two greetings  ';
  authored.id = authored.id.toUpperCase();
  const expanded = expandStudioComponents(authored, components).definition;
  expect(expanded.name).toBe('Two greetings');
  expect(expanded.id).toBe(authored.id.toLowerCase());
  const saved = {
    definition: { ...expanded, composition: { definition: authored, components } },
    kaRef: 'urn:demo:nos:studio:normalized',
    sourceHash: sha,
    graphId: 'private',
    mode: 'action',
    approved: true,
    requiresExportAuthorization: false,
    activation: { active: false },
    readbackVerified: true,
  };
  expect(studioAuthoringDefinition(parseStudioWorkflow(saved).definition)).toEqual(authored);
  saved.definition.nodes[0]!.params.fields = { greeting: 'Changed' };
  expect(() => parseStudioWorkflow(saved)).toThrow();
});

it('preserves multi-step wiring, independent pins and reordered native output ports across two instances', () => {
  const multi: StudioReusableComponent = {
    ...recipe,
    definition: {
      ...recipe.definition,
      entryId: 'entry',
      nodes: [
        { ...recipe.definition.nodes[0]!, id: 'entry' },
        {
          ...recipe.definition.nodes[0]!,
          id: 'terminal',
          componentId: 'if',
          kaRef: 'urn:nos:component:if:pin',
          sourceHash: 'b'.repeat(64),
          params: {},
        },
      ],
      edges: [{ from: 'entry', output: 0, to: 'terminal', input: 0 }],
    },
    inputs: [{ ...recipe.inputs[0]!, targets: [{ nodeId: 'entry', parameter: 'fields' }] }],
    outputs: [
      { name: 'no', nodeId: 'terminal', output: 1 },
      { name: 'yes', nodeId: 'terminal', output: 0 },
    ],
  };
  const result = expandStudioComponents(parent(), [{ kaRef: ref, sourceHash: sha, recipe: multi }]);
  expect(result.definition.entryId).toBe('wc1');
  expect(result.members.get('first')).toEqual(['wc1', 'wc2']);
  expect(result.members.get('second')).toEqual(['wc3', 'wc4']);
  expect(result.definition.nodes.map((n) => [n.id, n.kaRef, n.sourceHash])).toEqual([
    ['wc1', recipe.definition.nodes[0]!.kaRef, sha],
    ['wc2', 'urn:nos:component:if:pin', 'b'.repeat(64)],
    ['wc3', recipe.definition.nodes[0]!.kaRef, sha],
    ['wc4', 'urn:nos:component:if:pin', 'b'.repeat(64)],
  ]);
  expect(result.definition.edges).toEqual([
    { from: 'wc1', output: 0, to: 'wc2', input: 0 },
    { from: 'wc3', output: 0, to: 'wc4', input: 0 },
    { from: 'wc2', output: 1, to: 'wc3', input: 0 },
  ]);
  expect(result.outputTarget('first', 0)).toEqual({ nodeId: 'wc2', output: 1 });
  expect(result.outputTarget('first', 1)).toEqual({ nodeId: 'wc2', output: 0 });
  expect(result.outputTarget('second', 0)).toEqual({ nodeId: 'wc4', output: 1 });
  expect(result.outputTarget('second', 1)).toEqual({ nodeId: 'wc4', output: 0 });
  expect(result.parameterTargets.get(JSON.stringify(['second', 'fields']))).toEqual([
    { nodeId: 'wc3', parameter: 'fields' },
  ]);
});

describe('exposed input configuration', () => {
  function expand(params: Record<string, unknown>) {
    const typed = structuredClone(recipe);
    typed.definition.nodes[0]!.params = {
      mode: 'fast',
      label: 'ready',
      count: 4,
      fields: { seed: true },
    };
    typed.inputs = [
      {
        name: 'mode',
        label: 'Mode',
        required: true,
        spec: { type: 'string', label: 'Mode', default: 'fast', options: ['fast', 'safe'] },
        targets: [{ nodeId: 'set', parameter: 'mode' }],
      },
      {
        name: 'label',
        label: 'Label',
        required: true,
        spec: { type: 'string', label: 'Label', default: 'ready', maxLength: 5 },
        targets: [{ nodeId: 'set', parameter: 'label' }],
      },
      {
        name: 'count',
        label: 'Count',
        required: false,
        spec: { type: 'integer', label: 'Count', default: 4, min: 1, max: 10 },
        targets: [{ nodeId: 'set', parameter: 'count' }],
      },
      {
        name: 'fields',
        label: 'Fields',
        required: false,
        spec: { type: 'json', label: 'Fields', default: { seed: true } },
        targets: [{ nodeId: 'set', parameter: 'fields' }],
      },
    ];
    const authored = parent();
    authored.nodes = [authored.nodes[0]!];
    authored.nodes[0]!.params = params;
    authored.edges = [];
    return {
      typed,
      params: expandStudioComponents(authored, [{ kaRef: ref, sourceHash: sha, recipe: typed }])
        .definition.nodes[0]!.params,
    };
  }
  it.each([1, 10])(
    'substitutes constrained strings and integer boundary %i into native parameters',
    (count) => {
      expect(
        expand({ mode: 'safe', label: '12345', count, fields: { custom: true } }).params,
      ).toEqual({ mode: 'safe', label: '12345', count, fields: { custom: true } });
    },
  );
  it.each([
    ['mode', 'unknown'],
    ['mode', 1],
    ['mode', ''],
    ['mode', undefined],
    ['label', '123456'],
    ['label', false],
    ['label', ''],
    ['label', undefined],
    ['count', 0],
    ['count', 11],
    ['count', 1.5],
    ['count', '4'],
    ['count', null],
    ['count', undefined],
    ['count', Number.NaN],
    ['count', Infinity],
    ['count', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects invalid %s input %s before producing native parameters', (key, value) => {
    expect(() => expand({ mode: 'fast', label: 'ready', [key as string]: value })).toThrow();
  });
  it('uses defaults only for omitted optional inputs and copies object defaults', () => {
    const result = expand({ mode: 'fast', label: 'ready' });
    expect(result.params).toEqual({
      mode: 'fast',
      label: 'ready',
      count: 4,
      fields: { seed: true },
    });
    (result.params.fields as Record<string, unknown>).seed = false;
    expect(result.typed.inputs[3]!.spec.default).toEqual({ seed: true });
    expect(result.typed.definition.nodes[0]!.params.fields).toEqual({ seed: true });
    expect(() => expand({ label: 'ready' })).toThrow(/Provide Mode/);
  });
});

it('preserves legacy step identities and snapshot readback with English and Turkish default collation', () => {
  const caseRecipe: StudioReusableComponent = {
    ...recipe,
    inputs: [],
    definition: {
      ...recipe.definition,
      entryId: 'I',
      nodes: ['I', 'i'].map((id) => ({
        ...recipe.definition.nodes[0]!,
        id,
        params: { fields: { step: id } },
      })),
      edges: [{ from: 'I', output: 0, to: 'i', input: 0 }],
    },
    outputs: [{ name: 'result', nodeId: 'i', output: 0 }],
  };
  const authored: StudioGraph = {
    ...parent(),
    entryId: 'I',
    nodes: parent().nodes.map((node, index) => ({
      ...node,
      id: index ? 'i' : 'I',
      label: index ? 'lower' : 'upper',
      params: {},
    })),
    edges: [{ from: 'I', output: 0, to: 'i', input: 0 }],
  };
  const entries = [{ kaRef: ref, sourceHash: sha, recipe: caseRecipe }];
  // Captured legacy English allocation, independent of the implementation under test.
  // Outer i precedes I, and inner i precedes I in both instances.
  const nodes = [
    ['i', 'I', 'wc2'],
    ['i', 'i', 'wc1'],
    ['I', 'I', 'wc4'],
    ['I', 'i', 'wc3'],
  ].map(([outerId, innerId, id]) => {
    const outer = authored.nodes.find((node) => node.id === outerId)!;
    const inner = caseRecipe.definition.nodes.find((node) => node.id === innerId)!;
    return {
      ...inner,
      id: id!,
      label: outer.label + ' / ' + inner.componentId,
      x: outer.x,
      y: outer.y,
    };
  });
  const definition = {
    ...authored,
    entryId: 'wc4',
    nodes,
    edges: [
      { from: 'wc2', output: 0, to: 'wc1', input: 0 },
      { from: 'wc4', output: 0, to: 'wc3', input: 0 },
      { from: 'wc3', output: 0, to: 'wc2', input: 0 },
    ],
  };
  const saved = {
    definition: { ...definition, composition: { definition: authored, components: entries } },
    kaRef: 'urn:demo:nos:studio:legacy-case',
    sourceHash: sha,
    graphId: 'private',
    mode: 'action',
    approved: true,
    requiresExportAuthorization: false,
    activation: { active: false },
    readbackVerified: true,
  };
  // Control only the default string collation, so this regression also runs on
  // Windows where LANG does not reliably select the process's default locale.
  const compare = String.prototype.localeCompare;
  for (const locale of ['en', 'tr']) {
    const mock = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
      this: string,
      other,
      locales,
      options,
    ) {
      return compare.call(this, other, locales ?? locale, options);
    });
    try {
      expect(['I', 'i'].sort((a, b) => a.localeCompare(b))).toEqual(
        locale === 'en' ? ['i', 'I'] : ['I', 'i'],
      );
      expect(expandStudioComponents(authored, entries).definition).toEqual(definition);
      expect(parseStudioWorkflow(saved)).toEqual(saved);
    } finally {
      mock.mockRestore();
    }
  }
});
