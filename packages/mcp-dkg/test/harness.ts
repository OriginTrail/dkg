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

  /**
   * Default per-peer info payload returned by `getPeerInfo`. Tests that
   * care about the diagnostic shape (`dkg_peer_info` tool) override
   * this via `client.peerInfoByPeerId.set(peerId, {...})` or via the
   * `overrides.getPeerInfo` constructor option for full control.
   */
  readonly peerInfoByPeerId = new Map<
    string,
    Record<string, unknown>
  >();

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

  async resolveImportArtifact(args: {
    contextGraphId: string;
    assertionUri: string;
    fileHash?: string;
  }) {
    if (this.overrides.resolveImportArtifact) return this.overrides.resolveImportArtifact.call(this, args);
    return {
      artifact: {
        contextGraphId: args.contextGraphId,
        assertionUri: args.assertionUri,
        assertionName: args.assertionUri.split('/').pop(),
        fileHash: args.fileHash ?? `sha256:${'a'.repeat(64)}`,
        markdownHash: `sha256:${'b'.repeat(64)}`,
        markdownForm: `urn:dkg:file:sha256:${'b'.repeat(64)}`,
        extractionStatus: 'completed',
        canReadMarkdown: true,
      },
    };
  }

  async readImportArtifactMarkdown(args: {
    contextGraphId: string;
    assertionUri: string;
    fileHash?: string;
    maxBytes?: number;
  }) {
    if (this.overrides.readImportArtifactMarkdown) return this.overrides.readImportArtifactMarkdown.call(this, args);
    const artifact = await this.resolveImportArtifact(args);
    return {
      ...artifact,
      markdownHash: `sha256:${'b'.repeat(64)}`,
      contentType: 'text/markdown',
      bytes: 18,
      markdown: '# Imported\n\nBody.',
    };
  }

  async writeSemanticEnrichment(args: {
    contextGraphId: string;
    assertionUri: string;
    semanticQuads: Array<{ subject: string; predicate: string; object: string }>;
  }) {
    if (this.overrides.writeSemanticEnrichment) return this.overrides.writeSemanticEnrichment.call(this, args);
    return {
      assertionUri: args.assertionUri,
      assertionName: 'imported-doc',
      sourceAssertionUri: args.assertionUri,
      semanticTripleCount: args.semanticQuads.length,
      provenanceTripleCount: 8,
      promoted: false,
      published: false,
    };
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

  async getPeerInfo(peerId: string) {
    if (this.overrides.getPeerInfo) return this.overrides.getPeerInfo.call(this, peerId);
    const seeded = this.peerInfoByPeerId.get(peerId);
    if (seeded) return seeded as ReturnType<DkgClient['getPeerInfo']> extends Promise<infer T> ? T : never;
    // Default fixture: not connected, no peerStore entry, no outbox.
    return {
      peerId,
      connected: false,
      rawConnectionCount: 0,
      getConnectionsReturnsForPeer: 0,
      connections: [],
      peerStore: null,
      outbox: { pendingCount: 0, oldestFirstFailureAt: null, attempts: [] },
      protocols: [],
      syncCapable: false,
      lastSeen: null,
      latencyMs: null,
      health: null,
      connectionCount: 0,
      transports: [],
      directions: [],
      remoteAddrs: [],
    } as unknown as ReturnType<DkgClient['getPeerInfo']> extends Promise<infer T> ? T : never;
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

  // ── Agent-to-agent chat (Phase 1: agent debug chat RFC) ────────
  /**
   * Inbound chat history surfaced by `dkg_check_inbox` (via the daemon's
   * `GET /api/messages`). Pre-seed with `client.chatMessages.push({ … })`
   * in tests; calls land here for assertions in `client.sendChatCalls`.
   */
  readonly chatMessages: Array<{
    /** SQLite rowid — used by the compound cursor. Auto-assigned by
     * `pushChatMessage` below if omitted. */
    id?: number;
    ts: number;
    direction: 'in' | 'out';
    peer: string;
    peerName?: string;
    text: string;
    delivered?: boolean;
  }> = [];

  /** Auto-incremented when `pushChatMessage` assigns an id. */
  private nextChatId = 1;

  /**
   * Convenience: push a message to `chatMessages` with a stable
   * auto-assigned id, matching what the real daemon's
   * `id INTEGER PRIMARY KEY AUTOINCREMENT` would do. Tests can still
   * push to `chatMessages` directly if they need a specific id.
   */
  pushChatMessage(msg: Omit<(typeof this.chatMessages)[number], 'id'> & { id?: number }): number {
    const id = msg.id ?? this.nextChatId++;
    this.chatMessages.push({ ...msg, id });
    return id;
  }
  readonly sendChatCalls: Array<{
    to: string;
    text: string;
    contextGraphId?: string;
  }> = [];
  /**
   * Toggle to make `sendChat` return a custom delivery result. Shape
   * matches the DkgClient.sendChat return — supports the new
   * `queued/messageId/attempts/nextAttemptAtMs` fields added in the
   * MessageOutbox PR alongside the legacy `delivered/error` shape.
   */
  chatDeliveryOverride: {
    delivered: boolean;
    queued?: boolean;
    messageId?: string;
    attempts?: number;
    nextAttemptAtMs?: number;
    error?: string;
  } | null = null;
  /** Used by `buildPeerNameMap` to resolve friendly names. */
  agents: Array<{ peerId: string; name: string }> = [];

  async sendChat(args: { to: string; text: string; contextGraphId?: string }) {
    if (this.overrides.sendChat) return this.overrides.sendChat.call(this, args);
    this.sendChatCalls.push(args);
    if (this.chatDeliveryOverride) return this.chatDeliveryOverride;
    return { delivered: true };
  }

  /**
   * Captures the params the tool passed through so tests can assert
   * that e.g. `dkg_check_inbox` is sending `direction=in`, `sinceId`,
   * and `order=asc` to the daemon. Cleared per-test in `beforeEach`.
   */
  readonly getMessagesCalls: Array<{
    peer?: string;
    since?: number;
    sinceId?: number;
    limit?: number;
    direction?: 'in' | 'out';
    order?: 'asc' | 'desc';
  }> = [];

  async getMessages(args: {
    peer?: string;
    since?: number;
    sinceId?: number;
    limit?: number;
    direction?: 'in' | 'out';
    order?: 'asc' | 'desc';
  } = {}) {
    this.getMessagesCalls.push(args);
    if (this.overrides.getMessages) return this.overrides.getMessages.call(this, args);
    let rows = this.chatMessages
      .slice()
      .map((m, idx) => ({ ...m, id: m.id ?? idx + 1 }));
    if (args.peer) rows = rows.filter((m) => m.peer === args.peer);
    // Compound cursor: matches the real daemon's
    // `(ts > since) OR (ts = since AND id > sinceId)` predicate when
    // both are provided; falls back to `ts > since` for back-compat.
    if (typeof args.since === 'number') {
      if (typeof args.sinceId === 'number') {
        rows = rows.filter(
          (m) => m.ts > args.since! || (m.ts === args.since && m.id > args.sinceId!),
        );
      } else {
        rows = rows.filter((m) => m.ts > args.since!);
      }
    }
    if (args.direction === 'in' || args.direction === 'out') {
      rows = rows.filter((m) => m.direction === args.direction);
    }
    // Mirror DB ordering. Default `desc` (newest first) for back-compat
    // with history-view callers; `asc` (oldest first) for forward
    // inbox pagination.
    if (args.order === 'asc') {
      rows.sort((a, b) => a.ts - b.ts || a.id - b.id);
    } else {
      rows.sort((a, b) => b.ts - a.ts || b.id - a.id);
    }
    if (typeof args.limit === 'number') {
      rows = args.order === 'asc' ? rows.slice(0, args.limit) : rows.slice(-args.limit);
    }
    return { messages: rows };
  }

  async listAgents() {
    if (this.overrides.listAgents) return this.overrides.listAgents.call(this);
    return this.agents;
  }
}
