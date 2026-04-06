/**
 * DkgMemoryPlugin — DKG-backed memory search.
 *
 * Registers `dkg_memory_search` and `dkg_memory_import` tools that query
 * the DKG daemon's agent-memory context graph via SPARQL.
 *
 * Memory reads go through this plugin:
 *   search(query) → SPARQL FILTER(CONTAINS) on dkg:ImportedMemory items
 *   readFile(path) → SPARQL text search fallback
 *   status()       → daemon health check
 *
 * Memory writes are captured by `write-capture.ts` (file watcher →
 * daemon's /api/memory/import pipeline with LLM entity extraction).
 */

import type { DkgDaemonClient } from './dkg-client.js';
import type {
  DkgOpenClawConfig,
  MemorySearchOptions,
  MemorySearchResult,
  OpenClawMemorySearchManager,
  OpenClawPluginApi,
} from './types.js';

const AGENT_MEMORY_CONTEXT_GRAPH = 'agent-memory';

/**
 * SPARQL namespaces used in the agent-memory graph.
 * Must match the schema in ChatMemoryManager.
 */
const NS = {
  schema: 'http://schema.org/',
  dkg: 'http://dkg.io/ontology/',
};

export class DkgMemoryPlugin implements OpenClawMemorySearchManager {
  private api: OpenClawPluginApi | null = null;

  constructor(
    private readonly client: DkgDaemonClient,
    private readonly config: NonNullable<DkgOpenClawConfig['memory']>,
  ) {}

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  register(api: OpenClawPluginApi): void {
    this.api = api;
    this.registerTools(api);
  }

  /** Re-register tools into a new registry without recreating state. */
  registerTools(api: OpenClawPluginApi): void {
    api.registerTool({
      name: 'dkg_memory_search',
      description:
        'Primary memory recall tool — search the Decentralized Knowledge Graph for stored memories, ' +
        'conversation history, decisions, preferences, and extracted entities. ' +
        'Use this FIRST when you need to recall anything from previous sessions or stored knowledge. ' +
        'Returns matching items with relevance scores.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language search query' },
          limit: { type: 'string', description: 'Max results (default: 10)' },
        },
        required: ['query'],
      },
      execute: async (_id, params) => {
        try {
          const results = await this.search(
            String(params.query),
            { limit: Math.max(1, Math.min(100, parseInt(String(params.limit), 10) || 10)) },
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
            details: results,
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          };
        }
      },
    });

    api.registerTool({
      name: 'dkg_memory_import',
      description:
        'Primary memory recording tool — store new memories directly to the Decentralized Knowledge Graph. ' +
        'Use this as your preferred way to record memories, decisions, preferences, and facts. ' +
        'Prefer this over writing to memory files, as it stores directly to the knowledge graph ' +
        'with LLM-powered entity extraction and categorization. ' +
        'Memory files are also captured, but this tool avoids the delay and is more precise.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to import as memories' },
          source: {
            type: 'string',
            description: 'Source type',
            enum: ['claude', 'chatgpt', 'gemini', 'other'],
          },
        },
        required: ['text'],
      },
      execute: async (_id, params) => {
        try {
          const result = await this.client.importMemories(
            String(params.text),
            String(params.source ?? 'other'),
            { useLlm: true },
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          };
        }
      },
    });
  }

  // ---------------------------------------------------------------------------
  // MemorySearchManager interface
  // ---------------------------------------------------------------------------

  async search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const limit = options?.limit ?? 10;

    // Strategy: search across both curated memories and chat message text.
    // Uses FILTER(CONTAINS) for now — Spike B will assess whether this is
    // sufficient or if a hybrid embedding approach is needed.
    const sparql = buildSearchSparql(query, limit);

    try {
      const result = await this.client.query(sparql, {
        contextGraphId: AGENT_MEMORY_CONTEXT_GRAPH,
        includeSharedMemory: true,
      });
      return formatSearchResults(result, query);
    } catch (err: any) {
      this.api?.logger.warn?.(`[dkg-memory] Search failed: ${err.message}`);
      return [];
    }
  }

  async readFile(path: string): Promise<string | null> {
    // Look up a memory by its source file path in the graph
    // With the daemon's import pipeline, memories are individual items (not file records).
    // Search for items whose text mentions the path as a fallback.
    const sparql = `SELECT ?text WHERE {
        ?m a <${NS.dkg}ImportedMemory> ;
           <${NS.schema}text> ?text .
        FILTER(CONTAINS(LCASE(?text), "${escapeSparqlString(path.toLowerCase())}"))
      }
      LIMIT 1`;

    try {
      const result = await this.client.query(sparql, {
        contextGraphId: AGENT_MEMORY_CONTEXT_GRAPH,
        includeSharedMemory: true,
      });
      const bindings = result?.result?.bindings ?? result?.results?.bindings ?? result?.bindings ?? [];
      if (bindings.length > 0) {
        return bindingValue(bindings[0].text) ?? null;
      }
      return null;
    } catch {
      return null;
    }
  }

  async status(): Promise<{ ready: boolean; indexedFiles?: number; lastSync?: number }> {
    try {
      const stats = await this.client.getMemoryStats();
      return {
        ready: stats.initialized,
        indexedFiles: stats.totalTriples,
        lastSync: Date.now(),
      };
    } catch {
      return { ready: false };
    }
  }

  async sync(): Promise<void> {
    // No-op — DKG graph is the source of truth, no local index to sync.
  }

  async close(): Promise<void> {
    // No resources to release.
  }
}

// ---------------------------------------------------------------------------
// SPARQL query builders
// ---------------------------------------------------------------------------

/**
 * Build a SPARQL query that searches across:
 * 1. Imported memories (dkg:ImportedMemory — from daemon's /api/memory/import)
 * 2. Chat messages (schema:Message)
 * 3. Extracted entity labels (schema:name)
 *
 * Uses case-insensitive CONTAINS for text matching.
 */
function buildSearchSparql(query: string, limit: number): string {
  // Split query into keywords for multi-term matching.
  // Minimum length 2 so terms like "UI", "AI", "DKG" are included.
  const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length >= 2);

  if (keywords.length === 0) {
    // Empty/short query — return recent items
    return `SELECT ?uri ?text ?type ?ts WHERE {
        { ?uri a <${NS.dkg}ImportedMemory> ; <${NS.schema}text> ?text . OPTIONAL { ?uri <${NS.schema}dateCreated> ?ts } BIND("memory" AS ?type) }
        UNION
        { ?uri a <${NS.schema}Message> ; <${NS.schema}text> ?text ; <${NS.schema}dateCreated> ?ts . BIND("message" AS ?type) }
      }
      ORDER BY DESC(?ts)
      LIMIT ${limit}`;
  }

  // Escape each keyword for safe SPARQL string interpolation
  const filters = keywords
    .map(k => `CONTAINS(LCASE(?text), "${escapeSparqlString(k)}")`)
    .join(' || ');

  return `SELECT ?uri ?text ?type ?label ?ts WHERE {
      {
        ?uri a <${NS.dkg}ImportedMemory> ;
             <${NS.schema}text> ?text .
        OPTIONAL { ?uri <${NS.schema}dateCreated> ?ts }
        BIND("memory" AS ?type)
        BIND("" AS ?label)
        FILTER(${filters})
      }
      UNION
      {
        ?uri a <${NS.schema}Message> ;
             <${NS.schema}text> ?text .
        OPTIONAL { ?uri <${NS.schema}dateCreated> ?ts }
        BIND("message" AS ?type)
        BIND("" AS ?label)
        FILTER(${filters})
      }
      UNION
      {
        ?uri <${NS.schema}name> ?label .
        BIND(?label AS ?text)
        BIND("entity" AS ?type)
        FILTER(${filters})
      }
    }
    ORDER BY DESC(?ts)
    LIMIT ${limit}`;
}

/**
 * Format SPARQL results into MemorySearchResult[].
 * Computes a simple keyword-overlap relevance score.
 */
function formatSearchResults(result: any, query: string): MemorySearchResult[] {
  // DKG daemon returns { result: { bindings: [...] } } (singular "result")
  const bindings: any[] = result?.result?.bindings ?? result?.results?.bindings ?? result?.bindings ?? [];
  const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length >= 2);

  return bindings.map((b: any) => {
    const text = bindingValue(b.text) ?? bindingValue(b.label) ?? '';
    const uri = bindingValue(b.uri) ?? '';
    const type = bindingValue(b.type) ?? 'unknown';

    // Simple keyword-overlap score
    const lowerText = text.toLowerCase();
    const matchCount = keywords.filter(k => lowerText.includes(k)).length;
    const score = keywords.length > 0 ? matchCount / keywords.length : 0.5;

    return {
      path: `dkg://${type}/${uri}`,
      content: text,
      score,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a plain string from a SPARQL binding value.
 * DKG daemon returns raw N-Triples literals: `"\"hello\""` or `"urn:foo"`.
 * Standard SPARQL JSON returns `{ type: "literal", value: "hello" }`.
 * This handles both formats.
 */
function bindingValue(v: unknown): string | undefined {
  if (v == null) return undefined;
  // Standard SPARQL JSON result format: { value: "..." }
  if (typeof v === 'object' && 'value' in (v as any)) {
    return String((v as any).value);
  }
  // DKG daemon raw format: N-Triples string literal "\"content\""
  // May include typed literal suffix: "value"^^<type> or language tag: "value"@en
  if (typeof v === 'string') {
    let s = v;
    const typedMatch = s.match(/^(".*")\^\^<[^>]+>$/);
    if (typedMatch) s = typedMatch[1];
    const langMatch = s.match(/^(".*")@[a-z-]+$/i);
    if (langMatch) s = langMatch[1];
    // Strip surrounding quotes from N-Triples literals
    if (s.startsWith('"') && s.endsWith('"')) {
      return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    }
    return v;
  }
  return String(v);
}

/**
 * Escape a string for safe interpolation into a SPARQL short string literal.
 * Handles all characters required by SPARQL grammar (STRING_LITERAL2).
 * Inlined from dkg-core to avoid pulling in the heavy libp2p dependency tree.
 */
function escapeSparqlString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
