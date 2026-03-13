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

  constructor(config?: DkgOpenClawConfig) {
    this.config = { ...config };
  }

  /**
   * Register the DKG plugin with an OpenClaw plugin API instance.
   * Registers lifecycle hooks, agent-facing tools, and integration modules.
   */
  register(api: OpenClawPluginApi): void {
    // Create daemon client — used by all tools and integration modules
    const daemonUrl = this.config.daemonUrl ?? 'http://127.0.0.1:9200';
    this.client = new DkgDaemonClient({ baseUrl: daemonUrl });

    api.registerHook('session_end', () => this.stop(), { name: 'dkg-node-stop' });

    // Self-register with daemon so the UI knows the OpenClaw adapter is in use.
    // Fire-and-forget — non-fatal if daemon is temporarily unreachable.
    this.client.registerAdapter('openclaw').catch(err => {
      api.logger.warn?.(`[dkg] Adapter registration failed (will retry on next gateway start): ${err.message}`);
    });

    for (const tool of this.tools()) {
      api.registerTool(tool);
    }

    // --- Integration modules ---
    this.registerIntegrationModules(api);
  }

  /**
   * Register DKG integration modules: channel, memory, write-capture.
   * Each module is optional — enabled via config flags.
   */
  private registerIntegrationModules(api: OpenClawPluginApi): void {
    // --- Channel module ---
    const channelConfig = this.config.channel;
    if (channelConfig?.enabled) {
      this.channelPlugin = new DkgChannelPlugin(channelConfig, this.client);
      this.channelPlugin.register(api);
      api.logger.info?.('[dkg] Channel module enabled — DKG UI bridge active');
    }

    // --- Memory module ---
    const memoryConfig = this.config.memory;
    if (memoryConfig?.enabled) {
      // Auto-detect memory directory from workspace if not configured
      const memoryDir = memoryConfig.memoryDir
        ?? (api.workspaceDir ? `${api.workspaceDir}/memory` : undefined)
        ?? '';

      const effectiveConfig = { ...memoryConfig, memoryDir };

      // Memory search manager (reads)
      this.memoryPlugin = new DkgMemoryPlugin(this.client, effectiveConfig);
      this.memoryPlugin.register(api);
      api.logger.info?.('[dkg] Memory module enabled — DKG-backed search active');

      // Write capture (writes)
      this.writeCapture = new WriteCapture(this.client, effectiveConfig);
      this.writeCapture.register(api);

      // Fire-and-forget: backlog import on first-ever install.
      // Runs at gateway startup (not session_start) so it works regardless
      // of which channel the user interacts through.
      if (!this.backlogImportDone) {
        this.backlogImportDone = this.runBacklogImportIfNeeded(api, this.client, effectiveConfig)
          .catch(err => api.logger.warn?.(`[dkg] Backlog import failed: ${err.message}`));
      }

      api.logger.info?.('[dkg] Write capture enabled — hooks + file watcher active');
    }
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
      ?m a <http://dkg.io/ontology/ImportedMemory> .
    }`;

    try {
      const result = await client.query(checkSparql, {
        paranetId: 'agent-memory',
        includeWorkspace: true,
      });
      const bindings = result?.result?.bindings ?? result?.results?.bindings ?? result?.bindings ?? [];
      const countRaw = bindings[0]?.cnt;
      const count = typeof countRaw === 'object' && countRaw?.value != null
        ? parseInt(String(countRaw.value), 10)
        : typeof countRaw === 'string'
          ? parseInt(countRaw.replace(/^"(\d+)".*$/, '$1'), 10)
          : 0;

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
        name: 'dkg_list_paranets',
        description:
          'List all paranets this node knows about. Returns paranet IDs, names, subscription status, ' +
          'and sync status. Use this to discover available paranets before publishing or querying.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (_toolCallId, _params) => this.handleListParanets(),
      },
      {
        name: 'dkg_publish',
        description:
          'Publish RDF triples (N-Quads format) to a DKG paranet. ' +
          'Each line is: <subject> <predicate> <object> . (with angle brackets and a trailing dot). ' +
          'Example N-Quads: <did:dkg:entity:alice> <https://schema.org/name> "Alice" .',
        parameters: {
          type: 'object',
          properties: {
            paranet_id: { type: 'string', description: 'Target paranet ID (e.g. "testing", "my-research")' },
            nquads: { type: 'string', description: 'N-Quads triples, one per line. Each line: <subject> <predicate> "literal" or <uri> .' },
          },
          required: ['paranet_id', 'nquads'],
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
            paranet_id: { type: 'string', description: 'Optional paranet scope — omit to query all data' },
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

  private async handleListParanets(): Promise<OpenClawToolResult> {
    try {
      const result = await this.client.listParanets();
      return this.json({ paranets: result.paranets, count: result.paranets.length });
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handlePublish(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const paranetId = String(args.paranet_id);
      const nquadsText = String(args.nquads);

      const quads = parseNQuadsText(nquadsText);
      if (quads.length === 0) {
        return this.error(
          'No valid N-Quads parsed from input. Each line must be: <subject> <predicate> <object> . ' +
          'Example: <did:dkg:entity:x> <https://schema.org/name> "Hello" .',
        );
      }
      const result = await this.client.publish(paranetId, quads);
      return this.json({ kcId: result.kcId, kaCount: result.kas?.length ?? 0, triplesPublished: quads.length });
    } catch (err: any) {
      return this.daemonError(err);
    }
  }

  private async handleQuery(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      const sparql = String(args.sparql);
      const paranetId = args.paranet_id ? String(args.paranet_id) : undefined;
      const result = await this.client.query(sparql, { paranetId });
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
}

function parseNQuadsText(text: string): Array<{ subject: string; predicate: string; object: string; graph?: string }> {
  const quads: Array<{ subject: string; predicate: string; object: string; graph?: string }> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^<([^>]+)>\s+<([^>]+)>\s+("[^"]*(?:\\.[^"]*)*"(?:@\w+|(?:\^\^<[^>]+>))?|<[^>]+>)\s*(?:<([^>]+)>)?\s*\.?\s*$/);
    if (!match) continue;
    quads.push({
      subject: match[1],
      predicate: match[2],
      object: match[3].startsWith('<') ? match[3].slice(1, -1) : match[3],
      graph: match[4],
    });
  }
  return quads;
}
