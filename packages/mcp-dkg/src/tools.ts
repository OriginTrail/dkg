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
import type { DkgClient, ProjectRow } from './client.js';
import { normalizeContextGraphId } from './client.js';
import type { DkgConfig } from './config.js';
import {
  NS,
  PREFIXES,
  bindingValue,
  bindingsToTable,
  bindingsToParagraphs,
  escapeSparqlLiteral,
  prettyTerm,
  parseEntitySource,
  sourceLabel,
  type EntitySource,
} from './sparql.js';
import { EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION } from './tools/context-graph-description.js';

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

function contextGraphBelongsToCaller(row: ProjectRow): boolean {
  if (row.isSystem === true) return false;
  if (row.callerInvolved === true) return true;
  if (row.callerInvolved === false) return false;
  const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
  if (['curator', 'creator', 'owner', 'participant', 'member'].includes(role)) return true;
  // Older daemons did not include callerInvolved. Preserve compatibility by
  // leaving those unscoped rows visible instead of hiding everything.
  return true;
}

function filterContextGraphsForScope(rows: ProjectRow[], scope: 'mine' | 'all'): ProjectRow[] {
  return scope === 'all' ? rows : rows.filter(contextGraphBelongsToCaller);
}

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
        "List context graphs (called 'projects' in the DKG node UI). " +
        "Defaults to this caller's created/joined context graphs so agents " +
        'do not have to sift through noisy discovered public graphs. Pass ' +
        'scope: "all" to inspect every known graph.',
      inputSchema: {
        scope: z
          .enum(['mine', 'all'])
          .optional()
          .describe('Defaults to "mine" (created/joined context graphs for this caller). Use "all" for every known graph.'),
      },
    },
    async ({ scope = 'mine' }): Promise<ToolResult> => {
      try {
        const rows = filterContextGraphsForScope(await client.listProjects(), scope);
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
        const scopeLabel = scope === 'mine' ? 'created/joined' : 'known';
        return ok(`Found ${rows.length} context graph(s) (${scopeLabel}):\n\n${table}${hint}`);
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
        projectId: z
          .string()
          .optional()
          .describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
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
  //       view: 'working-memory' | 'shared-working-memory' | 'verifiable-memory'
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
        '"shared-working-memory" (team), or "verifiable-memory" (on-chain). ' +
        '`contextGraphId` and `view` are authoritative: local `GRAPH ?g` ' +
        'patterns are constrained to that resolved graph set. ' +
        'Set `includeSharedMemory: true` alongside `view: "working-memory"` ' +
        'to query WM ∪ SWM in one call.',
      inputSchema: {
        sparql: z.string().describe('SPARQL query body. Prefixes are auto-injected.'),
        projectId: z
          .string()
          .optional()
          .describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
        subGraphName: z.string().optional().describe('Limit the query to a single sub-graph'),
        view: z
          .enum(['working-memory', 'shared-working-memory', 'verifiable-memory'])
          .optional()
          .describe('Memory tier: working-memory (default, private), shared-working-memory (team), verifiable-memory (on-chain).'),
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
        if (result.quads !== undefined) {
          const allQuads = result.quads;
          const cappedQuads = typeof limit === 'number' ? allQuads.slice(0, limit) : allQuads;
          const rows = cappedQuads.map((quad) => ({
            subject: quad.subject,
            predicate: quad.predicate,
            object: quad.object,
            graph: quad.graph ?? '',
          }));
          const tail = cappedQuads.length < allQuads.length
            ? `\n\n_(showing ${cappedQuads.length} of ${allQuads.length} — raise limit to see more)_`
            : '';
          return ok(`${bindingsToTable(rows)}${tail}`);
        }
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
        projectId: z
          .string()
          .optional()
          .describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
        view: z
          .enum(['working-memory', 'shared-working-memory', 'verifiable-memory'])
          .optional()
          .describe(
            'Memory tier (explicit selection is STRICT — pick one tier only): ' +
              '"working-memory" (private WM only — pair with includeSharedMemory: true to add SWM), ' +
              '"shared-working-memory" (team SWM only), ' +
              '"verifiable-memory" (on-chain VM only). ' +
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
      // `view: 'verifiable-memory'` routes to VM; explicit
      // `view: 'shared-working-memory'` routes to SWM only;
      // `view: 'working-memory'` (without `includeSharedMemory: true`)
      // returns WM only.
      const scope =
        view === 'verifiable-memory'
          ? { view: 'verifiable-memory' as const }
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
            view === 'verifiable-memory' ? 'verifiable-memory' :
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

  // ── dkg_get_entity_sources ──────────────────────────────────────
  // Verifiable grounding: return an entity's facts each tagged with the
  // published Knowledge Asset that asserted it. This is an ADDRESSED read —
  // the tool owns the query shape (one entity, a single view, no user solution
  // modifiers), so the source named graph binds and stays scoped to the CG.
  // That is why provenance is sound here but not for arbitrary `dkg_query`
  // SELECTs (DISTINCT/LIMIT/UNION/SWM-union/minTrust all perturb a rewrite of
  // a user query — see the closed #1252).
  //
  // A VM/SWM read binds MORE than per-KA partitions (root, per-collection
  // `/context/{id}`, the SWM bucket), and a fact can live in both a per-KA
  // partition and the root. Only the per-KA partition encodes a citable KA
  // identity, so the handler attributes facts to a KA ONLY from those graphs,
  // collapses the root duplicate, and discloses (not drops) unattributed
  // facts. working-memory is not offered (private; needs an agent identity).
  server.registerTool(
    'dkg_get_entity_sources',
    {
      title: 'Describe Entity with Verifiable Sources',
      description:
        'Fetch the facts about an entity, each tagged with the Knowledge Asset that asserted it (author + KA number). With the default verifiable-memory view these are PUBLISHED, on-chain KA identities you can cite or verify; with shared-working-memory they are PRE-PUBLISH DRAFT handles (a reserved, not-yet-on-chain UAL that may still change or be discarded — not citable on chain). Answers "what is known about X, and who asserted each fact?". Reads ONE memory tier. Facts present only in non-per-KA graphs (root / reconcile / bucket) carry no per-KA identity; their count is disclosed, not listed as sources.',
      inputSchema: {
        uri: z.string().describe('Entity URI (e.g. urn:dkg:decision:shacl-on-vm-promotion)'),
        projectId: z
          .string()
          .optional()
          .describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
        view: z
          .enum(['shared-working-memory', 'verifiable-memory'])
          .optional()
          .describe('Memory tier to read sources from. Defaults to verifiable-memory (on-chain, citable). working-memory is intentionally not offered: it is private draft state (the engine requires an agent identity to read it) and is not a citable source.'),
        subGraphName: z.string().optional().describe('Limit the read to a single sub-graph'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max attributed facts to render (default 100). A high-degree or many-publisher entity is truncated deterministically and the remainder disclosed, so the response cannot exhaust agent context.'),
      },
    },
    async ({ uri, projectId, view, subGraphName, limit }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      // The client accepts a full `did:dkg:context-graph:<id>` and normalises it
      // for the wire query, so the returned graphs are keyed by the bare id.
      // Anchor parseEntitySource on the SAME normalised id (and scope the query
      // with it), or a DID-form pid would double-prefix and mark every per-KA
      // graph unattributed.
      const cgId = normalizeContextGraphId(pid);
      // Unwrap only a MATCHED `<…>` pair. Stripping `<` and `>` independently
      // would rewrite a mismatched input like `<urn:x` to a different, valid
      // entity (`urn:x`) and silently query it; leaving the stray delimiter in
      // place lets the unsafe-char guard below reject it (fail closed).
      const safeIri = uri.startsWith('<') && uri.endsWith('>') ? uri.slice(1, -1) : uri;
      // Guard the IRI interpolation: reject anything that could break out of
      // the `<…>` term. (A SPARQL injection here would let a caller widen the
      // query beyond the single entity.) Mirrors core's UNSAFE_IRI_CHARS — the
      // full control-char range (incl. NUL), not just `\s` — so the tool fails
      // closed cleanly instead of surfacing a raw oxigraph parse error.
      if (!safeIri || /[<>"{}|\\^\x60\x00-\x20]/.test(safeIri)) {
        return err(`Unsafe entity URI: ${uri}`);
      }
      const scopeView = view ?? 'verifiable-memory';
      try {
        // Tool-owned shape: one entity, GRAPH ?g to bind the source, a single
        // view (NOT includeSharedMemory — the union path would duplicate), no
        // DISTINCT/LIMIT/ORDER. The engine constrains ?g to this CG's content
        // graphs, so no `_meta`/`_private` and no cross-context bleed.
        const result = await client.query({
          sparql: `${PREFIXES}
SELECT ?p ?o ?g WHERE { GRAPH ?g { <${safeIri}> ?p ?o } }`,
          contextGraphId: cgId,
          subGraphName,
          view: scopeView,
        });
        const rows = result.bindings ?? [];
        if (!rows.length) {
          return ok(`No facts found for <${safeIri}> in '${cgId}' (view=${scopeView}).`);
        }
        // A VM/SWM read binds MORE than per-KA partitions: the root context
        // graph, per-collection `/context/{id}` graphs, and the SWM bucket also
        // appear, and a fact can be materialised in BOTH a per-KA partition and
        // the root. Only the per-KA partition `…/_{layer}/{addr}/{number}`
        // encodes a citable KA identity. So: group rows by fact (predicate +
        // object); attribute a fact to a KA ONLY from per-KA sources; collapse
        // the root duplicate (a fact in a per-KA partition AND the root is one
        // attributed fact); keep multiple DISTINCT per-KA sources for one fact
        // (genuine multi-publisher); and DISCLOSE — not silently drop — facts
        // that have no per-KA source at all.
        interface Fact {
          p: string;
          o: string;
          ka: EntitySource[];
        }
        const facts = new Map<string, Fact>();
        for (const b of rows) {
          const p = bindingValue(b.p);
          const o = bindingValue(b.o);
          const src = parseEntitySource(bindingValue(b.g), cgId);
          const key = JSON.stringify([p, o]);
          const fact = facts.get(key) ?? { p, o, ka: [] };
          if (src.author && src.kaNumber && !fact.ka.some((s) => s.sourceGraph === src.sourceGraph)) {
            fact.ka.push(src);
          }
          facts.set(key, fact);
        }
        // Stable ordering BEFORE the cap so truncation is genuinely deterministic
        // — the SPARQL query has no ORDER BY, so raw row order is backend/
        // discovery-dependent. Facts sort by (predicate, object); each fact's KA
        // sources by sourceGraph.
        const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
        const attributed = [...facts.values()]
          .filter((f) => f.ka.length > 0)
          .map((f) => ({ ...f, ka: [...f.ka].sort((x, y) => cmp(x.sourceGraph, y.sourceGraph)) }))
          .sort((a, b) => cmp(a.p, b.p) || cmp(a.o, b.o));
        const unattributed = [...facts.values()].filter((f) => f.ka.length === 0);

        if (!attributed.length) {
          return ok(
            `No KA-attributable facts for <${safeIri}> in '${cgId}' (view=${scopeView}). ` +
              `${unattributed.length} fact(s) are present only in non-per-KA graphs ` +
              `(root / reconcile / bucket), which do not encode a citable KA identity.`,
          );
        }

        // Deterministic output cap: render at most `limit` attributed facts and
        // only the sources THEY cite, so a high-degree / many-publisher entity
        // cannot dump an unbounded MCP response. Remainder disclosed, not dropped.
        const cap = limit ?? 100;
        const shown = attributed.slice(0, cap);
        const truncated = attributed.length - shown.length;
        const kaSources = new Map<string, EntitySource>();
        for (const f of shown) for (const s of f.ka) kaSources.set(s.sourceGraph, s);

        const factLines = shown.map(
          (f) => `- **${prettyTerm(f.p)}**: ${prettyTerm(f.o)}  ←  ${f.ka.map((s) => sourceLabel(s)).join(', ')}`,
        );
        const sourceLines = [...kaSources.values()]
          .sort((a, b) => cmp(a.sourceGraph, b.sourceGraph))
          .map((s) => `- ${sourceLabel(s)} (${s.memoryLayer}) — \`${s.sourceGraph}\``);
        // Verifiable-memory sources are published/on-chain; shared-working-memory
        // sources are pre-publish DRAFT (reserved, not-yet-on-chain) handles —
        // condition the framing so a per-fact line can't be cited as on-chain.
        const isVm = scopeView === 'verifiable-memory';
        const n = kaSources.size;
        const factsHeader = isVm
          ? '## Facts (with verifiable KA sources)'
          : '## Facts (with draft KA sources — shared-working-memory, not yet on-chain)';
        const sourcesHeader = isVm
          ? `## Sources (${n} verifiable KA${n === 1 ? '' : 's'})`
          : `## Sources (${n} draft KA${n === 1 ? '' : 's'} — reserved UAL, not yet on-chain)`;
        const parts = [
          `# ${prettyTerm(safeIri)}`,
          `<${safeIri}>  ·  view=${scopeView}`,
          '',
          factsHeader,
          factLines.join('\n'),
          '',
          sourcesHeader,
          sourceLines.join('\n'),
        ];
        if (truncated > 0) {
          parts.push(
            '',
            `_${truncated} more attributed fact(s) not shown — raise \`limit\` (currently ${cap})._`,
          );
        }
        if (unattributed.length) {
          parts.push(
            '',
            `_${unattributed.length} additional fact(s) present only in non-per-KA graphs ` +
              `(root / reconcile / bucket) — no citable KA identity — omitted._`,
          );
        }
        return ok(parts.join('\n'));
      } catch (e) {
        return err(`Failed to describe entity sources: ${formatError(e)}`);
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
          .enum(['working-memory', 'shared-working-memory', 'verifiable-memory'])
          .optional()
          .describe(
            'Memory tier (explicit selection is STRICT — pick one tier only): ' +
              '"working-memory" (private WM only — pair with includeSharedMemory: true to add SWM), ' +
              '"shared-working-memory" (team SWM only), ' +
              '"verifiable-memory" (on-chain VM only). ' +
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
        view === 'verifiable-memory'
          ? { view: 'verifiable-memory' as const }
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
