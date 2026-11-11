import { describe, expect, it } from 'vitest';
import {
  STUDIO_INPUT_MAX_ENTRIES,
  assertStudioInputBinding,
  normalizeStudioArguments,
  parseStudioInputs,
  resolveStudioInputParams,
  studioInputSchema,
} from '../src/studio-inputs.js';
import { expandStudioComponents, type StudioComponentInput } from '../src/studio-composition.js';
import { parseStudioDefinition, parseStudioGraph } from '../src/studio-evidence.js';
import { recipe } from './studio-composition-fixture.js';

const inputs: StudioComponentInput[] = [
  {
    name: 'fields',
    label: 'Fields',
    description: 'Fields for this invocation',
    required: true,
    spec: recipe.inputs[0]!.spec,
    targets: recipe.inputs[0]!.targets,
  },
  {
    name: 'count',
    label: 'Count',
    required: false,
    spec: { type: 'integer', label: 'Count', min: 0, max: 10, default: 2 },
    targets: [{ nodeId: 'limit', parameter: 'count' }],
  },
];
const graph = () => ({
  ...structuredClone(recipe.definition),
  inputs: structuredClone(inputs),
  nodes: [
    ...structuredClone(recipe.definition.nodes),
    { ...recipe.definition.nodes[0]!, id: 'limit', componentId: 'limit', params: { count: 2 } },
  ],
  edges: [{ from: 'set', output: 0, to: 'limit', input: 0 }],
});

describe('one versioned workflow input contract', () => {
  it('keeps unbound Input fields only in drafts, refusing save and runtime admission', () => {
    const definition = graph();
    definition.inputs[0]!.targets = [];
    expect(parseStudioGraph(definition, true).inputs![0]!.targets).toEqual([]);
    expect(() => parseStudioGraph(definition)).toThrow();
    expect(() => parseStudioInputs(definition.inputs, definition, true)).toThrow();
  });
  it('bounds interface target and option arrays at the parsing boundary', () => {
    const definition = graph();
    const input = structuredClone(inputs[0]!);
    input.targets = Array.from({ length: STUDIO_INPUT_MAX_ENTRIES + 1 }, () => input.targets[0]!);
    expect(() => parseStudioInputs([input], definition)).toThrow();
    input.targets = structuredClone(inputs[0]!.targets);
    input.spec = {
      type: 'string',
      label: 'Choice',
      default: '',
      options: Array(STUDIO_INPUT_MAX_ENTRIES + 1).fill('x'),
    };
    expect(() => parseStudioInputs([input], definition)).toThrow();
  });
  it('keeps the definition immutable across argument sets and applies optional defaults', () => {
    const definition = parseStudioGraph(graph()),
      before = JSON.stringify(definition);
    const a = normalizeStudioArguments(inputs, { fields: { city: 'Belgrade' } });
    const b = normalizeStudioArguments(inputs, { count: 0, fields: { city: 'Ljubljana' } });
    expect(a).toEqual({ count: 2, fields: { city: 'Belgrade' } });
    expect(b.count).toBe(0);
    expect(resolveStudioInputParams(definition.nodes[0]!.params, inputs, 'set', b)).toEqual({
      fields: { city: 'Ljubljana' },
    });
    expect(JSON.stringify(definition)).toBe(before);
    expect(studioInputSchema(inputs)).toMatchObject({
      additionalProperties: false,
      required: ['fields'],
      properties: {
        fields: { type: 'object', description: 'Fields for this invocation' },
        count: { type: 'integer', minimum: 0, maximum: 10, default: 2 },
      },
    });
  });
  it.each([
    {},
    { fields: {}, extra: true },
    { fields: {}, count: 0.5 },
    { fields: {}, count: 11 },
    { fields: {}, count: '2' },
    { fields: '{{ $json.secret }}' },
    { fields: { unsafe: '{{ $json.secret }}' } },
    JSON.parse('{"fields":{"__proto__":{"polluted":true}}}'),
  ])('refuses missing, unknown, malformed or executable-looking arguments: %j', (value) => {
    expect(() => normalizeStudioArguments(inputs, value)).toThrow();
  });
  it('supports explicit Boolean/Number inputs without coercing strings', () => {
    const schema = inputs.map((input, i) => ({
      ...input,
      name: i ? 'amount' : 'enabled',
      required: true,
      spec: i
        ? { type: 'number' as const, label: 'Amount', default: 1, min: 0, max: 2 }
        : { type: 'boolean' as const, label: 'Enabled', default: false },
    }));
    expect(normalizeStudioArguments(schema, { enabled: false, amount: 1.5 })).toEqual({
      amount: 1.5,
      enabled: false,
    });
    expect(() => normalizeStudioArguments(schema, { enabled: 'false', amount: 1.5 })).toThrow();
  });
  it('refuses unsafe targets, duplicate names/targets and invalid optional defaults', () => {
    const definition = graph();
    for (const mutation of [
      (value: typeof definition) => {
        value.inputs[1]!.name = 'fields';
      },
      (value: typeof definition) => {
        value.inputs[1]!.targets = value.inputs[0]!.targets;
      },
      (value: typeof definition) => {
        value.inputs[1]!.spec.default = 99;
      },
      (value: typeof definition) => {
        value.nodes[1]!.params = { node: 'connection-a' };
        value.inputs[1]!.targets[0]!.parameter = 'node';
      },
    ]) {
      const copy = structuredClone(definition);
      mutation(copy);
      expect(() => parseStudioGraph(copy)).toThrow();
    }
  });
  it('translates one host input through two reusable instances without save-time substitution', () => {
    const ref = 'urn:nos:component:workflow:' + 'b'.repeat(64),
      hash = 'b'.repeat(64);
    const parent = {
      ...recipe.definition,
      entryId: 'first',
      nodes: ['first', 'second'].map((id) => ({
        ...recipe.definition.nodes[0]!,
        id,
        componentId: 'workflow-component',
        kaRef: ref,
        sourceHash: hash,
        params: {},
      })),
      edges: [{ from: 'first', output: 0, to: 'second', input: 0 }],
      inputs: [
        {
          ...inputs[0]!,
          targets: ['first', 'second'].map((nodeId) => ({ nodeId, parameter: 'fields' })),
        },
      ],
    };
    const pins = [{ kaRef: ref, sourceHash: hash, recipe }];
    parseStudioGraph(parent);
    const expanded = expandStudioComponents(parent, pins).definition;
    expect(expanded.inputs?.[0]!.targets).toEqual([
      { nodeId: 'wc1', parameter: 'fields' },
      { nodeId: 'wc2', parameter: 'fields' },
    ]);
    expect(expanded.nodes.map((n) => n.params.fields)).toEqual([
      { greeting: 'Hello' },
      { greeting: 'Hello' },
    ]);
    const saved = { ...expanded, composition: { definition: parent, components: pins } };
    expect(parseStudioDefinition(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    const args = normalizeStudioArguments(expanded.inputs!, { fields: { value: 'runtime' } });
    expect(
      expanded.nodes.map(
        (n) => resolveStudioInputParams(n.params, expanded.inputs!, n.id, args).fields,
      ),
    ).toEqual([{ value: 'runtime' }, { value: 'runtime' }]);
    expect(() =>
      parseStudioInputs(
        [{ ...inputs[0]!, targets: [{ nodeId: 'missing', parameter: 'fields' }] }],
        expanded,
      ),
    ).toThrow();
  });
});

it('does not weaken component bounds when a host maps an invocation input through it', () => {
  const target = inputs[1]!;
  expect(() =>
    assertStudioInputBinding({ ...target, spec: { ...target.spec, max: 99 } }, target),
  ).toThrow(/constraints/);
  expect(() =>
    assertStudioInputBinding({ ...target, spec: { ...target.spec, min: 1, max: 5 } }, target),
  ).not.toThrow();
  const json = { ...inputs[0]!, spec: { ...inputs[0]!.spec, maxLength: 2048 } };
  expect(() => normalizeStudioArguments([json], { fields: { text: 'x'.repeat(2049) } })).toThrow();
  const unrestricted = { ...json, spec: { ...json.spec, maxLength: 8192 } };
  expect(() =>
    normalizeStudioArguments([unrestricted], { fields: { text: '界'.repeat(3000) } }),
  ).toThrow(/budget/);
});

it('distinguishes input-record fields from settings with the same name', () => {
  const definition = graph();
  const data: StudioComponentInput = {
    name: 'status',
    label: 'Status',
    required: true,
    spec: { type: 'string', label: 'Status', default: '' },
    targets: [{ nodeId: 'limit', parameter: 'count', kind: 'input' }],
  };
  const schema = [...definition.inputs, data];
  expect(parseStudioInputs(schema, definition, true)).toEqual(schema);
  const values = normalizeStudioArguments(schema, { fields: {}, count: 3, status: 'approved' });
  expect(resolveStudioInputParams({ count: 2 }, schema, 'limit', values)).toEqual({ count: 3 });
  for (const parameter of ['__proto__', '__nos', 'bad.field'])
    expect(() =>
      parseStudioInputs(
        [{ ...data, targets: [{ nodeId: 'limit', parameter, kind: 'input' }] }],
        definition,
        true,
      ),
    ).toThrow();
});

it('the native graph boundary rejects application adapter metadata and identities', () => {
  const native = graph();
  expect(parseStudioGraph(native)).toEqual(native);
  for (const extra of [{ schemaVersion: 1 }, { target: {} }])
    expect(() => parseStudioGraph({ ...native, ...extra }, true)).toThrow();
  for (const kaRef of ['urn:nos:workflow-block:document:v1', 'urn:nos:studio-library:input:v1'])
    expect(() => parseStudioGraph({ ...native, nodes: [{ ...native.nodes[0], kaRef }] }, true)).toThrow();
  for (const x of [-1, 0.5])
    expect(() => parseStudioGraph({ ...native, nodes: [{ ...native.nodes[0], x }] }, true)).toThrow();
});
