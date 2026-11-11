import type { StudioGraph } from './workflow-definition.js';
import {
  studioInputsSchema,
  studioDraftInputsSchema,
  isStudioInputName,
  type StudioComponentInput,
} from './studio-input-schema.js';
export type { StudioComponentInput } from './studio-input-schema.js';
export { STUDIO_INPUT_TYPES, STUDIO_INPUT_MAX_ENTRIES } from './studio-parameter.js';
import { studioRecord } from './studio-values.js';
import { canonicalJson } from './canonical-json.js';
const fail = (message: string): never => {
  throw new Error(message);
};
/** One public interface, reused by component configuration and invocation arguments. */
export function parseStudioInputs(
  value: unknown,
  definition: StudioGraph,
  invocation = false,
  allowUnbound = false,
): StudioComponentInput[] {
  if (!(allowUnbound ? studioDraftInputsSchema : studioInputsSchema).safeParse(value).success)
    return fail('Give each component input a unique name, type and target.');
  const inputs = value as StudioComponentInput[];
  const targets = new Set<string>();
  const names = new Set<string>();
  for (const input of inputs) {
    if (names.has(input.name)) fail('Give each component input a unique name, type and target.');
    names.add(input.name);
    for (const target of input.targets) {
      if (target.kind === 'input' && !isStudioInputName(target.parameter))
        fail('Invalid component target.');
      const node = definition.nodes.find((n) => n.id === target.nodeId);
      const key = JSON.stringify([target.nodeId, target.kind ?? 'parameter', target.parameter]);
      if (
        !node ||
        (target.kind !== 'input' &&
          node.componentId !== 'workflow-component' &&
          !Object.hasOwn(node.params, target.parameter)) ||
        targets.has(key)
      )
        fail('Each exposed field must exist and belong to one input.');
      if (
        ['__proto__', 'prototype', 'constructor'].includes(target.parameter) ||
        (invocation &&
          target.kind !== 'input' &&
          node!.componentId !== 'workflow-component' &&
          ['node', 'profileRevision', 'operationIri', 'version'].includes(target.parameter))
      )
        fail('Workflow inputs cannot change execution identity or connection pins.');
      targets.add(key);
    }
  }
  if (invocation)
    for (const input of inputs.filter((input) => !input.required))
      normalizeStudioArguments([input], {});
  return inputs;
}
/** Only literal configuration is substituted. Native expression and capability validation follows. */
export function validateComponentValue(input: StudioComponentInput, value: unknown) {
  const fail = (message: string): never => {
    throw new Error(message);
  };
  const s = input.spec;
  if (value === undefined || (input.required && value === '')) fail(`Provide ${input.label}.`);
  if (
    s.type === 'string' &&
    (typeof value !== 'string' ||
      (s.maxLength !== undefined && value.length > s.maxLength) ||
      (s.options && !s.options.includes(value)))
  )
    fail(`Invalid ${input.label}.`);
  if (
    (s.type === 'integer' || s.type === 'number') &&
    (typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (s.type === 'integer' && !Number.isSafeInteger(value)) ||
      (s.min !== undefined && value < s.min) ||
      (s.max !== undefined && value > s.max))
  )
    fail(`Invalid ${input.label}.`);
  if (s.type === 'boolean' && typeof value !== 'boolean') fail(`Invalid ${input.label}.`);
  if (
    s.pattern === 'field' &&
    (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_ .-]{0,63}$/.test(value))
  )
    fail(`Invalid ${input.label}.`);
  if (
    s.type === 'json' &&
    (value === undefined ||
      (s.shape !== 'any' &&
        (value === null || typeof value !== 'object' || Array.isArray(value))) ||
      (s.maxLength !== undefined && JSON.stringify(value).length > s.maxLength))
  )
    fail(`Invalid ${input.label}.`);
}

/** A host input may narrow a field's accepted values, but cannot erase its constraints. */
export function assertStudioInputBinding(
  input: StudioComponentInput,
  target: StudioComponentInput,
) {
  const a = input.spec,
    b = target.spec;
  if (
    a.type !== b.type ||
    (target.required && !input.required && a.default === '') ||
    (b.min !== undefined && (a.min === undefined || a.min < b.min)) ||
    (b.max !== undefined && (a.max === undefined || a.max > b.max)) ||
    (b.maxLength !== undefined && (a.maxLength === undefined || a.maxLength > b.maxLength)) ||
    (b.options && (!a.options || a.options.some((value) => !b.options!.includes(value)))) ||
    (b.pattern !== undefined && a.pattern !== b.pattern) ||
    (b.type === 'json' && b.shape !== 'any' && a.shape === 'any')
  )
    fail(`Input ${input.label} must retain the target field's type and constraints.`);
}

export function normalizeStudioArguments(
  inputs: StudioComponentInput[],
  value: unknown,
): Record<string, unknown> {
  if (
    !studioRecord(value) ||
    Object.keys(value).some((key) => !inputs.some((input) => input.name === key))
  )
    return fail('Supply only declared workflow arguments.');
  const boundedJson = (item: unknown, depth = 0): void => {
    if (depth > 12) return fail('Workflow arguments are too deeply nested.');
    if (typeof item === 'string' && item.includes('{{'))
      return fail('Workflow arguments must be literal values.');
    if (item !== null && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key))
          return fail('Reserved argument field.');
        boundedJson(child, depth + 1);
      }
    }
  };
  boundedJson(value);
  const result = Object.fromEntries(
    inputs.map((input) => {
      const selected = Object.hasOwn(value, input.name)
        ? value[input.name]
        : input.required
          ? undefined
          : input.spec.default;
      validateComponentValue(input, selected);
      return [input.name, selected];
    }),
  );
  boundedJson(result);
  const text = canonicalJson(result);
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  if (bytes > 8192) return fail('Workflow arguments exceed the input budget.');
  return JSON.parse(text) as Record<string, unknown>;
}

/** Pure lookup and literal substitution. No expression evaluation and no authority from arguments. */
export function resolveStudioInputParams(
  params: Record<string, unknown>,
  inputs: StudioComponentInput[],
  nodeId: string,
  args: Record<string, unknown>,
) {
  const result = JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
  for (const input of inputs)
    for (const target of input.targets)
      if (target.kind !== 'input' && target.nodeId === nodeId)
        result[target.parameter] = JSON.parse(JSON.stringify(args[input.name]));
  return result;
}

export function studioInputSchema(inputs: StudioComponentInput[]) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(
      inputs.map((input) => {
        const spec = input.spec;
        return [
          input.name,
          {
            ...(spec.type === 'json'
              ? spec.shape === 'any'
                ? {}
                : { type: 'object' }
              : { type: spec.type }),
            ...(spec.type === 'string' && input.required ? { minLength: 1 } : {}),
            title: input.label,
            ...(input.description ? { description: input.description } : {}),
            ...(!input.required ? { default: spec.default } : {}),
            ...(spec.min !== undefined ? { minimum: spec.min } : {}),
            ...(spec.max !== undefined ? { maximum: spec.max } : {}),
            ...(spec.maxLength !== undefined
              ? spec.type === 'json'
                ? { 'x-nos-maxSerializedLength': spec.maxLength }
                : { maxLength: spec.maxLength }
              : {}),
            ...(spec.options ? { enum: spec.options } : {}),
            ...(spec.pattern === 'field' ? { pattern: '^[A-Za-z][A-Za-z0-9_ .-]{0,63}$' } : {}),
          },
        ];
      }),
    ),
    required: inputs.filter((input) => input.required).map((input) => input.name),
  };
}

/** Trusted helper source embedded by the native compiler; user data stays in literals. */
export function studioInputValidationSource(dataTargets = false) {
  // Existing compiler-6 KA source is immutable, including the embedded helper text.
  // Emit its original predicate when the graph uses only parameter bindings.
  const resolver = dataTargets
    ? resolveStudioInputParams.toString()
    : resolveStudioInputParams.toString().replace("target.kind !== 'input' && ", '');
  return `const fail = message => { throw new Error(message); };
const studioRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
${canonicalJson.toString()}
${validateComponentValue.toString()}
${normalizeStudioArguments.toString()}
${resolver}`;
}
