import { vi } from 'vitest';
import type { McpClientLike } from '../../src/runtime.js';
import type { McpToolDefinition } from '../../src/schema.js';

export const catalogList: McpToolDefinition = {
  name: 'dkg_query_catalog_list',
  description: 'List saved queries',
  inputSchema: {
    type: 'object',
    properties: { projectId: { type: 'string' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

export const catalogRun: McpToolDefinition = {
  name: 'dkg_query_catalog_run',
  description: 'Run a saved query',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      selector: { type: 'string' },
      parameters: { type: 'object' },
    },
    required: ['selector'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

export const dkgQuery: McpToolDefinition = {
  name: 'dkg_query',
  description: 'Run SPARQL',
  inputSchema: {
    type: 'object',
    properties: { projectId: { type: 'string' }, sparql: { type: 'string' } },
    required: ['sparql'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

export const catalogSave: McpToolDefinition = {
  name: 'dkg_query_catalog_save',
  description: 'Save a catalog query',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      name: { type: 'string' },
      sparql: { type: 'string' },
    },
    required: ['name', 'sparql'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false },
};

export const listProjects: McpToolDefinition = {
  name: 'dkg_list_projects',
  description: 'List every Context Graph known to the node',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};

export const dkgStatus: McpToolDefinition = {
  name: 'dkg_status',
  description: 'Read node status',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};

export const memorySearch: McpToolDefinition = {
  name: 'dkg_memory_search',
  description: 'Search agent-context and optional project memory',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      projectId: { type: 'string' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function toolResponse(name: string, args: unknown, id = 'call-1'): Response {
  return jsonResponse({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  });
}

export function answerResponse(content: string): Response {
  return jsonResponse({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  });
}

export function truncatedAnswerResponse(content: string): Response {
  return jsonResponse({
    choices: [{ finish_reason: 'length', message: { role: 'assistant', content } }],
  });
}

export function makeMcp(tools: McpToolDefinition[] = [catalogList, catalogRun]): McpClientLike & {
  callTool: ReturnType<typeof vi.fn>;
} {
  return {
    async listTools() { return { tools }; },
    callTool: vi.fn(async () => ({
      content: [{ type: 'text', text: 'Found lifecycle query.' }],
      structuredContent: { entries: [{ selector: 'supply/lifecycle' }] },
    })),
  };
}
