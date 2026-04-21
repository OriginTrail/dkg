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
  // ── dkg_list_projects ───────────────────────────────────────────
  server.registerTool(
    'dkg_list_projects',
    {
      title: 'List DKG Projects',
      description:
        'List every context graph (project) this DKG node knows about. ' +
        'Returns id, display name, role (curator / participant), and layer. ' +
        'The first call most agents make when joining a workspace.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        const rows = await client.listProjects();
        if (!rows.length) return ok('No projects found on this DKG node.');
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
          ? `\n\n★ pinned in .dkg/config.yaml — other tools default to this project.`
          : '';
        return ok(`Found ${rows.length} project(s):\n\n${table}${hint}`);
      } catch (e) {
        return err(`Failed to list projects: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_list_subgraphs ──────────────────────────────────────────
  server.registerTool(
    'dkg_list_subgraphs',
    {
      title: 'List Sub-graphs',
      description:
        'List the sub-graphs inside a DKG project (e.g. code, github, ' +
        'decisions, tasks, meta, chat) with entity counts. Use to figure ' +
        'out what kind of knowledge the project exposes before querying.',
      inputSchema: {
        projectId: z.string().optional().describe('contextGraphId; defaults to .dkg/config.yaml'),
      },
    },
    async ({ projectId }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        const rows = await client.listSubGraphs(pid);
        if (!rows.length) return ok(`Project '${pid}' has no sub-graphs yet.`);
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

  // ── dkg_sparql ──────────────────────────────────────────────────
  server.registerTool(
    'dkg_sparql',
    {
      title: 'Run SPARQL Query',
      description:
        'Execute an arbitrary SPARQL SELECT / ASK / CONSTRUCT against a ' +
        'DKG project. Known prefixes are auto-prepended so you can just ' +
        'write `SELECT ?d WHERE { ?d a decisions:Decision }`. Scope with ' +
        '`layer` — "wm" (default), "swm", "union" (wm+swm), or "vm".',
      inputSchema: {
        sparql: z.string().describe('SPARQL query body. Prefixes are auto-injected.'),
        projectId: z.string().optional().describe('contextGraphId; defaults to .dkg/config.yaml'),
        subGraphName: z.string().optional().describe('Limit the query to a single sub-graph'),
        layer: z
          .enum(['wm', 'swm', 'union', 'vm'])
          .optional()
          .describe('Memory layer scope: wm (default, private), swm (team), union (wm+swm), vm (on-chain verified)'),
        limit: z.number().optional().describe('Row cap when rendering to markdown; does NOT modify the query'),
      },
    },
    async ({ sparql, projectId, subGraphName, layer, limit }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      const fullSparql = sparql.startsWith('PREFIX') ? sparql : `${PREFIXES}\n${sparql}`;
      const scope =
        layer === 'swm'
          ? { graphSuffix: '_shared_memory' as const }
          : layer === 'union'
          ? { includeSharedMemory: true }
          : layer === 'vm'
          ? { view: 'verified-memory' as const }
          : {};
      try {
        const result = await client.query({
          sparql: fullSparql,
          contextGraphId: pid,
          subGraphName,
          ...scope,
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
        layer: z
          .enum(['wm', 'swm', 'union', 'vm'])
          .optional()
          .default('union')
          .describe('Memory layer scope; default "union" (wm+swm)'),
      },
    },
    async ({ uri, projectId, layer }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      const scope =
        layer === 'swm'
          ? { graphSuffix: '_shared_memory' as const }
          : layer === 'wm'
          ? {}
          : layer === 'vm'
          ? { view: 'verified-memory' as const }
          : { includeSharedMemory: true };
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
          return ok(`No triples found for <${uri}> in '${pid}' (layer=${layer ?? 'union'}).`);
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

  // ── dkg_search ──────────────────────────────────────────────────
  server.registerTool(
    'dkg_search',
    {
      title: 'Full-text Search',
      description:
        'Keyword search across labels (rdfs:label, schema:name, dcterms:title) ' +
        'and free-text body properties (schema:description, decisions:context, ' +
        'tasks:description, schema:text). Returns URI + label + rdf:type for each hit.',
      inputSchema: {
        keyword: z.string().describe('Case-insensitive substring to match'),
        projectId: z.string().optional().describe('contextGraphId; defaults to .dkg/config.yaml'),
        types: z
          .array(z.string())
          .optional()
          .describe('Restrict by rdf:type URIs (prefix form OK, e.g. decisions:Decision)'),
        layer: z
          .enum(['wm', 'swm', 'union', 'vm'])
          .optional()
          .default('union'),
        limit: z.number().optional().default(25),
      },
    },
    async ({ keyword, projectId, types, layer, limit }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      const scope =
        layer === 'swm'
          ? { graphSuffix: '_shared_memory' as const }
          : layer === 'wm'
          ? {}
          : layer === 'vm'
          ? { view: 'verified-memory' as const }
          : { includeSharedMemory: true };
      const kEsc = escapeSparqlLiteral(keyword);
      const typeFilter = (types && types.length)
        ? `FILTER(?t IN (${types.map((t) => `<${expandPrefixed(t)}>`).join(', ')}))`
        : '';
      // No `GRAPH ?g` wrapper — let the engine scope the query to the
      // requested CG (see dkg_get_entity for the rationale).
      const sparql = `${PREFIXES}
SELECT DISTINCT ?s ?label ?t WHERE {
  ?s a ?t .
  OPTIONAL {
    { ?s rdfs:label ?label } UNION
    { ?s schema:name ?label } UNION
    { ?s dcterms:title ?label }
  }
  OPTIONAL {
    { ?s schema:description ?body } UNION
    { ?s <${NS.decisions}context> ?body } UNION
    { ?s <${NS.decisions}outcome> ?body } UNION
    { ?s schema:text ?body } UNION
    { ?s <${NS.chat}userPrompt> ?body } UNION
    { ?s <${NS.chat}assistantResponse> ?body }
  }
  ${typeFilter}
  FILTER(
    CONTAINS(LCASE(STR(COALESCE(?label, ""))), LCASE("${kEsc}")) ||
    CONTAINS(LCASE(STR(COALESCE(?body, ""))), LCASE("${kEsc}"))
  )
} LIMIT ${Math.max(1, Math.min(limit ?? 25, 200))}`;
      try {
        const r = await client.query({
          sparql,
          contextGraphId: pid,
          ...scope,
        });
        const rows = r.bindings ?? [];
        if (!rows.length) return ok(`No matches for "${keyword}".`);
        const lines = rows.map((b) => {
          const u = prettyTerm(bindingValue(b.s));
          const label = prettyTerm(bindingValue(b.label)) || u;
          const t = prettyTerm(bindingValue(b.t));
          return `- **${label}** (${t})\n    \`${bindingValue(b.s)}\``;
        });
        return ok(`Found ${rows.length} match(es) for "${keyword}":\n\n${lines.join('\n')}`);
      } catch (e) {
        return err(`Search failed: ${formatError(e)}`);
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
        layer: z.enum(['wm', 'swm', 'union', 'vm']).optional().default('union'),
        limit: z.number().optional().default(25),
      },
    },
    async ({ projectId, subGraph, agentUri, sinceIso, layer, limit }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      const scope =
        layer === 'swm'
          ? { graphSuffix: '_shared_memory' as const }
          : layer === 'wm'
          ? {}
          : layer === 'vm'
          ? { view: 'verified-memory' as const }
          : { includeSharedMemory: true };

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
          const findQ = `${PREFIXES}
SELECT DISTINCT ?a ?name WHERE {
  GRAPH ?g {
    ?a a <${NS.agent}Agent> .
    OPTIONAL { ?a schema:name ?name }
    OPTIONAL { ?a rdfs:label ?name }
    FILTER(CONTAINS(LCASE(STR(?a)), LCASE("${escapeSparqlLiteral(nameOrHandle)}"))
        || CONTAINS(LCASE(STR(COALESCE(?name, ""))), LCASE("${escapeSparqlLiteral(nameOrHandle)}")))
  }
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

        // Step 2: profile properties
        const profileQ = `${PREFIXES}
SELECT ?p ?o WHERE { GRAPH ?g { <${resolved}> ?p ?o } }`;
        const profile = await client.query({
          sparql: profileQ,
          contextGraphId: pid,
          subGraphName: 'meta',
          includeSharedMemory: true,
        });

        // Step 3: counts by type
        const statsQ = `${PREFIXES}
SELECT ?t (COUNT(DISTINCT ?s) AS ?n) WHERE {
  GRAPH ?g {
    ?s prov:wasAttributedTo <${resolved}> ;
       a ?t .
  }
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

  // ── dkg_get_chat ────────────────────────────────────────────────
  server.registerTool(
    'dkg_get_chat',
    {
      title: 'Get Captured Chat',
      description:
        'Query the `chat` sub-graph for captured conversations between ' +
        'operators and their coding assistants. Filter by sessionUri, ' +
        'agentUri, keyword, or time range. Returns each turn with speaker, ' +
        'prompt, and response — already markdown-formatted.',
      inputSchema: {
        projectId: z.string().optional(),
        sessionUri: z.string().optional().describe('Restrict to one session'),
        agentUri: z.string().optional().describe('Only turns authored by this agent'),
        keyword: z.string().optional().describe('Substring to match in prompt or response'),
        sinceIso: z.string().optional(),
        layer: z.enum(['wm', 'swm', 'union']).optional().default('union'),
        limit: z.number().optional().default(20),
      },
    },
    async ({ projectId, sessionUri, agentUri, keyword, sinceIso, layer, limit }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      const scope =
        layer === 'swm'
          ? { graphSuffix: '_shared_memory' as const }
          : layer === 'wm'
          ? {}
          : { includeSharedMemory: true };
      const filters: string[] = [`?t a <${NS.chat}Turn> .`];
      if (sessionUri) filters.push(`?t <${NS.chat}inSession> <${sessionUri}> .`);
      if (agentUri) filters.push(`?t prov:wasAttributedTo <${agentUri}> .`);
      if (keyword) {
        const k = escapeSparqlLiteral(keyword);
        filters.push(`OPTIONAL { ?t <${NS.chat}userPrompt> ?userText }`);
        filters.push(`OPTIONAL { ?t <${NS.chat}assistantResponse> ?asstText }`);
        filters.push(
          `FILTER(CONTAINS(LCASE(STR(COALESCE(?userText, ""))), LCASE("${k}")) || CONTAINS(LCASE(STR(COALESCE(?asstText, ""))), LCASE("${k}")))`,
        );
      }
      if (sinceIso) {
        filters.push(`OPTIONAL { ?t dcterms:created ?when }`);
        filters.push(`FILTER(!BOUND(?when) || ?when >= "${escapeSparqlLiteral(sinceIso)}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)`);
      }
      const sparql = `${PREFIXES}
SELECT DISTINCT ?t ?when ?sess ?author ?userText ?asstText WHERE {
  GRAPH ?g {
    ${filters.join('\n    ')}
    OPTIONAL { ?t <${NS.chat}inSession> ?sess }
    OPTIONAL { ?t dcterms:created ?when }
    OPTIONAL { ?t prov:wasAttributedTo ?author }
    OPTIONAL { ?t <${NS.chat}userPrompt> ?userText }
    OPTIONAL { ?t <${NS.chat}assistantResponse> ?asstText }
  }
}
ORDER BY DESC(?when)
LIMIT ${Math.max(1, Math.min(limit ?? 20, 100))}`;
      try {
        const r = await client.query({
          sparql,
          contextGraphId: pid,
          subGraphName: 'chat',
          ...scope,
        });
        const rows = r.bindings ?? [];
        if (!rows.length) return ok('(no chat turns matched)');
        const lines = rows.map((b, i) => {
          const when = prettyTerm(bindingValue(b.when)) || '(undated)';
          const sess = prettyTerm(bindingValue(b.sess)) || '(no session)';
          const author = prettyTerm(bindingValue(b.author)) || '(unknown)';
          const u = bindingValue(b.userText);
          const a = bindingValue(b.asstText);
          return [
            `### Turn ${i + 1} · \`${when}\` · ${sess} · ${author}`,
            u ? `\n**User:** ${u}` : '',
            a ? `\n**Assistant:** ${a}` : '',
          ].join('\n');
        });
        return ok(lines.join('\n\n---\n\n'));
      } catch (e) {
        return err(`Chat query failed: ${formatError(e)}`);
      }
    },
  );
}

// ── Small utilities ──────────────────────────────────────────────

/** Expand a prefixed name like "decisions:Decision" into a full URI. */
function expandPrefixed(name: string): string {
  const idx = name.indexOf(':');
  if (idx < 0) return name;
  const prefix = name.slice(0, idx);
  const rest = name.slice(idx + 1);
  // Full IRI already
  if (prefix === 'http' || prefix === 'https' || prefix === 'urn') return name;
  const base = (NS as Record<string, string>)[prefix];
  return base ? base + rest : name;
}
