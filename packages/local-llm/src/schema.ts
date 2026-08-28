export type JsonSchema = Record<string, unknown>;

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: McpToolAnnotations;
}

export interface OpenAiToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

const UNSUPPORTED_LLAMA_SCHEMA_KEYWORDS = new Set([
  '$dynamicRef',
  'contains',
  'dependentRequired',
  'dependentSchemas',
  'if',
  'maxContains',
  'minContains',
  'not',
  'patternProperties',
  'propertyNames',
  'then',
  'else',
  'unevaluatedProperties',
]);

const SAFE_PATTERN_ESCAPES = new Set([
  '^', '$', '.', '[', ']', '(', ')', '|', '{', '}', '*', '+', '?', '\\', '"',
]);

function normalizePattern(pattern: string, path: string, changes: string[]): string {
  if (!pattern.startsWith('^') || !pattern.endsWith('$')) {
    throw new Error(`${path}: llama.cpp requires an anchored pattern (^...$)`);
  }
  let normalized = '';
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '\\') {
      if (index + 1 >= pattern.length) throw new Error(`${path}: trailing backslash in pattern`);
      const escaped = pattern[++index];
      if (escaped === 'd') {
        normalized += inCharacterClass ? '0-9' : '[0-9]';
        continue;
      }
      if (!SAFE_PATTERN_ESCAPES.has(escaped)) {
        throw new Error(`${path}: regexp escape \\${escaped} cannot be translated safely for llama.cpp`);
      }
      normalized += `\\${escaped}`;
      continue;
    }
    if (character === '[') inCharacterClass = true;
    if (character === ']') inCharacterClass = false;
    normalized += character;
  }
  if (inCharacterClass) throw new Error(`${path}: unclosed character class in pattern`);
  if (normalized !== pattern) changes.push(`${path}: ${pattern} -> ${normalized}`);
  return normalized;
}

function normalizeSchemaValue(
  value: unknown,
  path: string,
  changes: string[],
  schemaMap = false,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeSchemaValue(item, `${path}[${index}]`, changes));
  }
  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (schemaMap) {
      output[key] = normalizeSchemaValue(child, childPath, changes);
      continue;
    }
    if (UNSUPPORTED_LLAMA_SCHEMA_KEYWORDS.has(key)) {
      throw new Error(`${childPath}: unsupported JSON Schema keyword`);
    }
    if (key === '$ref' && typeof child === 'string' && !child.startsWith('#/')) {
      throw new Error(`${childPath}: only local JSON Schema refs are safe`);
    }
    output[key] = key === 'pattern' && typeof child === 'string'
      ? normalizePattern(child, childPath, changes)
      : normalizeSchemaValue(
        child,
        childPath,
        changes,
        key === 'properties' || key === '$defs' || key === 'definitions',
      );
  }
  return output;
}

export function normalizeToolForLlama(tool: McpToolDefinition): {
  tool: McpToolDefinition;
  changes: string[];
} {
  const changes: string[] = [];
  const inputSchema = normalizeSchemaValue(tool.inputSchema, '$', changes) as JsonSchema;
  return { tool: { ...tool, inputSchema }, changes };
}

function schemaForLlamaGrammar(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(schemaForLlamaGrammar);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    // llama.cpp's JSON-Schema-to-GBNF compiler fails to parse nested tool
    // schemas containing maxLength (confirmed against the real catalog-save
    // schema). Keep the bound in McpToolDefinition for local validation, but
    // omit it from the grammar-only copy sent to the model.
    if (key === 'maxLength') continue;
    output[key] = schemaForLlamaGrammar(child);
  }
  return output;
}

export function toOpenAiTool(tool: McpToolDefinition): OpenAiToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: schemaForLlamaGrammar(tool.inputSchema) as JsonSchema,
    },
  };
}

function typeMatches(value: unknown, expected: string): boolean {
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'null') return value === null;
  return typeof value === expected;
}

export function validateAgainstSchema(value: unknown, schema: unknown, path = '$'): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const definition = schema as JsonSchema;

  for (const keyword of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(definition[keyword])) {
      const branches = definition[keyword].map((branch) => validateAgainstSchema(value, branch, path));
      const matching = branches.filter((errors) => errors.length === 0).length;
      if ((keyword === 'anyOf' && matching === 0) || (keyword === 'oneOf' && matching !== 1)) {
        return [`${path}: does not match ${keyword} (${branches.flat().join('; ')})`];
      }
      return [];
    }
  }

  const errors: string[] = [];
  if (Array.isArray(definition.allOf)) {
    for (const branch of definition.allOf) errors.push(...validateAgainstSchema(value, branch, path));
  }
  const types = Array.isArray(definition.type)
    ? definition.type.filter((item): item is string => typeof item === 'string')
    : typeof definition.type === 'string'
      ? [definition.type]
      : [];
  if (types.length && !types.some((type) => typeMatches(value, type))) {
    return [`${path}: expected ${types.join(' or ')}`];
  }
  if (definition.const !== undefined && value !== definition.const) {
    errors.push(`${path}: expected ${JSON.stringify(definition.const)}`);
  }
  if (Array.isArray(definition.enum) && !definition.enum.includes(value)) {
    errors.push(`${path}: expected one of ${definition.enum.map((item) => JSON.stringify(item)).join(', ')}`);
  }

  if (typeof value === 'string') {
    if (typeof definition.minLength === 'number' && value.length < definition.minLength) {
      errors.push(`${path}: minimum length is ${definition.minLength}`);
    }
    if (typeof definition.maxLength === 'number' && value.length > definition.maxLength) {
      errors.push(`${path}: maximum length is ${definition.maxLength}`);
    }
    if (typeof definition.pattern === 'string' && !new RegExp(definition.pattern).test(value)) {
      errors.push(`${path}: must match ${definition.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (typeof definition.minimum === 'number' && value < definition.minimum) {
      errors.push(`${path}: minimum is ${definition.minimum}`);
    }
    if (typeof definition.maximum === 'number' && value > definition.maximum) {
      errors.push(`${path}: maximum is ${definition.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof definition.minItems === 'number' && value.length < definition.minItems) {
      errors.push(`${path}: needs at least ${definition.minItems} item(s)`);
    }
    if (typeof definition.maxItems === 'number' && value.length > definition.maxItems) {
      errors.push(`${path}: allows at most ${definition.maxItems} item(s)`);
    }
    value.forEach((item, index) => {
      errors.push(...validateAgainstSchema(item, definition.items, `${path}[${index}]`));
    });
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = definition.properties && typeof definition.properties === 'object'
      ? definition.properties as Record<string, unknown>
      : {};
    for (const required of Array.isArray(definition.required) ? definition.required : []) {
      if (typeof required === 'string' && !(required in record)) {
        errors.push(`${path}.${required}: required argument is missing`);
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key in properties) {
        errors.push(...validateAgainstSchema(child, properties[key], `${path}.${key}`));
      } else if (definition.additionalProperties === false) {
        errors.push(`${path}.${key}: unexpected argument`);
      }
    }
  }

  return errors;
}

export function parseAndValidateToolArguments(
  raw: unknown,
  tool: McpToolDefinition,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw || '{}');
    } catch (error) {
      return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'tool arguments must be a JSON object' };
  }
  const errors = validateAgainstSchema(parsed, tool.inputSchema);
  return errors.length
    ? { ok: false, error: errors.join('; ') }
    : { ok: true, args: parsed as Record<string, unknown> };
}

export function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
