/**
 * DkgNodePlugin — OpenClaw adapter that turns any OpenClaw agent into a
 * DKG V9 node.
 *
 * Wraps a `DKGAgent` and exposes its capabilities as OpenClaw tools.
 * The agent starts lazily on first tool call (or on `session_start`) and
 * stops on `session_end`.
 *
 * Phase 0 extensions (spike):
 *   - DKG UI channel bridge (DkgChannelPlugin)
 *   - DKG-backed memory search (DkgMemoryPlugin)
 *   - Memory write capture (WriteCapture)
 */
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { DKGAgent, type DKGAgentConfig } from '@dkg/agent';
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
  private agent: DKGAgent | null = null;
  private starting: Promise<void> | null = null;
  private readonly config: DkgOpenClawConfig;

  // Integration modules (Phase 0 spike)
  private client: DkgDaemonClient | null = null;
  private channelPlugin: DkgChannelPlugin | null = null;
  private memoryPlugin: DkgMemoryPlugin | null = null;
  private writeCapture: WriteCapture | null = null;
  /** Guard: backlog import runs at most once per plugin lifecycle. */
  private backlogImportDone: Promise<void> | null = null;

  constructor(config?: DkgOpenClawConfig) {
    this.config = {
      dataDir: '.dkg/openclaw',
      ...config,
    };
  }

  /**
   * Register the DKG plugin with an OpenClaw plugin API instance.
   * Registers lifecycle hooks, agent-facing tools, and integration modules.
   */
  register(api: OpenClawPluginApi): void {
    api.registerHook('session_start', () => this.start(), { name: 'dkg-node-start' });
    api.registerHook('session_end', () => this.stop(), { name: 'dkg-node-stop' });

    for (const tool of this.tools()) {
      api.registerTool(tool);
    }

    // --- Integration modules (Phase 0) ---
    this.registerIntegrationModules(api);
  }

  /**
   * Register DKG integration modules: channel, memory, write-capture.
   * Each module is optional — enabled via config flags.
   */
  private registerIntegrationModules(api: OpenClawPluginApi): void {
    const daemonUrl = this.config.daemonUrl ?? 'http://127.0.0.1:9200';
    this.client = new DkgDaemonClient({ baseUrl: daemonUrl });

    // --- Channel module (Spike A) ---
    const channelConfig = this.config.channel;
    if (channelConfig?.enabled) {
      this.channelPlugin = new DkgChannelPlugin(channelConfig, this.client);
      this.channelPlugin.register(api);
      api.logger.info?.('[dkg] Channel module enabled — DKG UI bridge active');
    }

    // --- Memory module (Spike B) ---
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

      // Start file watcher on session_start.
      // Stop is handled by DkgNodePlugin.stop() — no separate session_end hook
      // needed to avoid double-stop.
      api.registerHook('session_start', async () => {
        this.writeCapture?.startFileWatcher(memoryDir);

        // Fire-and-forget: backlog import on first-ever install (runs at most once)
        if (!this.backlogImportDone) {
          this.backlogImportDone = this.runBacklogImportIfNeeded(api, this.client!, effectiveConfig)
            .catch(err => api.logger.warn?.(`[dkg] Backlog import failed: ${err.message}`));
        }
      }, { name: 'dkg-write-watcher-start' });

      api.logger.info?.('[dkg] Write capture enabled — hooks + file watcher active');
    }
  }

  async start(): Promise<void> {
    if (this.agent) return;
    // Prevent concurrent callers from double-initializing
    if (this.starting) return this.starting;
    this.starting = this.doStart();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async doStart(): Promise<void> {
    const chainKey = this.config.chainConfig?.privateKey;
    const agentConfig: DKGAgentConfig = {
      name: this.config.name ?? 'openclaw-agent',
      framework: 'OpenClaw',
      description: this.config.description,
      listenPort: this.config.listenPort,
      dataDir: this.config.dataDir,
      relayPeers: this.config.relayPeers,
      bootstrapPeers: this.config.bootstrapPeers,
      chainConfig: chainKey ? {
        rpcUrl: this.config.chainConfig?.rpcUrl ?? 'https://sepolia.base.org',
        hubAddress: this.config.chainConfig?.hubAddress ?? '0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6',
        operationalKeys: [chainKey],
      } : undefined,
      skills: this.config.skills?.map(s => ({
        skillType: s.skillType,
        pricePerCall: s.pricePerCall,
        currency: s.currency,
        handler: async (req: any) => {
          const result = await s.handler(req.inputData);
          return {
            success: result.status === 'ok',
            outputData: result.output,
            error: result.error,
          };
        },
      })),
    };

    this.agent = await DKGAgent.create(agentConfig);
    await this.agent.start();
    await this.agent.publishProfile();
  }

  async stop(): Promise<void> {
    // If currently starting, wait for it to finish before stopping
    if (this.starting) {
      try { await this.starting; } catch { /* stop anyway */ }
    }

    // Stop integration modules
    this.writeCapture?.stop();
    await this.channelPlugin?.stop();

    if (!this.agent) return;
    await this.agent.stop();
    this.agent = null;
  }

  getAgent(): DKGAgent | null {
    return this.agent;
  }

  getClient(): DkgDaemonClient | null {
    return this.client;
  }

  // ---------------------------------------------------------------------------
  // Backlog import (Phase 3, Layer 1)
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

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  private tools(): OpenClawTool[] {
    return [
      {
        name: 'dkg_status',
        description:
          'Show DKG node status: peer ID, connected peers, and multiaddrs. ' +
          'Call this to verify the node is running and to diagnose connectivity issues. ' +
          'Returns config summary if the node has not started yet.',
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
        },
        execute: async (_toolCallId, args) => this.handleFindAgents(args),
      },
      {
        name: 'dkg_send_message',
        description:
          'Send an end-to-end encrypted chat message to another DKG agent by their peer ID. ' +
          'Both agents must be online. Use dkg_find_agents first to discover peer IDs.',
        parameters: {
          type: 'object',
          properties: {
            peer_id: { type: 'string', description: 'Recipient peer ID (starts with 12D3KooW...)' },
            text: { type: 'string', description: 'Message text to send' },
          },
          required: ['peer_id', 'text'],
        },
        execute: async (_toolCallId, args) => this.handleSendMessage(args),
      },
      {
        name: 'dkg_invoke_skill',
        description:
          'Invoke a remote agent\'s skill over the DKG network. ' +
          'Use dkg_find_agents with skill_type first to discover which agents offer the skill you need.',
        parameters: {
          type: 'object',
          properties: {
            peer_id: { type: 'string', description: 'Target agent peer ID (starts with 12D3KooW...)' },
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
  // Handlers
  // ---------------------------------------------------------------------------

  private async handleStatus(): Promise<OpenClawToolResult> {
    try {
      await this.start();
      const agent = this.agent!;
      const peers = agent.node.libp2p.getPeers();
      return this.json({
        status: 'running',
        peerId: agent.peerId,
        multiaddrs: agent.multiaddrs,
        connectedPeers: peers.map(p => p.toString()),
        peerCount: peers.length,
      });
    } catch (err: any) {
      // Return config summary so the agent can diagnose what went wrong
      return this.json({
        status: 'error',
        error: err.message,
        config: {
          name: this.config.name ?? 'openclaw-agent',
          dataDir: this.config.dataDir,
          relayPeers: this.config.relayPeers,
          hasChainKey: !!this.config.chainConfig?.privateKey,
        },
      });
    }
  }

  private async handleListParanets(): Promise<OpenClawToolResult> {
    try {
      await this.start();
      const paranets = await this.agent!.listParanets();
      return this.json({ paranets, count: paranets.length });
    } catch (err: any) {
      return this.error(err.message ?? 'Failed to list paranets');
    }
  }

  private async handlePublish(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      await this.start();
      const agent = this.agent!;
      const paranetId = String(args.paranet_id);
      const nquadsText = String(args.nquads);

      const quads = parseNQuadsText(nquadsText);
      if (quads.length === 0) {
        return this.error(
          'No valid N-Quads parsed from input. Each line must be: <subject> <predicate> <object> . ' +
          'Example: <did:dkg:entity:x> <https://schema.org/name> "Hello" .',
        );
      }
      const result = await agent.publish(paranetId, quads as any);
      return this.json({ kcId: result.kcId, kaCount: result.kaManifest.length, triplesPublished: quads.length });
    } catch (err: any) {
      return this.error(err.message);
    }
  }

  private async handleQuery(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      await this.start();
      const agent = this.agent!;
      const sparql = String(args.sparql);
      const paranetId = args.paranet_id ? String(args.paranet_id) : undefined;
      const result = await agent.query(sparql, paranetId);
      return this.json(result);
    } catch (err: any) {
      return this.error(err.message);
    }
  }

  private async handleFindAgents(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      await this.start();
      const agent = this.agent!;

      if (args.skill_type) {
        const offerings = await agent.findSkills({ skillType: String(args.skill_type) });
        return this.json(offerings);
      }

      const agents = await agent.findAgents(
        args.framework ? { framework: String(args.framework) } : undefined,
      );
      return this.json(agents);
    } catch (err: any) {
      return this.error(err.message);
    }
  }

  private async handleSendMessage(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      await this.start();
      const agent = this.agent!;
      const result = await agent.sendChat(String(args.peer_id), String(args.text));
      return this.json(result);
    } catch (err: any) {
      return this.error(err.message);
    }
  }

  private async handleInvokeSkill(args: Record<string, unknown>): Promise<OpenClawToolResult> {
    try {
      await this.start();
      const agent = this.agent!;
      const response = await agent.invokeSkill(
        String(args.peer_id),
        String(args.skill_uri),
        new TextEncoder().encode(String(args.input)),
      );
      return this.json({
        success: response.success,
        output: response.outputData ? new TextDecoder().decode(response.outputData) : undefined,
        error: response.error,
      });
    } catch (err: any) {
      return this.error(err.message);
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
