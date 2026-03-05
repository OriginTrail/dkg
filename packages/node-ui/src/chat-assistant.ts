import type { DashboardDB } from './db.js';

export interface ChatRequest {
  message: string;
}

export interface ChatResponse {
  reply: string;
  data?: unknown;
  sparql?: string;
}

/** OpenAI-compatible LLM config for natural language answers and NL→SPARQL. */
export interface LlmConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
  systemPrompt?: string;
}

type QueryFn = (sparql: string) => Promise<{ bindings: Array<Record<string, string>> }>;

const HELP_REPLY = `I can answer questions about your node. Try:

- "What's my uptime?"
- "How many peers am I connected to?"
- "How many triples are in my graph?"
- "Show me CPU and memory usage"
- "Any failed operations?"
- "How many operations did I process?"
- "Which agents are on the network?"
- "Show me recent logs"
- "How big is my store?"
- Or paste a SPARQL query directly`;

/**
 * Chat assistant: rule-based answers plus optional LLM for natural language
 * and NL→SPARQL. When LLM is configured, unmatched questions are sent to
 * the LLM; if the response contains a SPARQL code block it is executed and
 * results are appended.
 */
export class ChatAssistant {
  constructor(
    private readonly db: DashboardDB,
    private readonly queryFn: QueryFn,
    private readonly llmConfig?: LlmConfig,
  ) {}

  private async callLlm(userMessage: string): Promise<string> {
    if (!this.llmConfig) throw new Error('LLM not configured');
    const { apiKey, model = 'gpt-4o-mini', baseURL = 'https://api.openai.com/v1' } = this.llmConfig;
    const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;
    const systemPrompt = this.llmConfig.systemPrompt ?? `You are a DKG (Decentralized Knowledge Graph) node assistant. The user operates a node that stores RDF triples and can run SPARQL queries.

Answer briefly and helpfully. For questions about the node (uptime, peers, triples, CPU, memory, operations, logs), give a short direct answer if you can infer it, or suggest they try the built-in commands.

For natural language questions about the knowledge graph (e.g. "what agents are there?", "show me all KCs"), you may output a SPARQL query in a markdown code block so it can be executed. Use this format exactly:
\`\`\`sparql
SELECT ...
\`\`\`
Keep queries read-only (SELECT, CONSTRUCT, ASK, DESCRIBE) and add LIMIT 50 or similar.`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 1024,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`LLM API ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('Empty LLM response');
    return content;
  }

  private extractSparql(text: string): string | null {
    const match = text.match(/```(?:sparql)?\s*([\s\S]*?)```/);
    return match ? match[1].trim() : null;
  }

  async answer(req: ChatRequest): Promise<ChatResponse> {
    const q = req.message.toLowerCase().trim();

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
      try {
        let reply = await this.callLlm(req.message);
        const sparql = this.extractSparql(reply);
        if (sparql) {
          try {
            const result = await this.queryFn(sparql);
            const count = result.bindings?.length ?? 0;
            reply += `\n\n**Executed query** (${count} result(s)):`;
            return { reply, data: result.bindings, sparql };
          } catch (err: any) {
            reply += `\n\nSPARQL execution failed: ${err.message}`;
            return { reply, sparql };
          }
        }
        return { reply };
      } catch (err: any) {
        return { reply: `LLM error: ${err.message}. ${HELP_REPLY}` };
      }
    }
    return { reply: HELP_REPLY };
  }
}

function matches(input: string, keywords: string[]): boolean {
  return keywords.some(k => input.includes(k));
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
