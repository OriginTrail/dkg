/**
 * DKG MCP read-tool registrations. Every tool:
 *   - Takes a `DkgClient` + resolved `DkgConfig` so it can honour the
 *     project pinned in `.dkg/config.yaml` without requiring the LLM to
 *     pass a `projectId` on every call.
 *   - Returns compact markdown — tables, bullet lists, or short prose —
 *     tuned for how coding agents (Cursor, Claude Code) re-ingest MCP
 *     output into their context.
 *   - Fails open: a thrown error becomes an `isError: true` text block so
 *     the LLM can recover instead of the entire session crashing.
 *
 * The eight tools below map 1:1 to the useful read surfaces in the
 * Node UI, so anything a human can see in the right pane, an agent
 * can see through MCP with the same canonical queries.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DkgClient } from './client.js';
import type { DkgConfig } from './config.js';
import {
  NS,
  PREFIXES,
  bindingValue,
  bindingsToTable,
  bindingsToParagraphs,
  escapeSparqlLiteral,
  prettyTerm,
} from './sparql.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const err = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

const formatError = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Resolve the contextGraphId for a tool invocation. Argument beats
 * config default; if neither is present we return null and the tool
 * surface explains how to fix it.
 */
function resolveProject(
  explicit: string | undefined,
  config: DkgConfig,
): string | null {
  return explicit ?? config.defaultProject ?? null;
}

const projectErr = (): ToolResult =>
  err(
    'No project specified. Either pass `projectId` to this tool, set `DKG_PROJECT` in the environment, or pin `contextGraph:` in `.dkg/config.yaml`.',
  );

export function registerReadTools(
  server: McpServer,
  client: DkgClient,
  config: DkgConfig,
): void {
  // ── dkg_list_context_graphs ─────────────────────────────────────
  server.registerTool(
    'dkg_list_context_graphs',
    {
      title: 'List Context Graphs',
      // Description opens with the audit v1.1 verbatim-locked
      // reconciliation note (SKILL.md §6 user-vs-internal
      // terminology); the follow-up sentence is the existing
      // mcp-dkg per-row payload notes.
      description:
        "List all context graphs the node knows about (called 'projects' " +
        'in the DKG node UI). Returns id, display name, role (curator / ' +
        'participant), and layer. The first call most agents make when ' +
        'joining a workspace.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        const rows = await client.listProjects();
        if (!rows.length) return ok('No context graphs found on this DKG node.');
        const pinned = config.defaultProject;
        const table = rows
          .map((r) => {
            const star = pinned && r.id === pinned ? ' ★' : '';
            const role = r.role ? ` · ${r.role}` : '';
            const layer = r.layer ? ` · ${r.layer}` : '';
            return `- **${r.id}**${star} — ${r.name ?? '(unnamed)'}${role}${layer}${
              r.description ? `\n    ${r.description}` : ''
            }`;
          })
          .join('\n');
        const hint = pinned
          ? `\n\n★ pinned in .dkg/config.yaml — other tools default to this context graph.`
          : '';
        return ok(`Found ${rows.length} context graph(s):\n\n${table}${hint}`);
      } catch (e) {
        return err(`Failed to list context graphs: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_sub_graph_list ──────────────────────────────────────────
  server.registerTool(
    'dkg_sub_graph_list',
    {
      title: 'List Sub-graphs',
      description:
        'List the sub-graphs inside a DKG context graph (e.g. code, ' +
        'github, decisions, tasks, meta, chat) with entity counts. Use ' +
        'to figure out what kind of knowledge the context graph exposes ' +
        'before querying.',
      inputSchema: {
        projectId: z.string().optional().describe('contextGraphId; defaults to .dkg/config.yaml'),
      },
    },
    async ({ projectId }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        const rows = await client.listSubGraphs(pid);
        if (!rows.length) return ok(`Context graph '${pid}' has no sub-graphs yet.`);
        const lines = rows.map(
          (r) =>
            `- **${r.name}**${r.entityCount != null ? ` · ${r.entityCount} entities` : ''}${
              r.description ? ` — ${r.description}` : ''
            }`,
        );
        return ok(`Sub-graphs in '${pid}':\n\n${lines.join('\n')}`);
      } catch (e) {
        return err(`Failed to list sub-graphs: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_query ───────────────────────────────────────────────────
  // Replaces the legacy `dkg_sparql` registration. SKILL.md + the
  // OpenClaw adapter both use `dkg_query` against `POST /api/query`.
  // The two-axis schema migration (audit §7 item 5):
  //   - Old single `layer: 'wm' | 'swm' | 'union' | 'vm'` enum
  //   - New separate axes:
  //       view: 'working-memory' | 'shared-working-memory' | 'verified-memory'
  //       includeSharedMemory?: boolean   (orthogonal — combines with view)
  //   - The legacy `'union'` mode (`view: 'working-memory'` ∪ SWM)
  //     was an enum-conflation of two orthogonal axes; callers
  //     wanting that semantics now pass
  //     `view: 'working-memory' + includeSharedMemory: true`.
  // The daemon-side wire shape already matches this two-axis form
  // (`DkgClient.query` accepts both as separate fields per
  // `client.ts:133-183`); this is a public-tool-surface alignment
  // only, no daemon change needed.
  server.registerTool(
    'dkg_query',
    {
      title: 'Run SPARQL Query',
      description:
        'Execute an arbitrary SPARQL SELECT / ASK / CONSTRUCT against a ' +
        'DKG context graph. Known prefixes are auto-prepended so you can ' +
        'just write `SELECT ?d WHERE { ?d a decisions:Decision }`. Scope ' +
        'with `view` — "working-memory" (default, private), ' +
        '"shared-working-memory" (team), or "verified-memory" (on-chain). ' +
        'Set `includeSharedMemory: true` alongside `view: "working-memory"` ' +
        'to query WM ∪ SWM in one call.',
      inputSchema: {
        sparql: z.string().describe('SPARQL query body. Prefixes are auto-injected.'),
        projectId: z.string().optional().describe('contextGraphId; defaults to .dkg/config.yaml'),
        subGraphName: z.string().optional().describe('Limit the query to a single sub-graph'),
        view: z
          .enum(['working-memory', 'shared-working-memory', 'verified-memory'])
          .optional()
          .describe('Memory tier: working-memory (default, private), shared-working-memory (team), verified-memory (on-chain).'),
        includeSharedMemory: z
          .boolean()
          .optional()
          .describe('When set with view: "working-memory", include SWM in the result set (the legacy `layer: "union"` semantics).'),
        limit: z.number().optional().describe('Row cap when rendering to markdown; does NOT modify the query'),
      },
    },
    async ({ sparql, projectId, subGraphName, view, includeSharedMemory, limit }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      const fullSparql = sparql.startsWith('PREFIX') ? sparql : `${PREFIXES}\n${sparql}`;
      try {
        const result = await client.query({
          sparql: fullSparql,
          contextGraphId: pid,
          subGraphName,
          view,
          includeSharedMemory,
        });
        const all = result.bindings ?? [];
        const capped = typeof limit === 'number' ? all.slice(0, limit) : all;
        const tail = capped.length < all.length ? `\n\n_(showing ${capped.length} of ${all.length} — raise limit to see more)_` : '';
        return ok(`${bindingsToTable(capped)}${tail}`);
      } catch (e) {
        return err(`SPARQL failed: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_get_entity ──────────────────────────────────────────────
  server.registerTool(
    'dkg_get_entity',
    {
      title: 'Describe Entity',
      description:
        'Fetch all triples where the given URI is the subject, plus a 1-hop ' +
        'neighbourhood (inbound edges). Equivalent to the entity detail page ' +
        'in the Node UI. Use when you want to understand a specific decision, ' +
        'task, file, or PR end-to-end.',
      inputSchema: {
        uri: z.string().describe('Entity URI (e.g. urn:dkg:decision:shacl-on-vm-promotion)'),
        projectId: z.string().optional().describe('contextGraphId; defaults to .dkg/config.yaml'),
        view: z
          .enum(['working-memory', 'shared-working-memory', 'verified-memory'])
          .optional()
          .describe(
            'Memory tier (explicit selection is STRICT — pick one tier only): ' +
              '"working-memory" (private WM only — pair with includeSharedMemory: true to add SWM), ' +
              '"shared-working-memory" (team SWM only), ' +
              '"verified-memory" (on-chain VM only). ' +
              'Omit `view` to get the WM ∪ SWM default (the V9-era `layer: "union"` shape).',
          ),
        includeSharedMemory: z
          .boolean()
          .optional()
          .describe('When set with view: "working-memory", include SWM in the result set (the WM∪SWM combined view).'),
      },
    },
    async ({ uri, projectId, view, includeSharedMemory }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      // Default behaviour mirrors the historical `layer: 'union'` default:
      // when neither `view` nor `includeSharedMemory` is set, return WM∪SWM
      // (the shape callers learned via the V9 surface). Explicit
      // `view: 'verified-memory'` routes to VM; explicit
      // `view: 'shared-working-memory'` routes to SWM only;
      // `view: 'working-memory'` (without `includeSharedMemory: true`)
      // returns WM only.
      const scope =
        view === 'verified-memory'
          ? { view: 'verified-memory' as const }
          : view === 'shared-working-memory'
          ? { graphSuffix: '_shared_memory' as const }
          : view === 'working-memory'
          ? (includeSharedMemory === true ? { includeSharedMemory: true } : {})
          : { includeSharedMemory: includeSharedMemory ?? true };
      try {
        // NOTE: no explicit `GRAPH ?g { … }` wrapper here — the query
        // engine injects one that scopes to the requested CG. Adding our
        // own skips that scoping and lets results bleed across other
        // context graphs on the same node. See `wrapWithGraph` in
        // `@origintrail-official/dkg-query/dkg-query-engine.ts`.
        const [outgoing, incoming] = await Promise.all([
          client.query({
            sparql: `${PREFIXES}
SELECT DISTINCT ?p ?o WHERE { <${uri}> ?p ?o }`,
            contextGraphId: pid,
            ...scope,
          }),
          client.query({
            sparql: `${PREFIXES}
SELECT DISTINCT ?s ?p WHERE { ?s ?p <${uri}> } LIMIT 50`,
            contextGraphId: pid,
            ...scope,
          }),
        ]);
        const out = outgoing.bindings ?? [];
        const inc = incoming.bindings ?? [];
        if (!out.length && !inc.length) {
          const scopeLabel =
            view === 'verified-memory' ? 'verified-memory' :
            view === 'shared-working-memory' ? 'shared-working-memory' :
            view === 'working-memory'
              ? (includeSharedMemory === true ? 'working-memory∪swm' : 'working-memory')
              : 'working-memory∪swm';
          return ok(`No triples found for <${uri}> in '${pid}' (view=${scopeLabel}).`);
        }
        const parts: string[] = [`# ${prettyTerm(uri)}`, `<${uri}>`, ''];
        if (out.length) {
          parts.push('## Properties');
          parts.push(
            out
              .map((b) => `- **${prettyTerm(bindingValue(b.p))}**: ${prettyTerm(bindingValue(b.o))}`)
              .join('\n'),
          );
        }
        if (inc.length) {
          parts.push('', '## Incoming edges');
          parts.push(
            inc
              .map(
                (b) =>
                  `- ${prettyTerm(bindingValue(b.s))} → **${prettyTerm(bindingValue(b.p))}**`,
              )
              .join('\n'),
          );
        }
        return ok(parts.join('\n'));
      } catch (e) {
        return err(`Failed to describe entity: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_list_activity ───────────────────────────────────────────
  server.registerTool(
    'dkg_list_activity',
    {
      title: 'List Recent Activity',
      description:
        'Recent activity across all sub-graphs, newest first. Mirrors the ' +
        '"Recent activity" feed on the project overview page: decisions, ' +
        'tasks, PRs, chat turns. Each row shows what changed, when, and who ' +
        'was attributed. Use to catch up at the start of a session.',
      inputSchema: {
        projectId: z.string().optional(),
        subGraph: z.string().optional().describe('Narrow to one sub-graph (e.g. "decisions", "chat")'),
        agentUri: z.string().optional().describe('Only items attributed to this agent'),
        sinceIso: z.string().optional().describe('Earliest timestamp, ISO-8601'),
        view: z
          .enum(['working-memory', 'shared-working-memory', 'verified-memory'])
          .optional()
          .describe(
            'Memory tier (explicit selection is STRICT — pick one tier only): ' +
              '"working-memory" (private WM only — pair with includeSharedMemory: true to add SWM), ' +
              '"shared-working-memory" (team SWM only), ' +
              '"verified-memory" (on-chain VM only). ' +
              'Omit `view` to get the WM ∪ SWM default (the V9-era `layer: "union"` shape).',
          ),
        includeSharedMemory: z
          .boolean()
          .optional()
          .describe('When set with view: "working-memory", include SWM in the result set (the WM∪SWM combined view).'),
        limit: z.number().optional().default(25),
      },
    },
    async ({ projectId, subGraph, agentUri, sinceIso, view, includeSharedMemory, limit }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      // Default mirrors historical `layer: 'union'`: WM∪SWM when neither
      // `view` nor `includeSharedMemory` is supplied. Explicit values
      // route to the requested tier (see dkg_get_entity for the parallel).
      const scope =
        view === 'verified-memory'
          ? { view: 'verified-memory' as const }
          : view === 'shared-working-memory'
          ? { graphSuffix: '_shared_memory' as const }
          : view === 'working-memory'
          ? (includeSharedMemory === true ? { includeSharedMemory: true } : {})
          : { includeSharedMemory: includeSharedMemory ?? true };

      const typeFilterBySubgraph: Record<string, string> = {
        decisions: `?s a <${NS.decisions}Decision> .`,
        tasks:     `?s a <${NS.tasks}Task> .`,
        github:    `VALUES ?t { <${NS.github}PullRequest> <${NS.github}Commit> <${NS.github}Issue> <${NS.github}Review> } ?s a ?t .`,
        code:      `VALUES ?t { <${NS.code}File> <${NS.code}Function> <${NS.code}Class> } ?s a ?t .`,
        chat:      `VALUES ?t { <${NS.chat}Session> <${NS.chat}Turn> } ?s a ?t .`,
      };
      const typeClause = subGraph ? typeFilterBySubgraph[subGraph] ?? '' : '?s a ?t .';
      const agentClause = agentUri ? `?s prov:wasAttributedTo <${agentUri}> .` : '';
      const sinceClause = sinceIso
        ? `FILTER(?when >= "${escapeSparqlLiteral(sinceIso)}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)`
        : '';

      // No `GRAPH ?g` wrapper — let the engine scope the query to the
      // requested CG (see dkg_get_entity for the rationale).
      //
      // `?when` is a COALESCE over separate timestamp bindings so we pick
      // the latest available timestamp without letting an already-bound
      // `?when` on `dcterms:created` block later `dcterms:modified`
      // values from ever winning. Reusing a single `?when` across
      // OPTIONAL patterns (the previous behaviour) silently collapsed
      // these to "first match" and sorted updated items by their creation
      // date instead of their most recent activity.
      const sparql = `${PREFIXES}
SELECT DISTINCT ?s ?t ?when ?author WHERE {
  ${typeClause}
  OPTIONAL { ?s a ?t }
  OPTIONAL { ?s dcterms:created ?created }
  OPTIONAL { ?s dcterms:modified ?modified }
  OPTIONAL { ?s <${NS.decisions}date> ?decisionDate }
  OPTIONAL { ?s <${NS.tasks}dueDate> ?taskDue }
  OPTIONAL { ?s prov:wasAttributedTo ?author }
  BIND(COALESCE(?modified, ?created, ?decisionDate, ?taskDue) AS ?when)
  ${agentClause}
  ${sinceClause}
}
ORDER BY DESC(?when)
LIMIT ${Math.max(1, Math.min(limit ?? 25, 200))}`;
      try {
        const r = await client.query({
          sparql,
          contextGraphId: pid,
          ...scope,
        });
        const rows = r.bindings ?? [];
        if (!rows.length) return ok('(no activity)');
        const lines = rows.map((b) => {
          const when = prettyTerm(bindingValue(b.when)) || '(undated)';
          const type = prettyTerm(bindingValue(b.t));
          const uri = bindingValue(b.s);
          const short = prettyTerm(uri);
          const author = bindingValue(b.author) ? ` · by ${prettyTerm(bindingValue(b.author))}` : '';
          return `- \`${when}\` · **${type}**${author}\n    ${short}`;
        });
        return ok(`Recent activity in '${pid}'${subGraph ? ` / ${subGraph}` : ''}:\n\n${lines.join('\n')}`);
      } catch (e) {
        return err(`Activity query failed: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_get_agent ───────────────────────────────────────────────
  server.registerTool(
    'dkg_get_agent',
    {
      title: 'Get Agent Profile',
      description:
        'Look up one agent by URI (or a display name) and return its profile ' +
        'card: framework, operator, wallet address, joined-at, reputation, ' +
        'plus everything that agent has authored in the project.',
      inputSchema: {
        projectId: z.string().optional(),
        agentUri: z.string().optional().describe('Agent URI (e.g. urn:dkg:agent:claude-code-branarakic)'),
        nameOrHandle: z
          .string()
          .optional()
          .describe('Name or handle substring, if you don\'t know the URI'),
      },
    },
    async ({ projectId, agentUri, nameOrHandle }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        // Step 1: resolve to a URI if only a handle was given.
        let resolved = agentUri ?? '';
        if (!resolved && nameOrHandle) {
          // No explicit `GRAPH ?g { … }` wrapper: `client.query` only scopes
          // to `contextGraphId` when the engine is allowed to inject the
          // graph. A `GRAPH ?g` pattern matches across ALL named graphs on
          // the node, which would let this handler resolve agents from
          // other projects on the same local daemon. See the matching
          // comment in the `GET dkg_list_agents` handler above (line ~216).
          const findQ = `${PREFIXES}
SELECT DISTINCT ?a ?name WHERE {
  ?a a <${NS.agent}Agent> .
  OPTIONAL { ?a schema:name ?name }
  OPTIONAL { ?a rdfs:label ?name }
  FILTER(CONTAINS(LCASE(STR(?a)), LCASE("${escapeSparqlLiteral(nameOrHandle)}"))
      || CONTAINS(LCASE(STR(COALESCE(?name, ""))), LCASE("${escapeSparqlLiteral(nameOrHandle)}")))
} LIMIT 1`;
          const r = await client.query({
            sparql: findQ,
            contextGraphId: pid,
            subGraphName: 'meta',
            includeSharedMemory: true,
          });
          resolved = r.bindings?.[0] ? bindingValue(r.bindings[0].a) : '';
        }
        if (!resolved) {
          return err('Could not resolve an agent. Pass `agentUri` or a narrower `nameOrHandle`.');
        }

        // Step 2: profile properties — no GRAPH wrapper, same reason as
        // `findQ` above (cross-project leak on shared daemons).
        const profileQ = `${PREFIXES}
SELECT ?p ?o WHERE { <${resolved}> ?p ?o }`;
        const profile = await client.query({
          sparql: profileQ,
          contextGraphId: pid,
          subGraphName: 'meta',
          includeSharedMemory: true,
        });

        // Step 3: counts by type — no GRAPH wrapper (cross-project leak).
        const statsQ = `${PREFIXES}
SELECT ?t (COUNT(DISTINCT ?s) AS ?n) WHERE {
  ?s prov:wasAttributedTo <${resolved}> ;
     a ?t .
} GROUP BY ?t ORDER BY DESC(?n)`;
        const stats = await client.query({
          sparql: statsQ,
          contextGraphId: pid,
          includeSharedMemory: true,
        });

        const parts: string[] = [`# ${prettyTerm(resolved)}`, `\`${resolved}\``, ''];
        if (profile.bindings.length) {
          parts.push('## Profile');
          parts.push(
            profile.bindings
              .map((b) => `- **${prettyTerm(bindingValue(b.p))}**: ${prettyTerm(bindingValue(b.o))}`)
              .join('\n'),
          );
        } else {
          parts.push('_(no profile triples found in the `meta` sub-graph; this agent may not be registered yet.)_');
        }
        if (stats.bindings.length) {
          parts.push('', '## Authored activity');
          parts.push(
            stats.bindings
              .map(
                (b) =>
                  `- ${bindingValue(b.n)} × ${prettyTerm(bindingValue(b.t))}`,
              )
              .join('\n'),
          );
        }
        return ok(parts.join('\n'));
      } catch (e) {
        return err(`Failed to fetch agent: ${formatError(e)}`);
      }
    },
  );

}
