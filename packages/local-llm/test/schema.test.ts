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
});
