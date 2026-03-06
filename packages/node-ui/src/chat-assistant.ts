import type { DashboardDB } from './db.js';
import type { MemoryToolContext } from './chat-memory.js';

export interface ChatRequest {
  message: string;
}

export interface ChatResponse {
  reply: string;
  data?: unknown;
  sparql?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
}

/** OpenAI-compatible LLM config for natural language answers and NL→SPARQL. */
export interface LlmConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
  systemPrompt?: string;
}

type QueryFn = (sparql: string) => Promise<{ bindings: Array<Record<string, string>> }>;

const HELP_REPLY = `I'm your node assistant. You can ask me about this node (uptime, peers, triples, operations, logs) or just chat. When you ask me to save or add information to the DKG, I can write it to the knowledge graph (workspace) and optionally finalize it on-chain. Our conversation is stored privately in your DKG.`;

/** OpenAI function tool definition for LLM tool calling */
interface ToolParam {
  type: string;
  description?: string;
  items?: { type: string; properties?: Record<string, ToolParam>; required?: string[] };
}
interface OpenAITool {
  type: 'function';
  function: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, ToolParam>; required?: string[] } };
}

const DKG_TOOLS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'dkg_query',
      description: 'Run a read-only SPARQL query (SELECT, CONSTRUCT, ASK, DESCRIBE) against the node\'s knowledge graph. Use to read data. Add LIMIT for safety.',
      parameters: {
        type: 'object',
        properties: {
          sparql: { type: 'string', description: 'The SPARQL query' },
          paranetId: { type: 'string', description: 'Optional paranet id; omit for "all"' },
        },
        required: ['sparql'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dkg_write_to_workspace',
      description: 'Add RDF triples to a paranet\'s workspace. Use when the user asks to save, add, or remember something. Use paranetId "agent-memory" for personal notes. For literal values use plain strings (e.g. "Tesla"). For URIs use full URIs (e.g. "http://example.org/Tesla").',
      parameters: {
        type: 'object',
        properties: {
          paranetId: { type: 'string', description: 'Paranet id (e.g. agent-memory)' },
          quads: {
            type: 'array',
            description: 'Array of RDF triples to write',
            items: {
              type: 'object',
              properties: {
                subject: { type: 'string', description: 'Subject URI' },
                predicate: { type: 'string', description: 'Predicate URI' },
                object: { type: 'string', description: 'Object URI or literal string value' },
                graph: { type: 'string', description: 'Named graph (use empty string for default)' },
              },
              required: ['subject', 'predicate', 'object'],
            },
          },
        },
        required: ['paranetId', 'quads'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dkg_list_paranets',
      description: 'List paranets this node knows about.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dkg_create_paranet',
      description: 'Create a new paranet (knowledge graph namespace). Use when the user wants to create a new graph/paranet.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Paranet id (e.g. my-data)' },
          name: { type: 'string', description: 'Human-readable name' },
          description: { type: 'string', description: 'Optional description' },
        },
        required: ['id', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dkg_enshrine',
      description: 'Promote workspace content to the chain (finalize). Use when the user asks to finalize, publish to chain, or make data permanent.',
      parameters: {
        type: 'object',
        properties: {
          paranetId: { type: 'string' },
          selection: { type: 'string', description: '"all" or comma-separated root entity URIs' },
        },
        required: ['paranetId', 'selection'],
      },
    },
  },
];

/**
 * Chat assistant: rule-based answers plus optional LLM for natural language,
 * NL→SPARQL, and DKG API tools (query, write to workspace, list/create paranets, enshrine).
 */
export class ChatAssistant {
  private llmConfig?: LlmConfig;

  constructor(
    private readonly db: DashboardDB,
    private readonly queryFn: QueryFn,
    llmConfig?: LlmConfig,
    private readonly agentTools?: MemoryToolContext,
  ) {
    this.llmConfig = llmConfig;
  }

  updateLlmConfig(llmConfig: LlmConfig | undefined): void {
    this.llmConfig = llmConfig;
  }

  getLlmConfig(): { configured: boolean; model?: string; baseURL?: string } {
    return {
      configured: !!this.llmConfig?.apiKey,
      model: this.llmConfig?.model,
      baseURL: this.llmConfig?.baseURL,
    };
  }

  private systemPrompt(): string {
    let p = this.llmConfig?.systemPrompt ?? `You are a friendly DKG node assistant. Chat naturally and helpfully. The user's conversations with you are stored privately as memories in their DKG.

- Prefer normal, conversational replies. Do not suggest SPARQL or ask if they want to run a query unless they explicitly ask to query the graph or run SPARQL.
- For questions about the node (uptime, peers, triples, CPU, memory, operations, logs), give a short direct answer.
- Only output a SPARQL query in a markdown code block when the user clearly asks to query the knowledge graph or to "run a query" or "show data". Use this format exactly:
\`\`\`sparql
SELECT ...
\`\`\`
Otherwise, just answer in plain language. Keep any queries read-only (SELECT, CONSTRUCT, ASK, DESCRIBE) and add LIMIT 50 or similar.`;
    if (this.agentTools) {
      p += `

You have DKG tools: dkg_query (read graph), dkg_write_to_workspace (add/save triples), dkg_list_paranets, dkg_create_paranet, dkg_enshrine (finalize workspace to chain). When the user asks to save, add, or remember something in the DKG, use dkg_write_to_workspace with paranetId "agent-memory" for personal knowledge. Use proper RDF URIs (e.g. http://schema.org/name for "name"). For literals use quoted strings like "value".`;
    }
    return p;
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<{ result: unknown; summary: string }> {
    if (!this.agentTools) return { result: null, summary: 'Tools not available' };
    try {
      switch (name) {
        case 'dkg_query': {
          const sparql = String(args.sparql ?? '');
          const paranetId = args.paranetId != null ? String(args.paranetId) : undefined;
          const res = await this.agentTools.query(sparql, { paranetId, includeWorkspace: paranetId === 'agent-memory' });
          const bindings = res?.result?.bindings ?? res?.bindings ?? [];
          return { result: bindings, summary: `Query returned ${bindings.length} result(s).` };
        }
        case 'dkg_write_to_workspace': {
          const paranetId = String(args.paranetId ?? '');
          let raw: unknown = args.quads;
          if (typeof raw === 'string') {
            raw = parseQuadsJson(raw);
          }
          const quads = Array.isArray(raw) ? raw.map((q: any) => ({
            subject: String(q.subject ?? ''),
            predicate: String(q.predicate ?? ''),
            object: String(q.object ?? ''),
            graph: typeof q.graph === 'string' ? q.graph : '',
          })).filter(q => q.subject && q.predicate && q.object) : [];
          if (quads.length === 0) {
            return { result: { error: 'No valid quads to write' }, summary: 'No valid quads could be parsed from the input.' };
          }
          const { workspaceOperationId } = await this.agentTools.writeToWorkspace(paranetId, quads);
          return { result: { workspaceOperationId, tripleCount: quads.length }, summary: `Successfully wrote ${quads.length} triple(s) to workspace (paranet: ${paranetId}).` };
        }
        case 'dkg_list_paranets': {
          const list = await this.agentTools.listParanets();
          const arr = Array.isArray(list) ? list : [];
          return { result: arr, summary: `Found ${arr.length} paranet(s).` };
        }
        case 'dkg_create_paranet': {
          await this.agentTools.createParanet({
            id: String(args.id ?? ''),
            name: String(args.name ?? ''),
            description: args.description != null ? String(args.description) : undefined,
          });
          return { result: { id: args.id, name: args.name }, summary: `Created paranet "${args.name}" (${args.id}).` };
        }
        case 'dkg_enshrine': {
          const paranetId = String(args.paranetId ?? '');
          const sel = String(args.selection ?? 'all');
          const selection = sel === 'all' ? 'all' as const : { rootEntities: sel.split(',').map(s => s.trim()).filter(Boolean) };
          const res = await this.agentTools.enshrineFromWorkspace(paranetId, selection);
          return { result: res, summary: `Enshrined workspace content for paranet ${paranetId}.` };
        }
        default:
          return { result: null, summary: `Unknown tool: ${name}` };
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      return { result: { error: msg }, summary: `Error executing ${name}: ${msg}` };
    }
  }

  private async callLlm(userMessage: string, toolCallsCollector?: Array<{ name: string; args: Record<string, unknown>; result: unknown }>): Promise<string> {
    if (!this.llmConfig) throw new Error('LLM not configured');
    const { apiKey, model = 'gpt-4o-mini', baseURL = 'https://api.openai.com/v1' } = this.llmConfig;
    const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;

    type Message = { role: 'system' | 'user' | 'assistant'; content?: string; tool_calls?: any[]; tool_call_id?: string; name?: string; function?: { name: string; arguments: string } };
    const messages: Message[] = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'user', content: userMessage },
    ];

    const maxToolRounds = 3;
    let round = 0;
    let lastContent = '';

    while (round < maxToolRounds) {
      const body: Record<string, unknown> = {
        model,
        messages,
        max_tokens: 1024,
      };
      if (this.agentTools) {
        body.tools = DKG_TOOLS;
        body.tool_choice = 'auto';
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`LLM API ${res.status}: ${err.slice(0, 200)}`);
      }
      const data = await res.json() as {
        choices?: Array<{
          message?: {
            content?: string;
            tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
          };
        }>;
      };
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('Empty LLM response');

      lastContent = (msg.content ?? '').trim();

      const toolCalls = msg.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        if (lastContent) return lastContent;
        continue;
      }

      messages.push({
        role: 'assistant',
        content: msg.content ?? undefined,
        tool_calls: toolCalls.map((tc: any) => ({ id: tc.id, type: 'function', function: tc.function })),
      });

      for (const tc of toolCalls) {
        const name = tc.function?.name ?? '';
        let args: Record<string, unknown> = {};
        try {
          args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : {};
        } catch {
          args = {};
        }
        const { result, summary } = await this.executeTool(name, args);
        if (toolCallsCollector) toolCallsCollector.push({ name, args, result });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: typeof summary === 'string' ? summary : JSON.stringify(result ?? summary),
        } as any);
      }
      round++;
    }

    return lastContent || 'I used the available tools but could not produce a final reply. Please try rephrasing.';
  }

  private extractSparql(text: string): string | null {
    const match = text.match(/```(?:sparql)?\s*([\s\S]*?)```/);
    return match ? match[1].trim() : null;
  }

  private looksLikeAction(q: string): boolean {
    return /\b(create|add|save|store|write|publish|remember|enshrine|finalize|make|build|generate|insert|update|delete|remove)\b/.test(q);
  }

  async answer(req: ChatRequest): Promise<ChatResponse> {
    const q = req.message.toLowerCase().trim();

    // If LLM + tools are available and the message looks like an action,
    // skip rule-based handlers and let the LLM decide which tools to call.
    if (this.llmConfig && this.agentTools && this.looksLikeAction(q)) {
      return this.llmAnswer(req);
    }

    // --- Uptime ---
    if (matches(q, ['uptime', 'how long', 'running for', 'up for'])) {
      const snap = this.db.getLatestSnapshot();
      if (!snap) return { reply: 'No metrics collected yet. The node may have just started.' };
      const dur = formatSeconds(snap.uptime_seconds ?? 0);
      return { reply: `The node has been running for **${dur}**.`, data: { uptimeSeconds: snap.uptime_seconds } };
    }

    // --- Peer count ---
    if (matches(q, ['how many peers', 'peer count', 'connected peers', 'connections'])) {
      const snap = this.db.getLatestSnapshot();
      if (!snap) return { reply: 'No metrics yet.' };
      return {
        reply: `Currently connected to **${snap.peer_count}** peer(s): ${snap.direct_peers} direct, ${snap.relayed_peers} relayed.`,
        data: { peers: snap.peer_count, direct: snap.direct_peers, relayed: snap.relayed_peers },
      };
    }

    // --- Triple count ---
    if (matches(q, ['how many triples', 'triple count', 'total triples', 'graph size'])) {
      const snap = this.db.getLatestSnapshot();
      if (!snap) return { reply: 'No metrics yet.' };
      return {
        reply: `The knowledge graph contains **${snap.total_triples ?? 0}** triples across **${snap.total_kcs ?? 0}** Knowledge Collections and **${snap.total_kas ?? 0}** Knowledge Assets.`,
        data: { triples: snap.total_triples, kcs: snap.total_kcs, kas: snap.total_kas },
      };
    }

    // --- CPU / memory ---
    if (matches(q, ['cpu', 'memory', 'ram', 'resource', 'hardware', 'system health'])) {
      const snap = this.db.getLatestSnapshot();
      if (!snap) return { reply: 'No metrics yet.' };
      const memMb = snap.mem_used_bytes ? Math.round(snap.mem_used_bytes / 1048576) : '?';
      const totalMb = snap.mem_total_bytes ? Math.round(snap.mem_total_bytes / 1048576) : '?';
      return {
        reply: `**CPU**: ${snap.cpu_percent ?? 0}%  \n**Memory**: ${memMb} MB / ${totalMb} MB  \n**Heap**: ${snap.heap_used_bytes ? Math.round(snap.heap_used_bytes / 1048576) : '?'} MB`,
        data: { cpu: snap.cpu_percent, memUsed: snap.mem_used_bytes, memTotal: snap.mem_total_bytes },
      };
    }

    // --- Failed operations ---
    if (matches(q, ['failed', 'errors', 'error rate', 'failures'])) {
      const { operations, total } = this.db.getOperations({ status: 'error', limit: 5 });
      if (total === 0) return { reply: 'No failed operations found. Everything is running smoothly.' };
      const lines = operations.map(o => `- **${o.operation_name}** (${timeAgo(o.started_at)}): ${o.error_message}`).join('\n');
      return {
        reply: `Found **${total}** failed operation(s). Most recent:\n\n${lines}`,
        data: { total, recent: operations },
      };
    }

    // --- Operations summary ---
    if (matches(q, ['operations', 'how many operations', 'operation count', 'what did', 'processed'])) {
      const { total: allTotal } = this.db.getOperations({});
      const { total: pubTotal } = this.db.getOperations({ name: 'publish' });
      const { total: queryTotal } = this.db.getOperations({ name: 'query' });
      const { total: syncTotal } = this.db.getOperations({ name: 'sync' });
      return {
        reply: `**${allTotal}** total operations: ${pubTotal} publishes, ${queryTotal} queries, ${syncTotal} syncs.`,
        data: { total: allTotal, publish: pubTotal, query: queryTotal, sync: syncTotal },
      };
    }

    // --- Paranets ---
    if (matches(q, ['paranet', 'which paranet', 'subscribed'])) {
      const sparql = `SELECT DISTINCT ?id ?name WHERE { ?p <https://schema.org/name> ?name . ?p <urn:dkg:paranetId> ?id }`;
      try {
        const result = await this.queryFn(sparql);
        if (result.bindings.length === 0) return { reply: 'No paranets found in the store.', sparql };
        const list = result.bindings.map(b => `- **${b.name}** (\`${b.id}\`)`).join('\n');
        return { reply: `Known paranets:\n\n${list}`, data: result.bindings, sparql };
      } catch {
        return { reply: 'Could not query paranets from the triple store.' };
      }
    }

    // --- Agents ---
    if (matches(q, ['agent', 'who is', 'which agents', 'discovered agents', 'nodes on'])) {
      const sparql = `SELECT ?name ?peerId WHERE { ?a <urn:dkg:agentName> ?name ; <urn:dkg:peerId> ?peerId }`;
      try {
        const result = await this.queryFn(sparql);
        if (result.bindings.length === 0) return { reply: 'No agents discovered yet.', sparql };
        const list = result.bindings.map(b => `- **${b.name}** (\`${b.peerId?.slice(0, 16)}...\`)`).join('\n');
        return { reply: `Discovered **${result.bindings.length}** agent(s):\n\n${list}`, data: result.bindings, sparql };
      } catch {
        return { reply: 'Could not query agents from the triple store.' };
      }
    }

    // --- KCs in a paranet ---
    if (q.includes('kc') && (q.includes('testing') || q.includes('paranet'))) {
      const paranet = q.includes('testing') ? 'testing' : 'agents';
      const sparql = `SELECT ?kc ?status WHERE { GRAPH <urn:dkg:paranet:${paranet}:meta> { ?kc a <urn:dkg:KC> . OPTIONAL { ?kc <urn:dkg:status> ?status } } } LIMIT 20`;
      try {
        const result = await this.queryFn(sparql);
        if (result.bindings.length === 0) return { reply: `No KCs found in the "${paranet}" paranet.`, sparql };
        return {
          reply: `Found **${result.bindings.length}** KC(s) in the "${paranet}" paranet.`,
          data: result.bindings,
          sparql,
        };
      } catch {
        return { reply: `Could not query KCs for paranet "${paranet}".` };
      }
    }

    // --- Store / disk ---
    if (matches(q, ['store', 'disk', 'storage', 'how big'])) {
      const snap = this.db.getLatestSnapshot();
      if (!snap) return { reply: 'No metrics yet.' };
      const storeMb = snap.store_bytes ? (snap.store_bytes / 1048576).toFixed(2) : '?';
      const diskUsedGb = snap.disk_used_bytes ? (snap.disk_used_bytes / 1073741824).toFixed(1) : '?';
      const diskTotalGb = snap.disk_total_bytes ? (snap.disk_total_bytes / 1073741824).toFixed(1) : '?';
      return {
        reply: `**Triple store**: ${storeMb} MB  \n**Disk**: ${diskUsedGb} GB / ${diskTotalGb} GB used`,
        data: { storeBytes: snap.store_bytes, diskUsed: snap.disk_used_bytes, diskTotal: snap.disk_total_bytes },
      };
    }

    // --- Recent logs ---
    if (matches(q, ['recent log', 'last log', 'show log', 'latest log'])) {
      const { logs } = this.db.searchLogs({ limit: 10 });
      if (logs.length === 0) return { reply: 'No logs recorded yet.' };
      const lines = logs.map(l => `\`${new Date(l.ts).toLocaleTimeString()}\` **${l.level}** [${l.module}] ${l.message}`).join('\n');
      return { reply: `Last ${logs.length} log entries:\n\n${lines}`, data: logs };
    }

    // --- Fallback: try running as SPARQL ---
    if (q.startsWith('select') || q.startsWith('ask') || q.startsWith('construct') || q.startsWith('describe')) {
      try {
        const result = await this.queryFn(req.message);
        const count = result.bindings?.length ?? 0;
        return {
          reply: `Query returned **${count}** result(s).`,
          data: result.bindings,
          sparql: req.message,
        };
      } catch (err: any) {
        return { reply: `SPARQL error: ${err.message}`, sparql: req.message };
      }
    }

    // --- Help or LLM ---
    if (this.llmConfig) {
      return this.llmAnswer(req);
    }
    return { reply: HELP_REPLY };
  }

  private async llmAnswer(req: ChatRequest): Promise<ChatResponse> {
    try {
      const toolCallsCollector: Array<{ name: string; args: Record<string, unknown>; result: unknown }> = [];
      let reply = await this.callLlm(req.message, toolCallsCollector);
      const sparql = this.extractSparql(reply);
      if (sparql) {
        try {
          const result = await this.queryFn(sparql);
          const count = result.bindings?.length ?? 0;
          reply += `\n\n**Executed query** (${count} result(s)):`;
          return { reply, data: result.bindings, sparql, toolCalls: toolCallsCollector.length ? toolCallsCollector : undefined };
        } catch (err: any) {
          reply += `\n\nSPARQL execution failed: ${err.message}`;
          return { reply, sparql };
        }
      }
      return {
        reply,
        toolCalls: toolCallsCollector.length ? toolCallsCollector : undefined,
      };
    } catch (err: any) {
      return { reply: `LLM error: ${err.message}. ${HELP_REPLY}` };
    }
  }
}

function matches(input: string, keywords: string[]): boolean {
  return keywords.some(k => input.includes(k));
}

/** Robustly parse quads JSON from LLM output, handling common malformations. */
function parseQuadsJson(raw: string): any[] {
  // Try direct parse first
  try { const r = JSON.parse(raw); if (Array.isArray(r)) return r; } catch {}
  // LLMs sometimes produce values like ""Tesla"" — fix unescaped inner quotes
  try {
    const fixed = raw.replace(/""{1,2}([^"]+)""{1,2}/g, (match, inner) => {
      if (match.startsWith('""') && match.endsWith('""')) return `"${inner}"`;
      return match;
    });
    const r = JSON.parse(fixed); if (Array.isArray(r)) return r;
  } catch {}
  // Try stripping markdown fences
  try {
    const stripped = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const r = JSON.parse(stripped); if (Array.isArray(r)) return r;
  } catch {}
  return [];
}

function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
