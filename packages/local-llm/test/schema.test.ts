import { describe, expect, it } from 'vitest';
import {
  normalizeToolForLlama,
  parseAndValidateToolArguments,
  toOpenAiTool,
  validateAgainstSchema,
  type McpToolDefinition,
} from '../src/schema.js';

const tool: McpToolDefinition = {
  name: 'lookup',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', pattern: '^CFG-\\d{3}$' },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
    required: ['id'],
    additionalProperties: false,
  },
};

describe('llama.cpp schema compatibility', () => {
  it('losslessly translates regexp digit escapes', () => {
    const normalized = normalizeToolForLlama(tool);
    expect((normalized.tool.inputSchema.properties as Record<string, { pattern?: string }>).id.pattern)
      .toBe('^CFG-[0-9]{3}$');
    expect(normalized.changes).toHaveLength(1);
  });

  it('rejects patterns and keywords that cannot be translated safely', () => {
    expect(() => normalizeToolForLlama({
      name: 'unsafe',
      inputSchema: { type: 'string', pattern: '\\w+' },
    })).toThrow('anchored pattern');
    expect(() => normalizeToolForLlama({
      name: 'unsafe',
      inputSchema: { type: 'object', patternProperties: {} },
    })).toThrow('unsupported JSON Schema keyword');
  });

  it('removes maxLength only from the llama grammar copy and keeps local enforcement', () => {
    const normalized = normalizeToolForLlama({
      name: 'bounded',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 3 } },
        required: ['text'],
      },
    }).tool;
    const grammarSchema = toOpenAiTool(normalized).function.parameters;
    expect((grammarSchema.properties as Record<string, Record<string, unknown>>).text)
      .toEqual({ type: 'string', minLength: 1 });
    expect(parseAndValidateToolArguments({ text: 'four' }, normalized).ok).toBe(false);
  });
});

describe('local argument validation', () => {
  it('validates required, pattern, range, and additional properties', () => {
    const normalized = normalizeToolForLlama(tool).tool;
    expect(parseAndValidateToolArguments('{"id":"CFG-123","limit":2}', normalized))
      .toEqual({ ok: true, args: { id: 'CFG-123', limit: 2 } });
    const invalid = parseAndValidateToolArguments('{"id":"bad","limit":11,"extra":true}', normalized);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error).toContain('must match');
      expect(invalid.error).toContain('maximum is 10');
      expect(invalid.error).toContain('unexpected argument');
    }
  });

  it('supports allOf and oneOf', () => {
    expect(validateAgainstSchema('a', { oneOf: [{ const: 'a' }, { const: 'b' }] })).toEqual([]);
    expect(validateAgainstSchema(3, {
      allOf: [{ type: 'number', minimum: 1 }, { type: 'number', maximum: 4 }],
    })).toEqual([]);
  });

  it('enforces constraints behind accepted local refs', () => {
    const referenced = normalizeToolForLlama({
      name: 'referenced',
      inputSchema: {
        $defs: {
          nested: {
            type: 'object',
            properties: { label: { type: 'string', minLength: 3 } },
            required: ['label'],
          },
          input: {
            type: 'object',
            properties: {
              projectId: { type: 'string' },
              rank: { type: 'integer', minimum: 1, maximum: 10 },
              nested: { $ref: '#/$defs/nested' },
            },
            required: ['projectId', 'nested'],
          },
        },
        $ref: '#/$defs/input',
      },
    }).tool;

    const missing = parseAndValidateToolArguments({ rank: 0, nested: {} }, referenced);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toContain('projectId: required argument is missing');
      expect(missing.error).toContain('minimum is 1');
      expect(missing.error).toContain('nested.label: required argument is missing');
    }
    expect(parseAndValidateToolArguments({
      projectId: 'cg-1',
      rank: 5,
      nested: { label: 'ok!' },
    }, referenced).ok).toBe(true);
  });
});

describe('schema boundaries', () => {
  it('preserves the language of digit classes and escaped punctuation without mutating the input', () => {
    const pattern = '^ID-[\\d]{2}\\.[0-9]+$';
    const input: McpToolDefinition = { name: 'id', inputSchema: { type: 'string', pattern } };
    const result = normalizeToolForLlama(input);
    expect(result.tool.inputSchema.pattern).toBe('^ID-[0-9]{2}\\.[0-9]+$');
    expect(input.inputSchema.pattern).toBe(pattern);
    for (const sample of ['ID-00.1', 'ID-99.123', 'ID-1.2', 'ID-aa.3', 'ID-12x3', 'ID-12.']) {
      expect(new RegExp(String(result.tool.inputSchema.pattern)).test(sample))
        .toBe(new RegExp(pattern).test(sample));
    }
  });

  it.each([
    ['^\\w+$', 'regexp escape \\w'],
    ['^[abc$', 'unclosed character class'],
    ['abc$', 'anchored pattern'],
  ])('rejects an unsafe pattern %s', (pattern, error) => {
    expect(() => normalizeToolForLlama({ name: 'unsafe', inputSchema: { type: 'string', pattern } }))
      .toThrow(error);
  });

  it('rejects remote references and preserves keyword-like property names', () => {
    expect(() => normalizeToolForLlama({ name: 'remote', inputSchema: { $ref: 'https://example.org/schema' } }))
      .toThrow('only local JSON Schema refs are safe');
    const inputSchema = { type: 'object', properties: { if: { type: 'boolean' }, not: { type: 'string' } } };
    expect(normalizeToolForLlama({ name: 'keywords', inputSchema }).tool.inputSchema).toEqual(inputSchema);
  });

  it.each([
    [null, { type: 'null' }, []],
    [false, { type: 'null' }, ['$: expected null']],
    [true, { type: 'boolean' }, []],
    [Infinity, { type: 'number' }, ['$: expected number']],
    [0.5, { type: 'integer' }, ['$: expected integer']],
    ['x', { type: ['null', 'string'] }, []],
    [0, { type: ['null', 'string'] }, ['$: expected null or string']],
    ['bad', { enum: ['ok', 'yes'] }, ['$: expected one of "ok", "yes"']],
    ['ok', { enum: ['ok', 'yes'] }, []],
    [[], { type: 'array', minItems: 1 }, ['$: needs at least 1 item(s)']],
    [[1, 2], { type: 'array', maxItems: 1 }, ['$: allows at most 1 item(s)']],
    [[0, 1], { type: 'array', items: { type: 'integer', minimum: 1 } }, ['$[0]: minimum is 1']],
    [[1], { type: 'array', minItems: 1, maxItems: 1, items: { type: 'integer' } }, []],
    ['x', { anyOf: [{ type: 'number' }, { type: 'boolean' }] }, ['$: does not match anyOf ($: expected number; $: expected boolean)']],
    [1, { oneOf: [{ type: 'integer' }, { type: 'number' }] }, ['$: does not match oneOf ()']],
    [1, { allOf: [{ minimum: 2 }, { const: 3 }] }, ['$: minimum is 2', '$: expected 3']],
  ])('validates %j against %j', (value, schema, errors) => {
    expect(validateAgainstSchema(value, schema)).toEqual(errors);
  });

  it('resolves escaped JSON pointers and validates reference siblings', () => {
    const schema = {
      $defs: { 'a/b~c': { type: 'string', minLength: 2 } },
      $ref: '#/$defs/a~1b~0c', maxLength: 3,
    };
    expect(validateAgainstSchema('ab', schema)).toEqual([]);
    expect(validateAgainstSchema('a', schema)).toEqual(['$: minimum length is 2']);
    expect(validateAgainstSchema('abcd', schema)).toEqual(['$: maximum length is 3']);
    expect(validateAgainstSchema('ab', { ...schema, $ref: '#/%24defs/a~1b~0c' })).toEqual([]);
  });

  it.each(['#/$defs/missing', '#/%zz', 'https://example.org/schema', '#/$defs/items/0', '#/toString'])
    ('refuses unresolved or non-object references %s', ref => {
      expect(validateAgainstSchema(1, { $defs: { items: [{ type: 'number' }] }, $ref: ref }))
        .toEqual([`$: unresolved local JSON Schema ref ${ref}`]);
    });

  it('rejects reference cycles without recursing forever', () => {
    const schema = { $defs: { cycle: { $ref: '#/$defs/cycle' } }, $ref: '#/$defs/cycle' };
    expect(validateAgainstSchema({}, schema))
      .toEqual(['$: recursive local JSON Schema ref #/$defs/cycle is unsupported']);
  });

  it.each([null, 1, true, [], 'null', '[]'])('rejects non-object tool arguments %j', raw => {
    expect(parseAndValidateToolArguments(raw, tool))
      .toEqual({ ok: false, error: 'tool arguments must be a JSON object' });
  });

  it('rejects malformed JSON and supplies an empty object for an empty argument string', () => {
    expect(parseAndValidateToolArguments('{', tool)).toEqual({ ok: false, error: expect.stringContaining('invalid JSON:') });
    expect(parseAndValidateToolArguments('', { name: 'empty', inputSchema: { type: 'object' } }))
      .toEqual({ ok: true, args: {} });
  });
});
