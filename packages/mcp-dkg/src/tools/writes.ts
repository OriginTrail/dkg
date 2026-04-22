/**
 * Agent-authored write tools for the DKG MCP server.
 *
 * Every write follows the same canonical path already used by the
 * scripts in `scripts/import-*.mjs` and by the capture hook:
 *
 *   1. Compose triples (incl. `prov:wasAttributedTo <agent>`).
 *   2. POST `/api/assertion/<name>/write` with a JSON quads array.
 *   3. If `autoShare` is true (the spec default), POST
 *      `/api/assertion/<name>/promote` with the new entity URIs to lift
 *      them from WM into SWM so teammates see them immediately.
 *
 * The agent NEVER publishes to VM directly — that stays a human click
 * in the node-ui's VerifyOnDkgButton flow. `dkg_request_vm_publish`
 * just writes a marker entity saying "I think this is ready to anchor".
 *
 * Attribution guarantees: every write attaches
 * `prov:wasAttributedTo <config.agentUri>` at triple time. The in-flight
 * R/W PR will later validate that claim cryptographically; until then,
 * same-operator setups get honest attribution and multi-operator setups
 * fall back to "trust the hostname" — which is fine for this PoC.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DkgClient } from '../client.js';
import type { DkgConfig } from '../config.js';
import { NS, escapeSparqlLiteral } from '../sparql.js';

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
    'No agent URI configured. Set `agent.uri` in `.dkg/config.yaml` or export `DKG_AGENT_URI` so this write has a prov:wasAttributedTo. Refusing to write anonymously.',
  );

// ── RDF term helpers ────────────────────────────────────────────
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

/** Slugify a free-form title into a URI-safe suffix. */
function slugify(input: string, fallback: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || fallback;
}

/** Unique-enough suffix so two writes in the same millisecond don't collide. */
function rand(n = 6): string {
  return Math.random().toString(36).slice(2, 2 + n);
}

/**
 * Short deterministic fingerprint of the content fields that define an
 * entity's "semantic identity". Used as a URI discriminator so two
 * genuinely distinct decisions/tasks that happen to share a title
 * don't collapse into one RDF subject while still letting agents
 * propose the SAME decision/task (same title AND same content) and
 * converge on the same URI — which is the look-before-mint convergence
 * rule from AGENTS.md.
 *
 * Codex tier-4m flagged the pure title-slug URI (N19 removed the
 * random suffix but didn't add an alternative discriminator): two
 * different decisions with the same title merged unrelated
 * status/context/consequence triples onto one subject.
 *
 * djb2-style 32-bit rolling hash encoded in base36 → 4-char suffix.
 * Collision probability at modest volumes (a few thousand entities
 * per project) is ~1 in 1.7M, which is well below the same-title
 * collision rate the old code exhibited.
 */
function contentFingerprint(...fields: Array<string | number | undefined | null>): string {
  const joined = fields
    .filter((v): v is string | number => v !== undefined && v !== null && v !== '')
    .map((v) => String(v).trim().toLowerCase())
    .join('|');
  if (!joined) return '';
  let h = 5381;
  for (let i = 0; i < joined.length; i++) {
    h = ((h << 5) + h + joined.charCodeAt(i)) | 0;
  }
  const unsigned = h >>> 0;
  return unsigned.toString(36).padStart(4, '0').slice(-4);
}

/** Push a `{ subject, predicate, object }` triple into `sink`. */
function emit(
  sink: Array<{ subject: string; predicate: string; object: string }>,
  subject: string,
  predicate: string,
  object: string,
): void {
  sink.push({ subject, predicate, object });
}

export function registerWriteTools(
  server: McpServer,
  client: DkgClient,
  config: DkgConfig,
): void {
  // ── dkg_propose_decision ─────────────────────────────────────
  server.registerTool(
    'dkg_propose_decision',
    {
      title: 'Propose Decision',
      description:
        'Author a `decisions:Decision` and auto-promote to SWM so the team ' +
        'sees it immediately. Use for architectural choices, trade-offs, or ' +
        'pivots the agent wants to propose on the operator\'s behalf. ' +
        'Humans ratify to VM via the node-ui VerifyOnDkgButton — MCP never ' +
        'publishes on-chain.',
      inputSchema: {
        title: z.string().describe('Short sentence capturing the choice, e.g. "Adopt tree-sitter for Python parsing".'),
        context: z.string().describe('Why this decision is being made (problem, constraints).'),
        outcome: z.string().describe('The chosen direction — the decision itself.'),
        consequences: z.string().optional().describe('What this implies going forward (trade-offs, follow-ups).'),
        status: z.enum(['proposed', 'accepted', 'rejected', 'superseded']).optional().describe('Default: proposed.'),
        projectId: z.string().optional(),
      },
    },
    async ({ title, context, outcome, consequences, status, projectId }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      if (!config.agentUri) return agentErr();
      const decStatus = status ?? 'proposed';
      const slug = slugify(title, `decision-${rand()}`);
      // Deterministic URI with a short content fingerprint: agents
      // writing the SAME decision (same title, same outcome, same
      // context) converge on the same URI per the AGENTS.md
      // look-before-mint rule. But two decisions that happen to share
      // a title and nothing else no longer collapse into one RDF
      // subject with merged status/context/consequence triples (Codex
      // tier-4m N34). The assertion name below still carries a rand(4)
      // so the SAME-identity decision can be re-asserted with wording
      // tweaks without colliding on the write layer.
      const fp = contentFingerprint(title, outcome, context, decStatus);
      const id = fp ? `urn:dkg:decision:${slug}-${fp}` : `urn:dkg:decision:${slug}`;
      const nowIso = new Date().toISOString();
      const triples: Array<{ subject: string; predicate: string; object: string }> = [];
      emit(triples, U(id), U(TypeP), U(NS.decisions + 'Decision'));
      emit(triples, U(id), U(NameP), L(title));
      emit(triples, U(id), U(LabelP), L(title));
      emit(triples, U(id), U(TitleP), L(title));
      emit(triples, U(id), U(NS.decisions + 'context'), L(context));
      emit(triples, U(id), U(NS.decisions + 'outcome'), L(outcome));
      if (consequences) emit(triples, U(id), U(NS.decisions + 'consequences'), L(consequences));
      emit(triples, U(id), U(NS.decisions + 'status'), L(decStatus));
      emit(triples, U(id), U(NS.decisions + 'date'), L(nowIso, XSD_DATETIME));
      emit(triples, U(id), U(CreatedP), L(nowIso, XSD_DATETIME));
      emit(triples, U(id), U(AttrP), U(config.agentUri));

      const assertion = `agent-decision-${slug}-${rand(4)}`;
      try {
        await client.ensureSubGraph(pid, 'decisions');
        await client.writeAssertion({
          contextGraphId: pid,
          assertionName: assertion,
          subGraphName: 'decisions',
          triples,
        });
        let shared = false;
        if (config.capture.autoShare) {
          try {
            await client.promoteAssertion({
              contextGraphId: pid,
              assertionName: assertion,
              subGraphName: 'decisions',
              entities: [id],
            });
            shared = true;
          } catch (e) {
            return ok(
              `Decision written but promote failed: ${formatError(e)}\n\n` +
                `- **URI**: \`${id}\`\n- **assertion**: \`${assertion}\`\n- **layer**: WM only (manual promote needed)`,
            );
          }
        }
        return ok(
          `✔ Decision ${shared ? '**shared** (WM → SWM)' : 'written to WM'}:\n\n` +
            `- **URI**: \`${id}\`\n` +
            `- **status**: ${decStatus}\n` +
            `- **attributed to**: \`${config.agentUri}\`\n` +
            `- **assertion**: \`${assertion}\`\n\n` +
            `Humans can ratify to VM on-chain via the node-ui VerifyOnDkgButton.`,
        );
      } catch (e) {
        return errResult(`Failed to propose decision: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_add_task ──────────────────────────────────────────────
  server.registerTool(
    'dkg_add_task',
    {
      title: 'Add Task',
      description:
        'Author a `tasks:Task` and auto-promote to SWM. Use when the agent ' +
        'wants to file follow-up work detected during a chat (e.g. "revisit ' +
        'SHACL on promote path"). Attribution via prov:wasAttributedTo.',
      inputSchema: {
        title: z.string().describe('Imperative, e.g. "Add SHACL validation on /promote endpoint".'),
        status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']).optional().describe('Default: todo.'),
        priority: z.enum(['p0', 'p1', 'p2', 'p3']).optional().describe('Default: p2.'),
        assignee: z.string().optional().describe('GitHub login or agent slug.'),
        estimate: z.number().optional().describe('Hours. Integer.'),
        dueDate: z.string().optional().describe('ISO date (YYYY-MM-DD).'),
        relatedDecision: z.array(z.string()).optional().describe('Decision slugs or full URIs.'),
        touches: z.array(z.string()).optional().describe('File or package URIs that the task edits.'),
        projectId: z.string().optional(),
      },
    },
    async ({ title, status, priority, assignee, estimate, dueDate, relatedDecision, touches, projectId }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      if (!config.agentUri) return agentErr();
      const st = status ?? 'todo';
      const pr = priority ?? 'p2';
      const slug = slugify(title, `task-${rand()}`);
      // Deterministic URI with a short content fingerprint (same
      // rationale as `dkg_propose_decision`): same title+assignee+
      // dueDate+priority converge, genuinely distinct tasks with the
      // same title don't merge. Codex tier-4m N34.
      const fp = contentFingerprint(title, assignee, dueDate, st, pr);
      const id = fp ? `urn:dkg:task:${slug}-${fp}` : `urn:dkg:task:${slug}`;
      const nowIso = new Date().toISOString();
      const triples: Array<{ subject: string; predicate: string; object: string }> = [];
      emit(triples, U(id), U(TypeP), U(NS.tasks + 'Task'));
      emit(triples, U(id), U(NameP), L(title));
      emit(triples, U(id), U(LabelP), L(title));
      emit(triples, U(id), U(TitleP), L(title));
      emit(triples, U(id), U(NS.tasks + 'status'), L(st));
      emit(triples, U(id), U(NS.tasks + 'priority'), L(pr));
      emit(triples, U(id), U(CreatedP), L(nowIso, XSD_DATETIME));
      if (typeof estimate === 'number') emit(triples, U(id), U(NS.tasks + 'estimate'), L(estimate, XSD_INT));
      if (assignee) {
        const assigneeUri = assignee.startsWith('urn:') || assignee.startsWith('http')
          ? assignee
          : `urn:dkg:github:user:${encodeURIComponent(assignee)}`;
        emit(triples, U(id), U(NS.tasks + 'assignee'), U(assigneeUri));
      }
      if (dueDate) emit(triples, U(id), U(NS.tasks + 'dueDate'), L(dueDate, XSD_DATE));
      for (const dec of relatedDecision ?? []) {
        const decUri = dec.startsWith('urn:') || dec.startsWith('http')
          ? dec
          : `urn:dkg:decision:${encodeURIComponent(dec)}`;
        emit(triples, U(id), U(NS.tasks + 'relatedDecision'), U(decUri));
      }
      for (const t of touches ?? []) emit(triples, U(id), U(NS.tasks + 'touches'), U(t));
      emit(triples, U(id), U(AttrP), U(config.agentUri));

      const assertion = `agent-task-${slug}-${rand(4)}`;
      try {
        await client.ensureSubGraph(pid, 'tasks');
        await client.writeAssertion({
          contextGraphId: pid,
          assertionName: assertion,
          subGraphName: 'tasks',
          triples,
        });
        let shared = false;
        if (config.capture.autoShare) {
          try {
            await client.promoteAssertion({
              contextGraphId: pid,
              assertionName: assertion,
              subGraphName: 'tasks',
              entities: [id],
            });
            shared = true;
          } catch (e) {
            return ok(
              `Task written but promote failed: ${formatError(e)}\n\n- **URI**: \`${id}\`\n- **assertion**: \`${assertion}\`\n- **layer**: WM only`,
            );
          }
        }
        return ok(
          `✔ Task ${shared ? '**shared** (WM → SWM)' : 'written to WM'}:\n\n` +
            `- **URI**: \`${id}\`\n` +
            `- **status**: ${st} · **priority**: ${pr}${assignee ? ` · **assignee**: ${assignee}` : ''}\n` +
            `- **attributed to**: \`${config.agentUri}\`\n` +
            `- **assertion**: \`${assertion}\``,
        );
      } catch (e) {
        return errResult(`Failed to add task: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_comment ──────────────────────────────────────────────
  server.registerTool(
    'dkg_comment',
    {
      title: 'Comment on Entity',
      description:
        'Attach a short comment to any existing DKG entity (decision, ' +
        'task, PR, file, chat turn). Comments use the chat sub-graph under ' +
        'their own assertion and auto-promote so teammates see them. ' +
        'Rendered by the UI as a threaded note on the target entity.',
      inputSchema: {
        entityUri: z.string().describe('Full URI of the entity to comment on.'),
        body: z.string().describe('Comment body (markdown allowed).'),
        projectId: z.string().optional(),
      },
    },
    async ({ entityUri, body, projectId }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      if (!config.agentUri) return agentErr();
      const nowIso = new Date().toISOString();
      const id = `urn:dkg:comment:${rand(10)}-${Date.now()}`;
      const triples: Array<{ subject: string; predicate: string; object: string }> = [];
      emit(triples, U(id), U(TypeP), U(NS.schema + 'Comment'));
      emit(triples, U(id), U(NameP), L(body.slice(0, 80) + (body.length > 80 ? '…' : '')));
      emit(triples, U(id), U(LabelP), L(`Comment on ${entityUri}`));
      emit(triples, U(id), U(NS.schema + 'text'), L(body));
      emit(triples, U(id), U(NS.schema + 'about'), U(entityUri));
      emit(triples, U(id), U(NS.chat + 'aboutEntity'), U(entityUri));
      emit(triples, U(id), U(CreatedP), L(nowIso, XSD_DATETIME));
      emit(triples, U(id), U(AttrP), U(config.agentUri));

      const assertion = `agent-comment-${rand(6)}`;
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
              entities: [id],
            });
            shared = true;
          } catch (e) {
            return ok(
              `Comment written but promote failed: ${formatError(e)}\n\n- **URI**: \`${id}\`\n- **assertion**: \`${assertion}\``,
            );
          }
        }
        return ok(
          `✔ Comment ${shared ? '**shared**' : 'written'} on \`${entityUri}\`:\n\n` +
            `- **URI**: \`${id}\`\n- **attributed to**: \`${config.agentUri}\``,
        );
      } catch (e) {
        return errResult(`Failed to write comment: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_request_vm_publish ───────────────────────────────────
  server.registerTool(
    'dkg_request_vm_publish',
    {
      title: 'Request VM Publish (human-ratified)',
      description:
        'Writes a `dkg:VmPublishRequest` marker entity saying "this SWM ' +
        'entity is ready to anchor on-chain". Does NOT publish to VM. ' +
        'The node-ui surfaces these as pending review items that a human ' +
        'completes via VerifyOnDkgButton. Enforces the spec\'s human-gates-' +
        'VM rule per `APP_MULTI_AGENT_CODING §3.4`.',
      inputSchema: {
        entityUri: z.string().describe('URI of the SWM entity you want anchored.'),
        rationale: z.string().describe('Why this entity warrants on-chain commitment (TRAC cost + permanence).'),
        projectId: z.string().optional(),
      },
    },
    async ({ entityUri, rationale, projectId }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      if (!config.agentUri) return agentErr();
      const nowIso = new Date().toISOString();
      const id = `urn:dkg:vm-publish-request:${rand(8)}-${Date.now()}`;
      const triples: Array<{ subject: string; predicate: string; object: string }> = [];
      emit(triples, U(id), U(TypeP), U('http://dkg.io/ontology/VmPublishRequest'));
      emit(triples, U(id), U(LabelP), L(`VM publish request: ${entityUri}`));
      emit(triples, U(id), U(NameP), L('VM publish request'));
      emit(triples, U(id), U('http://dkg.io/ontology/requestsPublishOf'), U(entityUri));
      emit(triples, U(id), U('http://dkg.io/ontology/rationale'), L(rationale));
      emit(triples, U(id), U(CreatedP), L(nowIso, XSD_DATETIME));
      emit(triples, U(id), U(AttrP), U(config.agentUri));

      const assertion = `agent-vm-request-${rand(6)}`;
      try {
        await client.ensureSubGraph(pid, 'meta');
        await client.writeAssertion({
          contextGraphId: pid,
          assertionName: assertion,
          subGraphName: 'meta',
          triples,
        });
        if (config.capture.autoShare) {
          try {
            await client.promoteAssertion({
              contextGraphId: pid,
              assertionName: assertion,
              subGraphName: 'meta',
              entities: [id],
            });
          } catch {
            // promote failures on a marker entity are non-fatal; the marker
            // still exists in WM and can be promoted by hand.
          }
        }
        return ok(
          `✔ VM publish request written:\n\n` +
            `- **marker URI**: \`${id}\`\n` +
            `- **target**: \`${entityUri}\`\n` +
            `- **attributed to**: \`${config.agentUri}\`\n\n` +
            `Next step: open the target in the node-ui → click **Verify on DKG** to anchor on-chain.`,
        );
      } catch (e) {
        return errResult(`Failed to file VM publish request: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_set_session_privacy ──────────────────────────────────
  server.registerTool(
    'dkg_set_session_privacy',
    {
      title: 'Set Session Privacy',
      description:
        'Flip a chat session\'s `chat:privacy` flag. `private` keeps its ' +
        'turns WM-only (not gossiped); `team` (default) auto-promotes every ' +
        'new turn to SWM; `public` is the same as team for now but signals ' +
        '"safe to anchor". Useful for "let me think out loud without the ' +
        'team seeing" moments. Applies to turns written AFTER the flip.',
      inputSchema: {
        sessionUri: z.string().describe('Full URI of the chat session.'),
        privacy: z.enum(['private', 'team', 'public']),
        projectId: z.string().optional(),
      },
    },
    async ({ sessionUri, privacy, projectId }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      if (!config.agentUri) return agentErr();
      const nowIso = new Date().toISOString();
      const triples: Array<{ subject: string; predicate: string; object: string }> = [];
      emit(triples, U(sessionUri), U(NS.chat + 'privacy'), L(privacy));
      emit(triples, U(sessionUri), U(NS.dcterms + 'modified'), L(nowIso, XSD_DATETIME));
      emit(triples, U(sessionUri), U(AttrP), U(config.agentUri));

      const assertion = `agent-privacy-${rand(6)}`;
      try {
        await client.ensureSubGraph(pid, 'chat');
        await client.writeAssertion({
          contextGraphId: pid,
          assertionName: assertion,
          subGraphName: 'chat',
          triples,
        });
        if (config.capture.autoShare) {
          try {
            await client.promoteAssertion({
              contextGraphId: pid,
              assertionName: assertion,
              subGraphName: 'chat',
              entities: [sessionUri],
            });
          } catch {
            /* non-fatal */
          }
        }
        return ok(
          `✔ Session \`${sessionUri}\` privacy set to **${privacy}**.\n\n` +
            `New turns on this session will ${
              privacy === 'private' ? 'stay WM-only (not gossiped)' : 'auto-promote to SWM'
            }.`,
        );
      } catch (e) {
        return errResult(`Failed to set session privacy: ${formatError(e)}`);
      }
    },
  );
}
