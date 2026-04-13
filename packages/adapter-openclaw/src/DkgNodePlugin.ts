/**
 * DkgNodePlugin — OpenClaw adapter that connects any OpenClaw agent to a
 * running DKG V9 daemon.
 *
 * All tools route through DkgDaemonClient → daemon HTTP API.
 * There is no embedded DKGAgent — the daemon owns the node, triple store,
 * and P2P networking.
 *
 * Integration modules:
 *   - DKG UI channel bridge (DkgChannelPlugin)
 *   - DKG-backed memory search (DkgMemoryPlugin)
 *   - Memory write capture (WriteCapture)
 */
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { DkgDaemonClient } from './dkg-client.js';
import { DkgChannelPlugin } from './DkgChannelPlugin.js';
import { DkgMemoryPlugin } from './DkgMemoryPlugin.js';
import { WriteCapture } from './write-capture.js';
import type {
  DkgOpenClawConfig,
  OpenClawPluginApi,
  OpenClawTool,
  OpenClawToolResult,
} from './types.js';

const OPENCLAW_LOCAL_AGENT_CAPABILITIES = {
  localChat: true,
  connectFromUi: true,
  installNode: true,
  dkgPrimaryMemory: true,
  wmImportPipeline: true,
  nodeServedSkill: true,
} as const;

const OPENCLAW_LOCAL_AGENT_MANIFEST = {
  packageName: '@origintrail-official/dkg-adapter-openclaw',
  setupEntry: './setup-entry.mjs',
} as const;

export class DkgNodePlugin {
  private readonly config: DkgOpenClawConfig;

  // HTTP client to daemon — used by all tools and integration modules
  private client!: DkgDaemonClient;

  // Integration modules
  private channelPlugin: DkgChannelPlugin | null = null;
  private memoryPlugin: DkgMemoryPlugin | null = null;
  private writeCapture: WriteCapture | null = null;
  /** Guard: backlog import runs at most once per plugin lifecycle. */
  private backlogImportDone: Promise<void> | null = null;
  private warnedLegacyGameConfig = false;

  constructor(config?: DkgOpenClawConfig) {
    this.config = { ...config };
  }

  /** Whether the base runtime (daemon client, lifecycle hooks) has been initialized. */
  private initialized = false;

  /**
   * Register the DKG plugin with an OpenClaw plugin API instance.
   * On the first call: full init (lifecycle hooks, daemon handshake, integration modules).
   * On subsequent calls (gateway multi-phase init): re-registers tools into the new registry.
   */
  register(api: OpenClawPluginApi): void {
    this.warnOnLegacyGameConfig(api);

    const registrationMode = api.registrationMode ?? 'full';
    const fullRuntime = registrationMode === 'full';
    const setupOnly = registrationMode === 'setup-only';
    const setupRuntime = registrationMode === 'setup-runtime';
    const cliMetadataOnly = registrationMode === 'cli-metadata';
    const lightweightRuntime = setupOnly || setupRuntime;

    // Only expose the DKG agent tool surface during full runtime.
    if (fullRuntime) {
      for (const tool of this.tools()) {
        api.registerTool(tool);
      }
    }

    if (cliMetadataOnly) {
      return;
    }

    // Subsequent multi-phase calls should upgrade missing integrations without
    // recreating servers/watchers, then re-register any tool surfaces.
    if (this.initialized) {
      this.registerIntegrationModules(api, { enableFullRuntime: fullRuntime });
      if (fullRuntime || setupRuntime) {
        this.registerLocalAgentIntegration(api, registrationMode);
      }
      return;
    }

    // Create daemon client — used by all tools and integration modules
    const daemonUrl = this.config.daemonUrl ?? 'http://127.0.0.1:9200';
    this.client = new DkgDaemonClient({ baseUrl: daemonUrl });
    this.initialized = true;

    api.registerHook('session_end', () => this.stop(), { name: 'dkg-node-stop' });

    // --- Integration modules ---
    this.registerIntegrationModules(api, { enableFullRuntime: !lightweightRuntime });

    if (fullRuntime || setupRuntime) {
      this.registerLocalAgentIntegration(api, registrationMode);
    }
  }

  /**
   * Register DKG integration modules: channel, memory, write-capture.
   * Each module is optional — enabled via config flags.
   */
  private registerIntegrationModules(api: OpenClawPluginApi, opts?: { enableFullRuntime?: boolean }): void {
    // --- Channel module ---
    const channelConfig = this.config.channel;
    if (channelConfig?.enabled) {
      if (!this.channelPlugin) {
        this.channelPlugin = new DkgChannelPlugin(channelConfig, this.client);
      }
      this.channelPlugin.register(api);
      api.logger.info?.('[dkg] Channel module enabled — DKG UI bridge active');
    }

    if (!opts?.enableFullRuntime) {
      api.logger.info?.('[dkg] Lightweight OpenClaw registration — skipping full-runtime memory capture integrations');
      return;
    }

    // --- Memory module ---
    const memoryConfig = this.config.memory;
    if (memoryConfig?.enabled) {
      // Auto-detect memory directory from shared memory if not configured
      const memoryDir = memoryConfig.memoryDir
        ?? (api.workspaceDir ? `${api.workspaceDir}/memory` : undefined)
        ?? '';

      const effectiveConfig = { ...memoryConfig, memoryDir };

      // Memory search manager (reads)
      if (!this.memoryPlugin) {
        this.memoryPlugin = new DkgMemoryPlugin(this.client, effectiveConfig);
      }
      this.memoryPlugin.register(api);
      api.logger.info?.('[dkg] Memory module enabled — DKG-backed search active');

      // Write capture (writes)
      if (!this.writeCapture) {
        this.writeCapture = new WriteCapture(this.client, effectiveConfig);
        this.writeCapture.register(api);

        // Fire-and-forget: backlog import on first-ever install.
        // Runs at gateway startup (not session_start) so it works regardless
        // of which channel the user interacts through.
        if (!this.backlogImportDone) {
          this.backlogImportDone = this.runBacklogImportIfNeeded(api, this.client, effectiveConfig)
            .catch(err => api.logger.warn?.(`[dkg] Backlog import failed: ${err.message}`));
        }
      }
      api.logger.info?.('[dkg] Write capture enabled — hooks + file watcher active');
    }
  }

  private registerLocalAgentIntegration(api: OpenClawPluginApi, registrationMode: string): void {
    if (!this.config.channel?.enabled || !this.channelPlugin) {
      return;
    }

    const metadata = {
      channelId: 'dkg-ui',
      registrationMode,
      transportMode: this.channelPlugin.isUsingGatewayRoute ? 'gateway+bridge' : 'bridge',
    };
    const bridgeAlreadyReady = this.channelPlugin.isListening;
    const basePayload = {
      id: 'openclaw',
      enabled: true,
      description: 'Connect a local OpenClaw agent through the DKG node.',
      transport: this.buildOpenClawTransport(),
      capabilities: OPENCLAW_LOCAL_AGENT_CAPABILITIES,
      manifest: OPENCLAW_LOCAL_AGENT_MANIFEST,
      setupEntry: OPENCLAW_LOCAL_AGENT_MANIFEST.setupEntry,
      metadata,
    };

    this.client.connectLocalAgentIntegration({
      ...basePayload,
      runtime: {
        status: bridgeAlreadyReady ? 'ready' : 'connecting',
        ready: bridgeAlreadyReady,
        lastError: null,
      },
    }).catch(err => {
      api.logger.warn?.(`[dkg] Local agent registration failed (will retry on next gateway start): ${err.message}`);
    });

    if (bridgeAlreadyReady) {
      return;
    }

    void this.channelPlugin.start()
      .then(() => this.client.updateLocalAgentIntegration('openclaw', {
        ...basePayload,
        transport: this.buildOpenClawTransport(),
        runtime: {
          status: 'ready',
          ready: true,
          lastError: null,
        },
      }))
      .catch(async (err: any) => {
        api.logger.warn?.(`[dkg] OpenClaw channel startup did not reach ready state: ${err.message}`);
        try {
          await this.client.updateLocalAgentIntegration('openclaw', {
            ...basePayload,
            transport: this.buildOpenClawTransport(),
            runtime: {
              status: 'error',
              ready: false,
              lastError: err.message ?? String(err),
            },
          });
        } catch (updateErr: any) {
          api.logger.warn?.(`[dkg] Failed to persist OpenClaw channel error state: ${updateErr.message}`);
        }
      });
  }

  private warnOnLegacyGameConfig(api: OpenClawPluginApi): void {
    if (this.warnedLegacyGameConfig) return;
    const legacyGameConfig = (this.config as Record<string, unknown> | undefined)?.game as { enabled?: boolean } | undefined;
    if (legacyGameConfig?.enabled) {
      this.warnedLegacyGameConfig = true;
      api.logger.warn?.(
        '[dkg] Legacy dkg-node.game.enabled is no longer supported in the V10 OpenClaw adapter path; OriginTrail Game tools were intentionally removed.',
      );
    }
  }

  private buildOpenClawTransport(): { kind: string; bridgeUrl?: string; healthUrl?: string } {
    const transport: { kind: string; bridgeUrl?: string; healthUrl?: string } = {
      kind: 'openclaw-channel',
    };
    if (!this.channelPlugin) return transport;

    const bridgePort = this.channelPlugin.bridgePort;
    if (bridgePort > 0) {
      transport.bridgeUrl = `http://127.0.0.1:${bridgePort}`;
      transport.healthUrl = `${transport.bridgeUrl}/health`;
    }

    return transport;
  }

  async stop(): Promise<void> {
    // Stop integration modules
    this.writeCapture?.stop();
    await this.channelPlugin?.stop();
  }

  getClient(): DkgDaemonClient {
    if (!this.client) throw new Error('DkgNodePlugin.getClient() called before register()');
    return this.client;
  }

  // ---------------------------------------------------------------------------
  // Backlog import
  // ---------------------------------------------------------------------------

  /**
   * On first-ever install, import all existing memory files into the DKG graph.
   * Checks if any ImportedMemory items exist — if so, this isn't the first run.
   */
  private async runBacklogImportIfNeeded(
    api: OpenClawPluginApi,
    client: DkgDaemonClient,
    memoryConfig: NonNullable<DkgOpenClawConfig['memory']>,
  ): Promise<void> {
    // Check if any memories already exist in the graph
    const checkSparql = `SELECT (COUNT(?m) AS ?cnt) WHERE {
      { ?m a <http://dkg.io/ontology/ImportedMemory> . }
      UNION
      { GRAPH ?g { ?m a <http://dkg.io/ontology/ImportedMemory> . } }
    }`;

    try {
      const result = await client.query(checkSparql, {
        contextGraphId: 'agent-memory',
        includeSharedMemory: true,
      });
      const bindings = result?.result?.bindings ?? result?.results?.bindings ?? result?.bindings ?? [];
      const countRaw = bindings[0]?.cnt;
      const count = typeof countRaw === 'object' && countRaw?.value != null
        ? parseInt(String(countRaw.value), 10)
        : typeof countRaw === 'string'
          ? parseInt(countRaw.replace(/^"(\d+)".*$/, '$1'), 10)
          : 0;

      api.logger.debug?.(`[dkg] Backlog check: count=${count}, raw=${JSON.stringify(countRaw)}`);

      if (count > 0) {
        api.logger.info?.(`[dkg] Backlog import skipped — ${count} memories already in graph`);
        return;
      }
    } catch (err: any) {
      api.logger.warn?.(`[dkg] Backlog check failed: ${err.message} — skipping import`);
      return;
    }

    // First install — collect and import all memory files
    const filesToImport: string[] = [];
    const memoryDir = memoryConfig.memoryDir ?? '';

    // Collect MEMORY.md
    if (memoryDir) {
      const workspaceDir = dirname(resolve(memoryDir));
      const memoryMd = join(workspaceDir, 'MEMORY.md');
      if (existsSync(memoryMd)) filesToImport.push(memoryMd);
    }

    // Collect memory/*.md files
    if (memoryDir) {
      const absMemDir = resolve(memoryDir);
      if (existsSync(absMemDir)) {
        try {
          const entries = readdirSync(absMemDir, { recursive: true });
          for (const entry of entries) {
            const name = String(entry);
            if (name.endsWith('.md')) {
              filesToImport.push(join(absMemDir, name));
            }
          }
        } catch { /* scan failed — skip */ }
      }
    }

    if (filesToImport.length === 0) {
      api.logger.info?.('[dkg] Backlog import: no memory files found');
      return;
    }

    api.logger.info?.(`[dkg] Backlog import: importing ${filesToImport.length} memory file(s)…`);
    let imported = 0;

    for (const filePath of filesToImport) {
      try {
        const content = await readFile(filePath, 'utf-8');
        if (!content.trim()) continue;
        await client.importMemories(content.trim(), 'other', { useLlm: true });
        imported++;
        api.logger.info?.(`[dkg] Backlog import: imported ${filePath}`);
      } catch (err: any) {
        api.logger.warn?.(`[dkg] Backlog import failed for ${filePath}: ${err.message}`);
      }
    }

    api.logger.info?.(`[dkg] Backlog import complete: ${imported}/${filesToImport.length} files imported`);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private json(data: unknown): OpenClawToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], details: data };
  }

  private error(message: string): OpenClawToolResult {
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], details: { error: message } };
  }

  private daemonError(err: any): OpenClawToolResult {
    const msg = err.message ?? String(err);
    if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
      return this.error(
        'DKG daemon is not reachable. Make sure the daemon is running (dkg start) ' +
        `and accessible at ${this.client.baseUrl}.`,
      );
    }
    return this.error(msg);
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  private tools(): OpenClawTool[] {
    return [
      {
        name: 'dkg_status',
        description:
          'Show DKG node status: peer ID, connected peers, multiaddrs, and wallet addresses. ' +
          'Call this to verify the daemon is running and to diagnose connectivity issues.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (_toolCallId, _params) => this.handleStatus(),
      },
      {
        name: 'dkg_wallet_balances',
        description:
          'Check TRAC and ETH token balances for the node\'s operational wallets. ' +
          'Use this before publishing to verify sufficient funds. Returns per-wallet balances, ' +
          'chain ID, and RPC URL.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (_toolCallId, _params) => this.handleWalletBalances(),
      },
      {
        name: 'dkg_list_context_graphs',
        description:
          'List all contextGraphs this node knows about. Returns context graph IDs, names, subscription status, ' +
          'and sync status. Use this to discover available contextGraphs before publishing or querying.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (_toolCallId, _params) => this.handleListContextGraphs(),
      },
      {
        name: 'dkg_context_graph_create',
        description:
          'Create a new context graph on the DKG node. A context graph is a scoped knowledge domain ' +
          'that organizes published knowledge. Use dkg_list_context_graphs first to check if the ' +
          'context graph already exists. Returns the context graph ID and URI (did:dkg:context-graph:<id>). ' +
          'The ID is auto-generated from the name if not provided.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Human-readable context graph name (e.g. "My Research Context Graph")',
            },
            description: {
              type: 'string',
              description: 'Optional description of what this context graph contains',
            },
            id: {
              type: 'string',
              description: 'Optional custom context graph ID slug. Auto-generated from name if omitted (e.g. "My Research" → "my-research").',
            },
          },
          required: ['name'],
        },
        execute: async (_toolCallId, args) => this.handleContextGraphCreate(args),
      },
      {
        name: 'dkg_subscribe',
        description:
          'Subscribe to a context graph to receive its data and updates. Subscription is immediate; ' +
          'data sync from connected peers happens in the background and may take time depending on ' +
          'the context graph size. Use dkg_list_context_graphs to check sync status afterward.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: {
              type: 'string',
              description: 'Context Graph ID to subscribe to (e.g. "my-research")',
            },
            include_shared_memory: {
              type: 'string',
              description: 'Set to "false" to skip syncing shared memory data. Default: true.',
            },
          },
          required: ['context_graph_id'],
        },
        execute: async (_toolCallId, args) => this.handleSubscribe(args),
      },
      {
        name: 'dkg_publish',
        description:
          'Publish knowledge to a DKG context graph as an array of quads (subject/predicate/object). ' +
          'Data is first written to Shared Working Memory, then published to Verified Memory on-chain. ' +
          'Object values that look like URIs (http://, https://, urn:, did:) are treated as URIs; ' +
          'all other values become string literals automatically.',
        parameters: {
          type: 'object',
          properties: {
            context_graph_id: { type: 'string', description: 'Target context graph ID (e.g. "testing", "my-research")' },
            quads: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  subject: { type: 'string', description: 'Subject URI (e.g. "https://example.org/wine/cabernet")' },
                  predicate: { type: 'string', description: 'Predicate URI (e.g. "https://schema.org/name")' },
                  object: { type: 'string', description: 'Object — URI or plain literal value (e.g. "Cabernet Sauvignon" or "https://schema.org/Product")' },
                  graph: { type: 'string', description: 'Optional named graph URI' },
                },
                required: ['subject', 'predicate', 'object'],
              },
              description:
                'Array of quads to publish. Each quad has subject (URI), predicate (URI), and object (URI or literal string). ' +
                'URIs are auto-detected by prefix (http://, https://, urn:, did:); everything else becomes a literal.',
            },
          },
          required: ['context_graph_id', 'quads'],
        },
        execute: async (_toolCallId, args) => this.handlePublish(args),
      },
      {
        name: 'dkg_query',
        description:
          'Run a read-only SPARQL query (SELECT, CONSTRUCT, ASK, DESCRIBE) against the local DKG triple store. ' +
          'Use GRAPH ?g { ... } to match across named graphs. ' +
          'Queries are local and fast — no network round-trip.',
        parameters: {
          type: 'object',
          properties: {
            sparql: { type: 'string', description: 'SPARQL query string (SELECT, CONSTRUCT, ASK, or DESCRIBE)' },
            context_graph_id: { type: 'string', description: 'Optional context graph scope — omit to query all data' },
            include_shared_memory: { type: 'string', description: 'Set to "true" to also search shared memory (working/ephemeral) data. Default: false.' },
          },
          required: ['sparql'],
        },
        execute: async (_toolCallId, args) => this.handleQuery(args),
      },
      {
        name: 'dkg_find_agents',
        description:
          'Discover DKG agents on the network. Call with no parameters to list all known agents. ' +
          'Filter by framework (e.g. "OpenClaw", "ElizaOS") or by skill_type URI to find agents offering a specific capability.',
        parameters: {
          type: 'object',
          properties: {
            framework: { type: 'string', description: 'Filter by framework name (e.g. "OpenClaw", "ElizaOS")' },
            skill_type: { type: 'string', description: 'Filter by skill type URI (e.g. "ImageAnalysis")' },
          },
          required: [],
        },
        execute: async (_toolCallId, args) => this.handleFindAgents(args),
      },
      {
        name: 'dkg_send_message',
        description:
          'Send an end-to-end encrypted chat message to another DKG agent by their peer ID or name. ' +
          'Both agents must be online. Use dkg_find_agents first to discover peer IDs.',
        parameters: {
          type: 'object',
          properties: {
            peer_id: { type: 'string', description: 'Recipient peer ID (starts with 12D3KooW...) or agent name' },
            text: { type: 'string', description: 'Message text to send' },
          },
          required: ['peer_id', 'text'],
        },
        execute: async (_toolCallId, args) => this.handleSendMessage(args),
      },
      {
        name: 'dkg_read_messages',
        description:
          'Read P2P messages received from other DKG agents. Returns both sent and received messages. ' +
          'Filter by peer ID/name, limit results, or fetch messages since a timestamp.',
        parameters: {
          type: 'object',
          properties: {
            peer: { type: 'string', description: 'Filter by peer ID or agent name (optional)' },
            limit: { type: 'string', description: 'Maximum number of messages to return (default: 100)' },
            since: { type: 'string', description: 'Only return messages after this timestamp in ms (optional)' },
          },
          required: [],
        },
        execute: async (_toolCallId, args) => this.handleReadMessages(args),
      },
      {
        name: 'dkg_invoke_skill',
        description:
          'Invoke a remote agent\'s skill over the DKG network. ' +
          'Use dkg_find_agents with skill_type first to discover which agents offer the skill you need.',
        parameters: {
          type: 'object',
          properties: {
            peer_id: { type: 'string', description: 'Target agent peer ID (starts with 12D3KooW...) or agent name' },
            skill_uri: { type: 'string', description: 'Skill URI to invoke (e.g. "ImageAnalysis")' },
            input: { type: 'string', description: 'Input data as UTF-8 text' },
          },
          required: ['peer_id', 'skill_uri', 'input'],
        },
        execute: async (_toolCallId, args) => this.handleInvokeSkill(args),
      },

      // Legacy V9 tool name aliases for backward compatibility with existing agents/prompts
      {
        name: 'dkg_list_paranets',
        description: '[Deprecated: use dkg_list_context_graphs] List all context graphs (formerly paranets).',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (_toolCallId, _params) => this.handleListContextGraphs(),
      },
      {
        name: 'dkg_paranet_create',
        description: '[Deprecated: use dkg_context_graph_create] Create a new context graph (formerly paranet).',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Context graph name' },
            description: { type: 'string', description: 'Optional description' },
            paranet_id: { type: 'string', description: 'Optional custom ID slug' },
          },
          required: ['name'],
        },
        execute: async (_toolCallId, args) =>
          this.handleContextGraphCreate({ ...args, id: args.paranet_id ?? args.id }),
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Handlers — all route through DkgDaemonClient → daemon HTTP API
  // ---------------------------------------------------------------------------

  private async handleStatus(): Promise<OpenClawToolResult> {
    try {
      const [status, wallets] = await Promise.all([
        this.client.getFullStatus(),
        this.client.getWallets().catch(() => ({ wallets: [] })),
      ]);
      return this.json({ ...status, walletAddresses: wallets.wallets });
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleListContextGraphs(): Promise<OpenClawToolResult> {
    try {
      const result = await this.client.listContextGraphs();
      const graphs = result.contextGraphs;
      return this.json({ contextGraphs: graphs, count: graphs.length });
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handlePublish(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? args.paranet_id ?? '');
      const rawQuads = args.quads;

      if (!Array.isArray(rawQuads) || rawQuads.length === 0) {
        return this.error('"quads" must be a non-empty array of {subject, predicate, object} objects.');
      }

      // Convert agent-friendly quads to daemon format:
      // - subject/predicate: plain URI strings (passed as-is)
      // - object: auto-detect URI vs literal — URIs passed as-is, literals wrapped in ""
      const quads = rawQuads.map((q: any) => {
        const objVal = String(q.object ?? '');
        return {
          subject: String(q.subject ?? ''),
          predicate: String(q.predicate ?? ''),
          object: isUri(objVal) ? objVal : `"${objVal.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
          graph: q.graph ? String(q.graph) : '',
        };
      });

      const result = await this.client.publish(contextGraphId, quads);
      return this.json({ kcId: result.kcId, kaCount: result.kas?.length ?? 0, quadsPublished: quads.length });
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleQuery(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const sparql = String(args.sparql);
      const contextGraphId = (args.context_graph_id ?? args.paranet_id) ? String(args.context_graph_id ?? args.paranet_id) : undefined;
      const includeSharedMemory = args.include_shared_memory === 'true' || args.include_shared_memory === true;
      const result = await this.client.query(sparql, {
        contextGraphId,
        includeSharedMemory: includeSharedMemory || undefined,
      });
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleFindAgents(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const filter: { framework?: string; skill_type?: string } = {};
      if (args.framework) filter.framework = String(args.framework);
      if (args.skill_type) filter.skill_type = String(args.skill_type);
      const result = await this.client.getAgents(Object.keys(filter).length ? filter : undefined);
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleSendMessage(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const result = await this.client.sendChat(String(args.peer_id), String(args.text));
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleReadMessages(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const opts: { peer?: string; limit?: number; since?: number } = {};
      if (args.peer) opts.peer = String(args.peer);
      if (args.limit) {
        const n = parseInt(String(args.limit), 10);
        if (!isNaN(n) && n > 0) opts.limit = Math.min(n, 1000);
      }
      if (args.since) {
        const n = parseInt(String(args.since), 10);
        if (!isNaN(n)) opts.since = n;
      }
      const result = await this.client.getMessages(opts);
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleInvokeSkill(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const result = await this.client.invokeSkill(
        String(args.peer_id),
        String(args.skill_uri),
        String(args.input),
      );
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleContextGraphCreate(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const name = String(args.name ?? '').trim();
      if (!name) {
        return this.error('"name" is required.');
      }
      const explicitId = args.id != null && String(args.id).trim();
      const id = explicitId || slugify(name);
      if (!id) {
        return this.error('Could not derive a valid context graph ID from the name. Provide an explicit "id".');
      }
      if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(id)) {
        return this.error(
          `Invalid context graph ID "${id}". Use lowercase letters, numbers, and hyphens (e.g. "my-research"). ` +
          'Must start and end with a letter or number.',
        );
      }
      const description = args.description ? String(args.description).trim() : undefined;
      const result = await this.client.createContextGraph(id, name, description);
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleSubscribe(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const contextGraphId = String(args.context_graph_id ?? args.paranet_id ?? '').trim();
      if (!contextGraphId) {
        return this.error('"context_graph_id" is required.');
      }
      const includeSharedMemory = args.include_shared_memory === 'false' ? false : undefined;
      const result = await this.client.subscribe(contextGraphId, {
        includeSharedMemory,
      });
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleWalletBalances(): Promise<OpenClawToolResult> {
    try {
      const result = await this.client.getWalletBalances();
      return this.json(result);
    } catch (err: any) {
      return this.daemonError(err);
    }
  }
}

/** Convert a human-readable name into a URL-safe slug (e.g. "My Research Context Graph" → "my-research-context-graph"). */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // replace non-alphanumeric runs with a single hyphen
    .replace(/^-+|-+$/g, '');      // strip leading/trailing hyphens
}

/** Check if a value looks like a URI (starts with a known scheme). */
function isUri(value: string): boolean {
  return /^(?:https?:\/\/|urn:|did:)/i.test(value);
}
