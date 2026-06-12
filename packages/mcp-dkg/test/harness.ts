import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DkgConfig } from '../src/config.js';

export interface RegisteredTool {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema?: ZodRawShape;
  };
  handler: (...args: unknown[]) => Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface RegisterCall {
  name: string;
  inputSchema?: ZodRawShape;
  description?: string;
}

export class FakeServer {
  readonly tools = new Map<string, RegisteredTool>();
  readonly registerCalls: RegisterCall[] = [];

  registerTool(
    name: string,
    config: RegisteredTool['config'],
    handler: RegisteredTool['handler'],
  ): { name: string } {
    if (this.tools.has(name)) {
      throw new Error(`Duplicate tool registration: ${name}`);
    }
    const entry: RegisteredTool = { name, config, handler };
    this.tools.set(name, entry);
    this.registerCalls.push({
      name,
      inputSchema: config.inputSchema,
      description: config.description,
    });
    return { name };
  }

  asMcpServer(): McpServer {
    return this as unknown as McpServer;
  }

  get(name: string): RegisteredTool {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    return tool;
  }

  /**
   * Validate input against the tool's declared zod inputSchema, then invoke
   * the handler exactly the way the real MCP SDK does (positional input
   * object, no extras). Throws on declared-field validation failure so
   * tests can `expect` the rejection.
   *
   * Mirrors production MCP SDK schema posture: unknown keys are silently
   * dropped at parse, NOT rejected. The pre-F27 `.strict()` mode here
   * gave three tests false confidence — they asserted that legacy
   * `{ layer: 'union' }` was *rejected* on `dkg_get_entity` /
   * `dkg_list_activity` / `dkg_query` post-W2-#17. Against the real
   * MCP SDK those calls would parse cleanly (`layer` silently dropped)
   * and run the handler with the default scope. The harness now matches
   * that posture so the tests describe the real surface, not a
   * harness artefact. Strict-mode tests must use a different harness.
   */
  async call(name: string, input: Record<string, unknown> = {}): Promise<ToolResult> {
    const tool = this.get(name);
    const shape = tool.config.inputSchema ?? {};
    const objectSchema = z.object(shape as Record<string, ZodTypeAny>);
    const parsed = objectSchema.parse(input);
    return tool.handler(parsed);
  }

  /**
   * Parse-ONLY: run the tool's declared zod inputSchema against `input`
   * and return the parsed object WITHOUT invoking the handler (so no
   * client / network call happens). Throws on schema-validation failure
   * exactly like `call()` would. Use this for pure schema-contract tests
   * (e.g. "this read-side tool accepts a non-slug name") so they need
   * neither a daemon nor a client double.
   */
  parse(name: string, input: Record<string, unknown> = {}): Record<string, unknown> {
    const tool = this.get(name);
    const shape = tool.config.inputSchema ?? {};
    const objectSchema = z.object(shape as Record<string, ZodTypeAny>);
    return objectSchema.parse(input) as Record<string, unknown>;
  }
}

export function makeConfig(overrides: Partial<DkgConfig> = {}): DkgConfig {
  return {
    api: 'http://localhost:9200',
    token: 'test-token',
    defaultProject: 'test-cg',
    agentUri: 'urn:dkg:agent:test',
    capture: {
      autoShare: true,
      defaultPrivacy: 'team',
      subGraph: 'chat',
      assertion: 'chat-log',
    },
    sourcePath: null,
    ...overrides,
  };
}
