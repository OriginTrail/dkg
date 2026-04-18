/**
 * Phase 7 — Agent-emitted graph annotations + project ontology.
 *
 * Two MCP tools:
 *
 *   - `dkg_get_ontology`     — fetches the project's ontology.ttl + agent
 *                              guide markdown so the agent has the
 *                              conventions in working context.
 *   - `dkg_annotate_turn`    — batch-emits structured triples ABOUT a
 *                              chat turn: topics, mentions, examines,
 *                              proposes, concludes, asks, plus sugared
 *                              writes for proposedDecisions /
 *                              proposedTasks / comments / vmPublishRequests.
 *
 * `dkg_annotate_turn` is the main "annotate every substantive turn"
 * surface. Its sister tool `dkg_get_ontology` keeps the agent honest
 * about which predicates and URI patterns the project uses.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DkgClient } from '../client.js';
import type { DkgConfig } from '../config.js';
import { NS, PREFIXES, bindingValue, escapeSparqlLiteral } from '../sparql.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const errResult = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

const formatError = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

function resolveProject(
  explicit: string | undefined,
  config: DkgConfig,
): string | null {
  return explicit ?? config.defaultProject ?? null;
}

const projectErr = (): ToolResult =>
  errResult(
    'No project specified. Either pass `projectId` to this tool, set `DKG_PROJECT` in the environment, or pin `contextGraph:` in `.dkg/config.yaml`.',
  );

const agentErr = (): ToolResult =>
  errResult(
    'No agent URI configured. Set `agent.uri` in `.dkg/config.yaml` or export `DKG_AGENT_URI` so annotations have a prov:wasAttributedTo. Refusing to write anonymously.',
  );

// ── RDF term helpers (mirror writes.ts) ────────────────────────────
const U = (iri: string): string => `<${iri}>`;
const L = (v: string | number, datatype?: string): string => {
  const s = typeof v === 'string' ? v : String(v);
  const esc = escapeSparqlLiteral(s);
  return datatype ? `"${esc}"^^<${datatype}>` : `"${esc}"`;
};

const TypeP = NS.rdf + 'type';
const LabelP = NS.rdfs + 'label';
const NameP = NS.schema + 'name';
const TitleP = NS.dcterms + 'title';
const CreatedP = NS.dcterms + 'created';
const AttrP = NS.prov + 'wasAttributedTo';

const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DATE = 'http://www.w3.org/2001/XMLSchema#date';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

/**
 * Slug normalisation per the coding-project ontology (Section 7).
 * Deterministic. The agent's look-before-mint protocol applies the
 * SAME algorithm so reuse decisions are stable across agents/machines.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'with',
]);

function normaliseSlug(input: string): string {
  // 1. lowercase. 2. NFKD + strip diacritics. 3. strip stopwords.
  // 4. hyphenate. 5. trim. 6. truncate to 60.
  const folded = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  const tokens = folded
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOPWORDS.has(t));
  return tokens.join('-').slice(0, 60).replace(/^-+|-+$/g, '');
}

function rand(n = 6): string {
  return Math.random().toString(36).slice(2, 2 + n);
}

function emit(
  sink: Array<{ subject: string; predicate: string; object: string }>,
  subject: string,
  predicate: string,
  object: string,
): void {
  sink.push({ subject, predicate, object });
}

/** Wrap a bare string as a URI if it doesn't already look like one. */
function toUri(maybeUri: string, defaultType = 'concept'): string {
  if (maybeUri.startsWith('urn:') || maybeUri.startsWith('http:') || maybeUri.startsWith('https:') || maybeUri.startsWith('did:')) {
    return maybeUri;
  }
  // Treat as a free-text label and mint a concept URI.
  const slug = normaliseSlug(maybeUri);
  return `urn:dkg:${defaultType}:${slug}`;
}

/**
 * Resolve the most-recent chat:Turn URI authored by `agentUri` in the
 * project's `chat` sub-graph. Used when the caller omits `turnUri` —
 * the common case for "annotate the turn I just produced".
 */
async function resolveLatestTurn(
  client: DkgClient,
  contextGraphId: string,
  agentUri: string,
): Promise<string | null> {
  const sparql = `${PREFIXES}
SELECT ?t WHERE {
  GRAPH ?g {
    ?t a <${NS.chat}Turn> ;
       <${NS.prov}wasAttributedTo> <${agentUri}> ;
       <${NS.dcterms}created> ?ts .
  }
}
ORDER BY DESC(?ts) LIMIT 1`;
  try {
    const result = await client.query({
      sparql,
      contextGraphId,
      subGraphName: 'chat',
      includeSharedMemory: true,
    });
    const row = result.bindings?.[0];
    if (!row) return null;
    const cell = row.t;
    const value = bindingValue(cell);
    if (!value) return null;
    return value.replace(/^<|>$/g, '');
  } catch {
    return null;
  }
}

export function registerAnnotationTools(
  server: McpServer,
  client: DkgClient,
  config: DkgConfig,
): void {
  // ── dkg_get_ontology ─────────────────────────────────────────
  server.registerTool(
    'dkg_get_ontology',
    {
      title: 'Get Project Ontology',
      description:
        'Fetch the project ontology — both the formal Turtle/OWL document ' +
        '(canonical predicates, classes, URI patterns) and the agent guide ' +
        'markdown (operational instructions for how to annotate turns). ' +
        'Call once per session; the result tells you which predicates and ' +
        'URI patterns to use in dkg_annotate_turn for THIS project.',
      inputSchema: {
        projectId: z.string().optional().describe('contextGraphId; defaults to .dkg/config.yaml'),
      },
    },
    async ({ projectId }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      const ontologyUri = `urn:dkg:project:${pid}:ontology`;
      const guideUri = `${ontologyUri}:agent-guide`;
      const sparql = `${PREFIXES}
SELECT ?subject ?text ?fmt WHERE {
  GRAPH ?g {
    ?subject <${NS.schema}text> ?text ;
             <${NS.schema}encodingFormat> ?fmt .
    FILTER(?subject = <${ontologyUri}> || ?subject = <${guideUri}>)
  }
}`;
      try {
        const result = await client.query({
          sparql,
          contextGraphId: pid,
          subGraphName: 'meta',
          includeSharedMemory: true,
        });
        const rows = result.bindings ?? [];
        if (!rows.length) {
          return errResult(
            `No ontology found for project '${pid}'. Run \`node scripts/import-ontology.mjs --project=${pid} --starter=<name>\` to install one. Available starters: coding-project, book-research, pkm, scientific-research, narrative-writing.`,
          );
        }
        let ttl = '';
        let guide = '';
        for (const row of rows) {
          const subject = bindingValue(row.subject as any).replace(/^<|>$/g, '');
          const text = bindingValue(row.text as any).replace(/^"|"$/g, '');
          const fmt = bindingValue(row.fmt as any).replace(/^"|"$/g, '');
          // Unescape literal escape sequences our writer encoded
          const decoded = text
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
          if (subject === ontologyUri && fmt.includes('turtle')) ttl = decoded;
          else if (subject === guideUri && fmt.includes('markdown')) guide = decoded;
        }
        const out = `# Project ontology for \`${pid}\`

## Agent guide (operational instructions)

${guide || '_(missing — re-run import-ontology.mjs)_'}

---

## Ontology proper (formal Turtle/OWL)

\`\`\`turtle
${ttl || '# (missing — re-run import-ontology.mjs)'}
\`\`\``;
        return ok(out);
      } catch (e) {
        return errResult(`Failed to fetch ontology: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_annotate_turn ────────────────────────────────────────
  server.registerTool(
    'dkg_annotate_turn',
    {
      title: 'Annotate Chat Turn',
      description:
        'Emit structured triples ABOUT the latest (or specified) chat ' +
        'turn — topics, mentions, examines, proposes, concludes, asks ' +
        '— plus optional sugared writes for proposedDecisions, ' +
        'proposedTasks, comments, vmPublishRequests. Call this exactly ' +
        'once per substantive turn. The chat sub-graph then becomes a ' +
        'navigable knowledge graph rather than just a text log. Apply ' +
        'the look-before-mint protocol (call dkg_search first) before ' +
        'minting any new URI.',
      inputSchema: {
        turnUri: z.string().optional().describe('Full URI of the chat:Turn to annotate. If omitted, the latest turn authored by your agent in this project is used.'),
        topics: z.array(z.string()).optional().describe('chat:topic literals — short topical buckets ("Python parsing", "performance"). Emit liberally.'),
        mentions: z.array(z.string()).optional().describe('chat:mentions URIs — entities the turn referenced. Apply look-before-mint first. Bare strings are wrapped as urn:dkg:concept:<slug>.'),
        examines: z.array(z.string()).optional().describe('chat:examines URIs — entities the turn analysed in detail (vs just citing).'),
        concludes: z.array(z.string()).optional().describe('chat:concludes URIs — Findings the turn produced. Bare strings minted as urn:dkg:finding:<slug>.'),
        asks: z.array(z.string()).optional().describe('chat:asks URIs — Questions the turn left open. Bare strings minted as urn:dkg:question:<slug>.'),
        proposedDecisions: z.array(z.object({
          title: z.string(),
          context: z.string(),
          outcome: z.string(),
          consequences: z.string().optional(),
          status: z.enum(['proposed', 'accepted', 'rejected', 'superseded']).optional(),
        })).optional().describe('Decisions to mint and link via chat:proposes.'),
        proposedTasks: z.array(z.object({
          title: z.string(),
          status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
          priority: z.enum(['p0', 'p1', 'p2', 'p3']).optional(),
          assignee: z.string().optional(),
          relatedDecision: z.string().optional(),
        })).optional().describe('Tasks to mint and link via chat:proposes.'),
        comments: z.array(z.object({
          about: z.string().describe('URI of the entity being commented on'),
          body: z.string(),
        })).optional().describe('Comments to file against existing entities.'),
        vmPublishRequests: z.array(z.object({
          entityUri: z.string(),
          rationale: z.string(),
        })).optional().describe('Markers requesting human review for on-chain VM publish (the agent NEVER publishes directly).'),
        projectId: z.string().optional(),
      },
    },
    async (args): Promise<ToolResult> => {
      const pid = resolveProject(args.projectId, config);
      if (!pid) return projectErr();
      if (!config.agentUri) return agentErr();

      // Resolve the turn URI (caller-supplied or latest).
      let turnUri = args.turnUri;
      if (!turnUri) {
        const latest = await resolveLatestTurn(client, pid, config.agentUri);
        if (!latest) {
          return errResult(
            `No chat:Turn found for agent ${config.agentUri} in project ${pid}. ` +
            'Pass `turnUri` explicitly, or wait for at least one turn to be captured first.',
          );
        }
        turnUri = latest;
      }

      const triples: Array<{ subject: string; predicate: string; object: string }> = [];
      const newEntityUris: string[] = [];
      const nowIso = new Date().toISOString();

      // ── Universal primitives ────────────────────────────────
      for (const t of args.topics ?? []) {
        emit(triples, U(turnUri), U(NS.chat + 'topic'), L(t));
      }
      for (const m of args.mentions ?? []) {
        emit(triples, U(turnUri), U(NS.chat + 'mentions'), U(toUri(m, 'concept')));
      }
      for (const e of args.examines ?? []) {
        emit(triples, U(turnUri), U(NS.chat + 'examines'), U(toUri(e, 'concept')));
      }

      // Findings — referenced via chat:concludes; minted as :Finding entities
      for (const f of args.concludes ?? []) {
        const fUri = toUri(f, 'finding');
        emit(triples, U(turnUri), U(NS.chat + 'concludes'), U(fUri));
        // If newly minted (i.e. caller passed a bare string), declare type + label
        if (!f.startsWith('urn:') && !f.startsWith('http')) {
          emit(triples, U(fUri), U(TypeP), U('http://dkg.io/ontology/coding-project/Finding'));
          emit(triples, U(fUri), U(LabelP), L(f));
          emit(triples, U(fUri), U(NameP), L(f));
          emit(triples, U(fUri), U(CreatedP), L(nowIso, XSD_DATETIME));
          emit(triples, U(fUri), U(AttrP), U(config.agentUri));
          newEntityUris.push(fUri);
        }
      }
      // Questions — referenced via chat:asks; minted as :Question entities
      for (const q of args.asks ?? []) {
        const qUri = toUri(q, 'question');
        emit(triples, U(turnUri), U(NS.chat + 'asks'), U(qUri));
        if (!q.startsWith('urn:') && !q.startsWith('http')) {
          emit(triples, U(qUri), U(TypeP), U('http://dkg.io/ontology/coding-project/Question'));
          emit(triples, U(qUri), U(LabelP), L(q));
          emit(triples, U(qUri), U(NameP), L(q));
          emit(triples, U(qUri), U(CreatedP), L(nowIso, XSD_DATETIME));
          emit(triples, U(qUri), U(AttrP), U(config.agentUri));
          newEntityUris.push(qUri);
        }
      }

      // ── Sugared writes ──────────────────────────────────────
      for (const d of args.proposedDecisions ?? []) {
        const slug = normaliseSlug(d.title);
        const decUri = `urn:dkg:decision:${slug}-${rand(4)}`;
        const decStatus = d.status ?? 'proposed';
        emit(triples, U(decUri), U(TypeP), U(NS.decisions + 'Decision'));
        emit(triples, U(decUri), U(NameP), L(d.title));
        emit(triples, U(decUri), U(LabelP), L(d.title));
        emit(triples, U(decUri), U(TitleP), L(d.title));
        emit(triples, U(decUri), U(NS.decisions + 'context'), L(d.context));
        emit(triples, U(decUri), U(NS.decisions + 'outcome'), L(d.outcome));
        if (d.consequences) emit(triples, U(decUri), U(NS.decisions + 'consequences'), L(d.consequences));
        emit(triples, U(decUri), U(NS.decisions + 'status'), L(decStatus));
        emit(triples, U(decUri), U(NS.decisions + 'date'), L(nowIso, XSD_DATETIME));
        emit(triples, U(decUri), U(CreatedP), L(nowIso, XSD_DATETIME));
        emit(triples, U(decUri), U(AttrP), U(config.agentUri));
        emit(triples, U(turnUri), U(NS.chat + 'proposes'), U(decUri));
        newEntityUris.push(decUri);
      }
      for (const t of args.proposedTasks ?? []) {
        const slug = normaliseSlug(t.title);
        const taskUri = `urn:dkg:task:${slug}-${rand(4)}`;
        emit(triples, U(taskUri), U(TypeP), U(NS.tasks + 'Task'));
        emit(triples, U(taskUri), U(NameP), L(t.title));
        emit(triples, U(taskUri), U(LabelP), L(t.title));
        emit(triples, U(taskUri), U(TitleP), L(t.title));
        emit(triples, U(taskUri), U(NS.tasks + 'status'), L(t.status ?? 'todo'));
        emit(triples, U(taskUri), U(NS.tasks + 'priority'), L(t.priority ?? 'p2'));
        emit(triples, U(taskUri), U(CreatedP), L(nowIso, XSD_DATETIME));
        if (t.assignee) {
          const assigneeUri = t.assignee.startsWith('urn:') || t.assignee.startsWith('http')
            ? t.assignee
            : `urn:dkg:github:user:${encodeURIComponent(t.assignee)}`;
          emit(triples, U(taskUri), U(NS.tasks + 'assignee'), U(assigneeUri));
        }
        if (t.relatedDecision) {
          const decUri = t.relatedDecision.startsWith('urn:') || t.relatedDecision.startsWith('http')
            ? t.relatedDecision
            : `urn:dkg:decision:${encodeURIComponent(t.relatedDecision)}`;
          emit(triples, U(taskUri), U(NS.tasks + 'relatedDecision'), U(decUri));
        }
        emit(triples, U(taskUri), U(AttrP), U(config.agentUri));
        emit(triples, U(turnUri), U(NS.chat + 'proposes'), U(taskUri));
        newEntityUris.push(taskUri);
      }
      for (const c of args.comments ?? []) {
        const commentUri = `urn:dkg:comment:${rand(10)}-${Date.now()}`;
        emit(triples, U(commentUri), U(TypeP), U(NS.schema + 'Comment'));
        emit(triples, U(commentUri), U(NameP), L(c.body.slice(0, 80) + (c.body.length > 80 ? '…' : '')));
        emit(triples, U(commentUri), U(LabelP), L(`Comment on ${c.about}`));
        emit(triples, U(commentUri), U(NS.schema + 'text'), L(c.body));
        emit(triples, U(commentUri), U(NS.schema + 'about'), U(c.about));
        emit(triples, U(commentUri), U(NS.chat + 'aboutEntity'), U(c.about));
        emit(triples, U(commentUri), U(CreatedP), L(nowIso, XSD_DATETIME));
        emit(triples, U(commentUri), U(AttrP), U(config.agentUri));
        emit(triples, U(turnUri), U(NS.chat + 'mentions'), U(commentUri));
        newEntityUris.push(commentUri);
      }
      for (const v of args.vmPublishRequests ?? []) {
        const vmUri = `urn:dkg:vm-publish-request:${rand(8)}-${Date.now()}`;
        emit(triples, U(vmUri), U(TypeP), U('http://dkg.io/ontology/VmPublishRequest'));
        emit(triples, U(vmUri), U(LabelP), L(`VM publish request: ${v.entityUri}`));
        emit(triples, U(vmUri), U(NameP), L('VM publish request'));
        emit(triples, U(vmUri), U('http://dkg.io/ontology/requestsPublishOf'), U(v.entityUri));
        emit(triples, U(vmUri), U('http://dkg.io/ontology/rationale'), L(v.rationale));
        emit(triples, U(vmUri), U(CreatedP), L(nowIso, XSD_DATETIME));
        emit(triples, U(vmUri), U(AttrP), U(config.agentUri));
        emit(triples, U(turnUri), U(NS.chat + 'mentions'), U(vmUri));
        newEntityUris.push(vmUri);
      }

      if (triples.length === 0) {
        return errResult(
          'Empty annotation. Pass at least one of: topics, mentions, examines, concludes, asks, proposedDecisions, proposedTasks, comments, vmPublishRequests.',
        );
      }

      // Stable assertion name keyed off the turn so re-annotations of the
      // same turn replace cleanly.
      const turnSuffix = turnUri.replace(/[^A-Za-z0-9]+/g, '-').slice(-40);
      const assertion = `agent-annotate-${turnSuffix}-${rand(4)}`;
      try {
        await client.ensureSubGraph(pid, 'chat');
        await client.writeAssertion({
          contextGraphId: pid,
          assertionName: assertion,
          subGraphName: 'chat',
          triples,
        });
        let shared = false;
        if (config.capture.autoShare) {
          try {
            await client.promoteAssertion({
              contextGraphId: pid,
              assertionName: assertion,
              subGraphName: 'chat',
              entities: [turnUri, ...newEntityUris],
            });
            shared = true;
          } catch (e) {
            // Promote failure on annotation is non-fatal.
            return ok(buildSummary(turnUri, args, newEntityUris, triples.length, false, formatError(e)));
          }
        }
        return ok(buildSummary(turnUri, args, newEntityUris, triples.length, shared));
      } catch (e) {
        return errResult(`Failed to annotate turn: ${formatError(e)}`);
      }
    },
  );
}

function buildSummary(
  turnUri: string,
  args: any,
  newEntityUris: string[],
  tripleCount: number,
  shared: boolean,
  promoteError?: string,
): string {
  const counts = {
    topics: args.topics?.length ?? 0,
    mentions: args.mentions?.length ?? 0,
    examines: args.examines?.length ?? 0,
    concludes: args.concludes?.length ?? 0,
    asks: args.asks?.length ?? 0,
    proposedDecisions: args.proposedDecisions?.length ?? 0,
    proposedTasks: args.proposedTasks?.length ?? 0,
    comments: args.comments?.length ?? 0,
    vmPublishRequests: args.vmPublishRequests?.length ?? 0,
  };
  const lines = [
    `${shared ? '✔' : promoteError ? '⚠' : '✔'} Annotated turn \`${turnUri}\`${shared ? ' (auto-promoted to SWM)' : promoteError ? ` (WM only — promote failed: ${promoteError})` : ' (WM only)'}.`,
    '',
    `**Triples emitted:** ${tripleCount}`,
    '',
    '| Predicate | Count |',
    '| --- | --- |',
    ...Object.entries(counts)
      .filter(([_, n]) => n > 0)
      .map(([k, n]) => `| \`${k}\` | ${n} |`),
  ];
  if (newEntityUris.length) {
    lines.push('', `**${newEntityUris.length} new entit${newEntityUris.length === 1 ? 'y' : 'ies'} minted:**`);
    for (const uri of newEntityUris) lines.push(`- \`${uri}\``);
  }
  return lines.join('\n');
}
