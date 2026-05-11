import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DkgClient } from '../src/client.js';
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

/**
 * In-memory DkgClient stub. Implements the surface area mcp-dkg tools
 * actually call; everything else throws so a regression that adds a new
 * client method is loud.
 *
 * Tests can override individual methods by passing them in the options
 * object (e.g. `new FakeClient({ getAgentIdentity: async () => ({...}) })`).
 */
type ClientMethods = Partial<{
  [K in keyof DkgClient]: DkgClient[K];
}>;

export class FakeClient {
  // Round-trip storage for the assertion quintet.
  readonly assertions = new Map<string, {
    quads: Array<{ subject: string; predicate: string; object: string }>;
    promotedRoots: Set<string>;
    discarded: boolean;
  }>();
  readonly contextGraphs = new Set<string>();
  readonly subGraphs = new Set<string>();
  readonly subscribed = new Set<string>();
  readonly publishCalls: Array<Record<string, unknown>> = [];
  readonly queryCalls: Array<Record<string, unknown>> = [];

  /** Per-layer hits used by memory-search tests. Keys are
   * `${contextGraphId}::${view}`. */
  readonly memoryFixtures = new Map<string, Array<Record<string, unknown>>>();

  agentIdentity: { peerId?: string; agentAddress?: string } = {
    peerId: 'peer-test',
    agentAddress: 'did:dkg:agent:peer-test',
  };

  status: Record<string, unknown> = { peerId: 'peer-test', peers: 2 };

  walletBalances = {
    wallets: ['0xabc'],
    balances: [
      { address: '0xabc', eth: '0.05', trac: '12.5', symbol: 'TRAC' },
    ],
    chainId: 'base-sepolia',
    rpcUrl: 'http://rpc.example',
  };

  constructor(private readonly overrides: ClientMethods = {}) {}

  asDkgClient(): DkgClient {
    return this as unknown as DkgClient;
  }

  // ── Assertion CRUD ──────────────────────────────────────────────
  async createAssertion(args: { contextGraphId: string; assertionName: string }) {
    if (this.overrides.createAssertion) return this.overrides.createAssertion.call(this, args);
    const key = `${args.contextGraphId}::${args.assertionName}`;
    if (this.assertions.has(key)) {
      return { assertionUri: null, alreadyExists: true };
    }
    this.assertions.set(key, { quads: [], promotedRoots: new Set(), discarded: false });
    return {
      assertionUri: `urn:dkg:assertion:${args.contextGraphId}:${args.assertionName}`,
      alreadyExists: false,
    };
  }

  async writeAssertion(args: {
    contextGraphId: string;
    assertionName: string;
    triples: Array<{ subject: string; predicate: string; object: string }>;
  }) {
    if (this.overrides.writeAssertion) return this.overrides.writeAssertion.call(this, args);
    const key = `${args.contextGraphId}::${args.assertionName}`;
    const cell = this.assertions.get(key);
    if (!cell) throw new Error(`assertion not created: ${key}`);
    if (cell.discarded) throw new Error(`assertion discarded: ${key}`);
    cell.quads.push(...args.triples);
  }

  async promoteAssertion(args: {
    contextGraphId: string;
    assertionName: string;
    entities: string[];
  }) {
    if (this.overrides.promoteAssertion) return this.overrides.promoteAssertion.call(this, args);
    const key = `${args.contextGraphId}::${args.assertionName}`;
    const cell = this.assertions.get(key);
    if (!cell) throw new Error(`assertion not created: ${key}`);
    for (const e of args.entities) cell.promotedRoots.add(e);
    if (args.entities.length === 0) {
      // "promote all roots" sentinel — capture every distinct subject.
      for (const q of cell.quads) cell.promotedRoots.add(q.subject);
    }
  }

  async discardAssertion(args: { contextGraphId: string; assertionName: string }) {
    if (this.overrides.discardAssertion) return this.overrides.discardAssertion.call(this, args);
    const key = `${args.contextGraphId}::${args.assertionName}`;
    const cell = this.assertions.get(key);
    if (cell) cell.discarded = true;
  }

  async queryAssertion(args: { contextGraphId: string; assertionName: string }) {
    if (this.overrides.queryAssertion) return this.overrides.queryAssertion.call(this, args);
    const key = `${args.contextGraphId}::${args.assertionName}`;
    const cell = this.assertions.get(key);
    if (!cell) return { quads: [], count: 0 };
    return { quads: cell.quads, count: cell.quads.length };
  }

  async getAssertionHistory(args: { contextGraphId: string; assertionName: string }) {
    if (this.overrides.getAssertionHistory) return this.overrides.getAssertionHistory.call(this, args);
    return {
      contextGraphId: args.contextGraphId,
      assertionName: args.assertionName,
      author: 'urn:dkg:agent:test',
      promoted: false,
      createdAt: '2026-04-30T00:00:00Z',
    };
  }

  async importAssertionFile(args: {
    contextGraphId: string;
    assertionName: string;
    fileBuffer: Buffer | Uint8Array;
    fileName: string;
    contentType?: string;
  }) {
    if (this.overrides.importAssertionFile) return this.overrides.importAssertionFile.call(this, args);
    return {
      assertionName: args.assertionName,
      fileName: args.fileName,
      bytes: args.fileBuffer.byteLength,
      contentType: args.contentType ?? 'application/octet-stream',
      extraction: { status: 'completed', tripleCount: 7 },
    };
  }

  // ── Query ───────────────────────────────────────────────────────
  async query(args: Record<string, unknown>) {
    this.queryCalls.push(args);
    if (this.overrides.query) return this.overrides.query.call(this, args);
    const cgId = String(args.contextGraphId ?? '');
    const view = String(args.view ?? 'working-memory');
    const key = `${cgId}::${view}`;
    const bindings = this.memoryFixtures.get(key) ?? [];
    return { bindings };
  }

  async getAgentIdentity() {
    if (this.overrides.getAgentIdentity) return this.overrides.getAgentIdentity.call(this);
    return this.agentIdentity;
  }

  async listProjects() {
    if (this.overrides.listProjects) return this.overrides.listProjects.call(this);
    return Array.from(this.contextGraphs).map((id) => ({ id, name: id }));
  }

  async listSubGraphs(_: string) {
    if (this.overrides.listSubGraphs) return this.overrides.listSubGraphs.call(this, _);
    return [];
  }

  // ── Setup ───────────────────────────────────────────────────────
  async createContextGraph(args: { id: string; name: string }) {
    if (this.overrides.createContextGraph) return this.overrides.createContextGraph.call(this, args);
    // Mirror the real client's idempotency contract (post-F2): duplicate
    // ids return `alreadyExists: true` rather than throwing.
    const alreadyExists = this.contextGraphs.has(args.id);
    this.contextGraphs.add(args.id);
    return {
      created: args.id,
      uri: `urn:dkg:cg:${args.id}`,
      alreadyExists,
    };
  }

  async ensureSubGraph(cgId: string, name: string) {
    if (this.overrides.ensureSubGraph) return this.overrides.ensureSubGraph.call(this, cgId, name);
    this.subGraphs.add(`${cgId}::${name}`);
  }

  async subscribe(args: { contextGraphId: string; includeSharedMemory?: boolean }) {
    if (this.overrides.subscribe) return this.overrides.subscribe.call(this, args);
    this.subscribed.add(args.contextGraphId);
    return {
      subscribed: args.contextGraphId,
      catchup: {
        jobId: 'job-1',
        status: 'queued',
        includeSharedMemory: args.includeSharedMemory ?? true,
      },
    };
  }

  // ── Health ──────────────────────────────────────────────────────
  async getStatus() {
    if (this.overrides.getStatus) return this.overrides.getStatus.call(this);
    return this.status;
  }

  async getWalletBalances() {
    if (this.overrides.getWalletBalances) return this.overrides.getWalletBalances.call(this);
    return this.walletBalances;
  }

  // ── Publish ─────────────────────────────────────────────────────
  async publishQuads(args: Record<string, unknown>) {
    if (this.overrides.publishQuads) return this.overrides.publishQuads.call(this, args);
    this.publishCalls.push({ kind: 'publishQuads', ...args });
    return { kcId: 'kc-1', kas: [], txHash: '0xdead' };
  }

  async publishSharedMemory(args: Record<string, unknown>) {
    if (this.overrides.publishSharedMemory) return this.overrides.publishSharedMemory.call(this, args);
    this.publishCalls.push({ kind: 'publishSharedMemory', ...args });
    return { kcId: 'kc-2', kas: [{ tokenId: '1', rootEntity: 'urn:x' }], txHash: '0xbeef' };
  }

  async registerContextGraph(args: { id: string }) {
    if (this.overrides.registerContextGraph) return this.overrides.registerContextGraph.call(this, args);
    return {
      registered: args.id,
      onChainId: `chain:${args.id}`,
      txHash: '0xreg',
      alreadyRegistered: false,
    };
  }
}
