/**
 * Raw assertion CRUD + introspection tools for the DKG MCP server.
 *
 * These are the P0 "memory backend" tools per parity-matrix v0.5 §4.14 + §4.16:
 * five tools that expose the canonical four-step write lifecycle plus a
 * dump-everything introspection helper. They are intentionally lower-level
 * than the sugared `dkg_propose_decision` / `dkg_add_task` write tools —
 * agents can persist arbitrary RDF without inventing per-shape sugar, and
 * defer the WM→SWM promotion decision (write now, share later).
 *
 * Argument-key alignment per matrix v0.5 OQ-a: `name` flows through every
 * tool unchanged, matching the OpenClaw adapter (`DkgNodePlugin.ts:2399+`).
 * The `name` regex on `dkg_assertion_create` is creator-side input
 * validation only; read-side and import paths accept any pre-existing
 * assertion name.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DkgClient } from '../client.js';
import type { DkgConfig } from '../config.js';

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

export function registerAssertionTools(
  server: McpServer,
  client: DkgClient,
  config: DkgConfig,
): void {
  // ── dkg_assertion_create ────────────────────────────────────────
  server.registerTool(
    'dkg_assertion_create',
    {
      title: 'Create Assertion',
      description:
        'Step 1 of the canonical write flow: create an empty Working Memory ' +
        'assertion graph. Idempotent — duplicate names land as ' +
        '`alreadyExists: true` rather than throwing. Slug must match ' +
        '/^[a-z0-9-]+$/ for new names; pre-existing assertions accept any name.',
      inputSchema: {
        name: z
          .string()
          .regex(/^[a-z0-9-]+$/, 'Assertion name must be lowercase a-z, 0-9, or hyphen')
          .describe('Assertion name slug (e.g. "session-2026-04-30")'),
        projectId: z
          .string()
          .optional()
          .describe('contextGraphId; defaults to .dkg/config.yaml'),
        subGraphName: z
          .string()
          .optional()
          .describe('Optional sub-graph to scope the assertion to'),
      },
    },
    async ({ name, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        const result = await client.createAssertion({
          contextGraphId: pid,
          assertionName: name,
          subGraphName,
        });
        if (result.alreadyExists) {
          return ok(`Assertion '${name}' already exists in '${pid}'.`);
        }
        return ok(
          `Created assertion '${name}' in '${pid}'.\nURI: ${result.assertionUri ?? '(unset)'}`,
        );
      } catch (e) {
        return errResult(`Failed to create assertion: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_assertion_write ─────────────────────────────────────────
  server.registerTool(
    'dkg_assertion_write',
    {
      title: 'Write Quads to Assertion',
      description:
        'Step 2 of the canonical write flow: append RDF quads into an ' +
        'existing Working Memory assertion. Writes are additive (set-merge); ' +
        'callers that want replace semantics should call `dkg_assertion_discard` ' +
        'first or mint a unique assertion name per snapshot.\n\n' +
        'IMPORTANT — quad shape: each quad has subject/predicate/object/graph. ' +
        'Subjects and predicates are ALWAYS URIs (no spaces). The `object` field ' +
        'accepts EITHER a URI (no surrounding quotes) OR a literal string ' +
        'WRAPPED IN DOUBLE QUOTES. Most common mistake: passing free-text ' +
        'literals without quotes — those get parsed as URIs and fail on the ' +
        'embedded spaces.',
      inputSchema: {
        name: z.string().describe('Existing assertion name (e.g. "my-notes-2026-05-07")'),
        quads: z
          .array(
            z.object({
              subject: z.string().describe(
                'Subject URI. Plain string like "urn:my-thing" or "did:dkg:agent/abc". ' +
                'Angle brackets are tolerated and stripped (`<urn:foo>` → `urn:foo`). ' +
                'MUST NOT contain spaces — URIs are space-free by spec.',
              ),
              predicate: z.string().describe(
                'Predicate URI. Same rules as subject. Common predicates: ' +
                '"rdfs:label", "rdf:type", "schema:name", or any custom URI.',
              ),
              object: z.string().describe(
                'Object value. EITHER a URI (same rules as subject — plain or ' +
                'angle-bracketed, no spaces) OR a literal string WRAPPED IN ' +
                'DOUBLE QUOTES.\n' +
                '  URI example:     "urn:other-thing"  or  "<urn:other-thing>"\n' +
                '  Literal example: "\\"Hello world with spaces\\""  ← double quotes mandatory for literals\n' +
                '  Typed literal:   "\\"42\\"^^<http://www.w3.org/2001/XMLSchema#integer>"\n' +
                '  Lang-tagged:     "\\"hello\\"@en"\n' +
                'A literal without surrounding quotes will be parsed as a URI and FAIL on spaces.',
              ),
              graph: z.string().optional().describe('Optional named graph URI (same rules as subject)'),
            }),
          )
          .min(1)
          .describe('Non-empty array of RDF quads to append'),
        projectId: z.string().optional(),
        subGraphName: z.string().optional(),
      },
    },
    async ({ name, quads, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        // Keep the input shape (subject/predicate/object/graph) — the daemon
        // accepts the union shape used by both adapter-openclaw and mcp-dkg.
        // Strip angle brackets from URIs to match the existing
        // `client.writeAssertion` triples shape; the adapter does the same
        // at the handler level.
        const strip = (t: string): string =>
          t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t;
        const triples = quads.map((q) => ({
          subject: strip(q.subject),
          predicate: strip(q.predicate),
          object: q.object,
        }));
        await client.writeAssertion({
          contextGraphId: pid,
          assertionName: name,
          subGraphName,
          triples,
        });
        return ok(
          `Wrote ${triples.length} quad(s) to assertion '${name}' in '${pid}'.`,
        );
      } catch (e) {
        return errResult(`Failed to write assertion: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_assertion_promote ───────────────────────────────────────
  server.registerTool(
    'dkg_assertion_promote',
    {
      title: 'Promote Assertion to SWM',
      description:
        'Step 3 of the canonical write flow: promote a Working Memory ' +
        'assertion (or specific root entities within it) from private WM to ' +
        'Shared Working Memory so teammates see it. Omit `entities` to ' +
        'promote every root entity.',
      inputSchema: {
        name: z.string().describe('Existing assertion name'),
        entities: z
          .array(z.string())
          .optional()
          .describe(
            'Root entity URIs to promote. Omit to promote all roots.',
          ),
        projectId: z.string().optional(),
        subGraphName: z.string().optional(),
      },
    },
    async ({ name, entities, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      // Provided entities must be a non-empty array of URIs; omitted means
      // "promote all roots" (daemon-side default).
      if (entities !== undefined && entities.length === 0) {
        return errResult(
          '"entities" must be omitted or a non-empty array of root entity URIs.',
        );
      }
      try {
        await client.promoteAssertion({
          contextGraphId: pid,
          assertionName: name,
          subGraphName,
          // The tool blocks empty-array from callers (validated above)
          // because the schema's intent is unambiguous: omit means
          // promote-all. The empty-array IS the daemon's "promote all"
          // sentinel internally — `promoteAssertion` requires an array
          // shape — but we hide that wire detail from the public surface
          // so the API has one canonical "promote all" form (omit).
          entities: entities ?? [],
        });
        const scope = entities && entities.length > 0
          ? `${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}`
          : 'all root entities';
        return ok(`Promoted ${scope} from assertion '${name}' (project '${pid}') to SWM.`);
      } catch (e) {
        return errResult(`Failed to promote assertion: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_assertion_discard ───────────────────────────────────────
  server.registerTool(
    'dkg_assertion_discard',
    {
      title: 'Discard Assertion',
      description:
        'Discard a Working Memory assertion without promoting it. Idempotent — ' +
        'no-op on a missing assertion. Use before re-writing an assertion ' +
        'whose name you want to keep stable but whose contents you want to ' +
        '*replace* rather than *merge*.',
      inputSchema: {
        name: z.string().describe('Existing assertion name'),
        projectId: z.string().optional(),
        subGraphName: z.string().optional(),
      },
    },
    async ({ name, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        await client.discardAssertion({
          contextGraphId: pid,
          assertionName: name,
          subGraphName,
        });
        return ok(`Discarded assertion '${name}' from project '${pid}'.`);
      } catch (e) {
        return errResult(`Failed to discard assertion: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_assertion_query ─────────────────────────────────────────
  server.registerTool(
    'dkg_assertion_query',
    {
      title: 'Dump Assertion Quads',
      description:
        'Return every quad in a Working Memory assertion. Not a SPARQL ' +
        'endpoint — for ad-hoc filtering use `dkg_query` with ' +
        '`view: "working-memory"`. The canonical introspection step for the ' +
        '`assertion_create + assertion_write + assertion_promote` round-trip.',
      inputSchema: {
        name: z.string().describe('Existing assertion name'),
        projectId: z.string().optional(),
        subGraphName: z.string().optional(),
      },
    },
    async ({ name, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        const result = await client.queryAssertion({
          contextGraphId: pid,
          assertionName: name,
          subGraphName,
        });
        const header = `Assertion '${name}' (project '${pid}'): ${result.count} quad(s).`;
        if (result.count === 0) return ok(header);
        // Render quads as compact JSON; keeps the wire shape obvious for
        // agents that want to round-trip into a write.
        const body = JSON.stringify(result.quads, null, 2);
        return ok(`${header}\n\n\`\`\`json\n${body}\n\`\`\``);
      } catch (e) {
        return errResult(`Failed to query assertion: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_assertion_import_file ───────────────────────────────────
  // Wave-2 P1 add (audit §7 item 4). Wraps
  // `POST /api/assertion/{name}/import-file` (multipart/form-data) —
  // the daemon's extraction pipeline turns markdown / PDF / DOCX /
  // etc. into RDF triples and writes them into the assertion's graph.
  server.registerTool(
    'dkg_import_artifact_resolve',
    {
      title: 'Resolve Imported Artifact',
      description:
        'Optional validation/debug helper: resolve a completed imported attachment/assertion into deterministic metadata such as source file hash, Markdown hash/form, extraction method, root entity, and structural counts. Skipped imports are rejected.',
      inputSchema: {
        projectId: z.string().optional().describe('contextGraphId; defaults to .dkg/config.yaml'),
        assertionUri: z.string().min(1).describe('Completed imported assertion URI from the attachment ref'),
        fileHash: z.string().optional().describe('Optional source file hash to verify'),
        subGraphName: z.string().optional(),
      },
    },
    async ({ projectId, assertionUri, fileHash, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        const result = await client.resolveImportArtifact({
          contextGraphId: pid,
          assertionUri,
          fileHash,
          subGraphName,
        });
        return ok(`Imported artifact:\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``);
      } catch (e) {
        return errResult(`Failed to resolve imported artifact: ${formatError(e)}`);
      }
    },
  );

  server.registerTool(
    'dkg_import_artifact_read_markdown',
    {
      title: 'Read Imported Artifact Markdown',
      description:
        'Read Markdown for a completed imported attachment via the daemon content-addressed file store. This never reads arbitrary filesystem paths.',
      inputSchema: {
        projectId: z.string().optional().describe('contextGraphId; defaults to .dkg/config.yaml'),
        assertionUri: z.string().min(1).describe('Completed imported assertion URI from the attachment ref'),
        fileHash: z.string().optional().describe('Optional source file hash to verify'),
        subGraphName: z.string().optional(),
        maxBytes: z.number().int().positive().optional().describe('Optional byte cap; daemon maximum is 5 MiB'),
      },
    },
    async ({ projectId, assertionUri, fileHash, subGraphName, maxBytes }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        const result = await client.readImportArtifactMarkdown({
          contextGraphId: pid,
          assertionUri,
          fileHash,
          subGraphName,
          maxBytes,
        });
        return ok(`Imported artifact Markdown:\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``);
      } catch (e) {
        return errResult(`Failed to read imported artifact Markdown: ${formatError(e)}`);
      }
    },
  );

  server.registerTool(
    'dkg_semantic_enrichment_write',
    {
      title: 'Write Semantic Enrichment',
      description:
        'Append model-derived semantic triples to a completed imported assertion with daemon-stamped provenance. Does not promote, finalize, or publish.',
      inputSchema: {
        projectId: z.string().optional().describe('contextGraphId; defaults to .dkg/config.yaml'),
        assertionUri: z.string().min(1).describe('Source imported assertion URI from the attachment ref'),
        fileHash: z.string().optional().describe('Optional source file hash to verify'),
        semanticQuads: z
          .array(
            z
              .object({
                subject: z.string(),
                predicate: z.string(),
                object: z.string(),
              })
              .strict(),
          )
          .min(1)
          .describe('Model-derived semantic triples; plain-text objects become RDF literals, provenance is added by the daemon, and all triples are appended to the source imported assertion graph'),
        generationMethod: z.string().optional(),
        agentIdentity: z.string().optional().describe('Agent identity URI or label; only URIs are emitted as prov:wasAttributedTo resources'),
        generatedAt: z.string().optional(),
        subGraphName: z.string().optional(),
      },
    },
    async ({
      projectId,
      assertionUri,
      fileHash,
      semanticQuads,
      generationMethod,
      agentIdentity,
      generatedAt,
      subGraphName,
    }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        const result = await client.writeSemanticEnrichment({
          contextGraphId: pid,
          assertionUri,
          fileHash,
          subGraphName,
          semanticQuads,
          generationMethod,
          agentIdentity,
          generatedAt,
        });
        return ok(`Semantic enrichment written:\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``);
      } catch (e) {
        return errResult(`Failed to write semantic enrichment: ${formatError(e)}`);
      }
    },
  );

  server.registerTool(
    'dkg_assertion_import_file',
    {
      title: 'Import File into Assertion',
      description:
        'Import a local document (markdown, PDF, DOCX, etc.) into a ' +
        'Working Memory assertion: the daemon runs its extraction ' +
        'pipeline and writes the resulting triples. text/markdown is ' +
        'native; other types need a registered converter (extraction ' +
        'returns `status: "skipped"` if none). Useful for seeding a ' +
        'context graph from existing documents in a single step.',
      inputSchema: {
        name: z.string().describe('Target assertion name'),
        filePath: z.string().describe('Absolute local path to the file to import'),
        projectId: z.string().optional(),
        contentType: z
          .string()
          .optional()
          .describe(
            'MIME override (e.g. "text/markdown", "application/pdf"). Inferred from extension when omitted.',
          ),
        ontologyRef: z
          .string()
          .optional()
          .describe('Optional ontology URI to guide extraction'),
        subGraphName: z.string().optional(),
      },
    },
    async ({
      name,
      filePath,
      projectId,
      contentType,
      ontologyRef,
      subGraphName,
    }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      const trimmedPath = filePath.trim();
      if (!trimmedPath) return errResult('"filePath" is required.');

      // Load the file lazily — `node:fs/promises` is import-on-demand
      // so the bare stdio MCP server doesn't pay the disk-I/O cost
      // unless this tool actually fires.
      let fileBuffer: Buffer;
      let fileName: string;
      try {
        const { readFile } = await import('node:fs/promises');
        const { basename } = await import('node:path');
        fileBuffer = await readFile(trimmedPath);
        fileName = basename(trimmedPath);
      } catch (e) {
        return errResult(
          `Failed to read file at "${trimmedPath}": ${formatError(e)}`,
        );
      }

      // Extension-based MIME inference. Mirrors the adapter's
      // `inferContentTypeFromExtension` (`DkgNodePlugin.ts:3544+`)
      // for cross-surface parity. Unmatched extensions fall through
      // to the daemon's `application/octet-stream` default; callers
      // can still override via `contentType`.
      let effectiveContentType = contentType;
      if (!effectiveContentType) {
        const ext = fileName.split('.').pop()?.toLowerCase();
        const inferred = ext
          ? {
              md: 'text/markdown',
              markdown: 'text/markdown',
              pdf: 'application/pdf',
              docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              html: 'text/html',
              htm: 'text/html',
              txt: 'text/plain',
              csv: 'text/csv',
            }[ext]
          : undefined;
        if (inferred) effectiveContentType = inferred;
      }

      try {
        const result = await client.importAssertionFile({
          contextGraphId: pid,
          assertionName: name,
          fileBuffer,
          fileName,
          contentType: effectiveContentType,
          ontologyRef,
          subGraphName,
        });
        const extraction = (result as Record<string, unknown>).extraction as
          | Record<string, unknown>
          | undefined;
        const status = extraction?.status ?? '(unknown)';
        const tripleCount = extraction?.tripleCount;
        const lines = [
          `Imported '${fileName}' into assertion '${name}' (project '${pid}').`,
          `Extraction status: ${status}` +
            (typeof tripleCount === 'number' ? ` · ${tripleCount} triple(s)` : ''),
          effectiveContentType ? `Content type: ${effectiveContentType}` : null,
        ]
          .filter((line): line is string => line !== null)
          .join('\n');
        return ok(lines);
      } catch (e) {
        return errResult(`Failed to import file: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_assertion_history ───────────────────────────────────────
  // Wave-2 P3 add (audit §7 item 12). Wraps
  // `GET /api/assertion/{name}/history` — lifecycle introspection.
  server.registerTool(
    'dkg_assertion_history',
    {
      title: 'Assertion History',
      description:
        "Fetch an assertion's lifecycle descriptor: author, " +
        'extraction status, promotion state, timestamps. Returns a ' +
        '404 (surfaced as a tool error) if no record exists for the ' +
        '(contextGraphId, name, agentAddress) tuple. Useful for ' +
        'debug/audit; not required for the canonical write flow.',
      inputSchema: {
        name: z.string().describe('Assertion name'),
        projectId: z.string().optional(),
        agentAddress: z
          .string()
          .optional()
          .describe("Optional author — defaults to this node's agent address"),
        subGraphName: z.string().optional(),
      },
    },
    async ({ name, projectId, agentAddress, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        const result = await client.getAssertionHistory({
          contextGraphId: pid,
          assertionName: name,
          agentAddress,
          subGraphName,
        });
        return ok(
          `History for assertion '${name}' (project '${pid}'):\n\n\`\`\`json\n${JSON.stringify(
            result,
            null,
            2,
          )}\n\`\`\``,
        );
      } catch (e) {
        return errResult(`Failed to fetch assertion history: ${formatError(e)}`);
      }
    },
  );
}
