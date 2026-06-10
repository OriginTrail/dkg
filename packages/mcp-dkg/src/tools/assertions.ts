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
 * The `name` regex on `dkg_knowledge_asset_create` is creator-side input
 * validation only; read-side and import paths accept any pre-existing
 * assertion name.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DkgClient } from '../client.js';
import type { DkgConfig } from '../config.js';
import { EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION } from './context-graph-description.js';

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
  // ── dkg_knowledge_asset_create ──────────────────────────────────
  server.registerTool(
    'dkg_knowledge_asset_create',
    {
      title: 'Create Knowledge Asset',
      description:
        'Step 1 of the canonical write flow (create → write → finalize → share → publish): ' +
        'create an empty Working Memory draft for a knowledge asset. Idempotent — ' +
        'duplicate names land as `alreadyExists: true` rather than throwing. Slug must match ' +
        '/^[a-z0-9-]+$/ for new names; pre-existing assets accept any name.',
      inputSchema: {
        name: z
          .string()
          .regex(/^[a-z0-9-]+$/, 'Assertion name must be lowercase a-z, 0-9, or hyphen')
          .describe('Assertion name slug (e.g. "session-2026-04-30")'),
        projectId: z
          .string()
          .optional()
          .describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
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
        // Create now hits the KA route (`POST /api/knowledge-assets`),
        // which is an idempotent get-or-create that reports `alreadyExists`
        // in its response body alongside the back-compat `assertionUri`.
        // `client.createAssertion` reads that flag (with a legacy
        // error-string fallback) so this contract is unchanged.
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

  // ── dkg_knowledge_asset_write ───────────────────────────────────
  server.registerTool(
    'dkg_knowledge_asset_write',
    {
      title: 'Write Quads to Knowledge Asset',
      description:
        'Step 2 of the canonical write flow: append RDF quads into an ' +
        'existing Working Memory draft. Writes are additive (set-merge); ' +
        'callers that want replace semantics should call `dkg_knowledge_asset_discard` ' +
        'first or mint a unique asset name per snapshot.\n\n' +
        'IMPORTANT — triple shape: each triple has subject/predicate/object. ' +
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
            }),
          )
          .min(1)
          .describe('Non-empty array of RDF triples to append'),
        projectId: z.string().optional().describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
        subGraphName: z.string().optional(),
      },
    },
    async ({ name, quads, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        // Append to the KA's WM draft. Strip angle brackets from URIs (the
        // engine wants bare URIs). Wire shape is {subject, predicate, object}
        // only — no per-quad `graph` (CONTRACT §0 invariant 2; the daemon pins
        // every triple to the per-KA WM graph and overrides any client value).
        const strip = (t: string): string =>
          t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t;
        const kaQuads = quads.map((q) => ({
          subject: strip(q.subject),
          predicate: strip(q.predicate),
          object: q.object,
        }));
        const { written } = await client.knowledgeAssetWrite({
          contextGraphId: pid,
          name,
          subGraphName,
          quads: kaQuads,
        });
        return ok(
          `Wrote ${written} quad(s) to assertion '${name}' in '${pid}'.`,
        );
      } catch (e) {
        return errResult(`Failed to write assertion: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_knowledge_asset_finalize ────────────────────────────────
  server.registerTool(
    'dkg_knowledge_asset_finalize',
    {
      title: 'Finalize (Seal) Knowledge Asset',
      description:
        'Step 3 of the canonical write flow: seal a knowledge asset\'s Working ' +
        'Memory draft — computes the merkle root and signs the EIP-712 ' +
        'AuthorAttestation. Finalize always seals the WHOLE draft (there is no ' +
        'subset parameter). A FULL share (dkg_knowledge_asset_share with ' +
        '`entities` omitted or "all") auto-seals for you, so you only need to ' +
        'call this explicitly before sharing a SELECTIVE subset of entities, or ' +
        'to re-seal after editing a previously-sealed draft. (External-signer / ' +
        'pre-signed attestation is a tracked follow-up and is not exposed by this ' +
        'tool — author with authorAgentAddress.)',
      inputSchema: {
        name: z.string().describe('Existing knowledge asset name to finalize'),
        authorAgentAddress: z
          .string()
          .optional()
          .describe(
            'Optional 0x author address to attest as. Omit to let the daemon ' +
            'default the author to the request token\'s agent.',
          ),
        // CONTRACT §C: scheme_version is a POSITIVE integer (daemon >= 1) — zod
        // rejects 0 / negative / non-integer at the boundary as a tool error.
        schemeVersion: z.number().int().positive().optional().describe('Optional attestation scheme version (positive integer)'),
        projectId: z.string().optional().describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
        subGraphName: z.string().optional(),
      },
    },
    async ({ name, authorAgentAddress, schemeVersion, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        // Seal the WHOLE WM draft (CONTRACT §1 Stage3 — no subset scope on
        // finalize). The author defaults to the request token's agent when
        // `authorAgentAddress` is omitted; pre-signed attestations are not
        // surfaced on this tool (they require the packed reservedKaId — out of
        // scope here), matching the OpenClaw adapter.
        const result = await client.knowledgeAssetFinalize({
          contextGraphId: pid,
          name,
          subGraphName,
          authorAgentAddress,
          schemeVersion,
        });
        return ok(
          `Finalized (sealed) knowledge asset '${name}' (project '${pid}'):\n\n\`\`\`json\n${JSON.stringify(
            result,
            null,
            2,
          )}\n\`\`\``,
        );
      } catch (e) {
        return errResult(`Failed to finalize knowledge asset: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_knowledge_asset_share ───────────────────────────────────
  server.registerTool(
    'dkg_knowledge_asset_share',
    {
      title: 'Share Knowledge Asset to SWM',
      description:
        'Step 4 of the canonical write flow: share a knowledge asset (or ' +
        'specific root entities within it) from private Working Memory to ' +
        'Shared Working Memory so teammates see it. A FULL share (omit ' +
        '`entities` or pass "all") attempts a best-effort auto-seal: when the ' +
        'seal SUCCEEDS the asset is publish-ready — follow it with ' +
        'dkg_knowledge_asset_publish to mint the asset on-chain (Verifiable ' +
        'Memory). But on a capability/signing gap (no local signing key / ' +
        'non-V10 adapter / unregistered CG) the auto-seal is skipped and the ' +
        'asset is shared UNSEALED — a later dkg_knowledge_asset_publish then ' +
        '409s requiring an explicit finalize. For predictable publishing, call ' +
        'dkg_knowledge_asset_finalize EXPLICITLY first (this is also required to ' +
        'carry custom finalize/attestation options — authorAgentAddress / ' +
        'schemeVersion — which the auto-seal cannot). A SELECTIVE subset (`entities` set ' +
        'to a proper subset) shares to SWM only for peer visibility, is NOT ' +
        'auto-sealed, and is NOT publishable to Verifiable Memory: ' +
        'dkg_knowledge_asset_publish reconstructs the seal\'s full root set and ' +
        'rejects a truncated SWM with a merkleRoot mismatch. To publish on-chain, ' +
        'share the full asset (or model the subset as its own knowledge asset).',
      inputSchema: {
        name: z.string().describe('Existing knowledge asset name'),
        // CONTRACT §B: accept "all" | string[] | omitted. The daemon reads
        // parsed.entities and treats "all"/omitted as a full share.
        entities: z
          .union([z.literal('all'), z.array(z.string())])
          .optional()
          .describe(
            'Root entities to share. Omit (or pass the string "all") to share all ' +
            'roots (auto-seals + publish-ready). A subset (non-empty array) shares ' +
            'to SWM only and is NOT publishable to Verifiable Memory.',
          ),
        projectId: z.string().optional().describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
        subGraphName: z.string().optional(),
      },
    },
    async ({ name, entities, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      // CONTRACT §B: "all" | string[] | omitted. Pass "all" / omitted through as a
      // full share (omitted ⇒ undefined ⇒ daemon default); a non-empty array is the
      // subset. An empty array is rejected client-side (the daemon would 400 it) —
      // fail fast, never coerce to "all" or omit.
      if (Array.isArray(entities) && entities.length === 0) {
        return errResult(
          '"entities" must be omitted, the string "all", or a non-empty array of root entity URIs.',
        );
      }
      try {
        // WM → SWM. The KA `swm/share` route is the same engine call
        // (`agent.assertion.promote`) the legacy promote used; omit `entities`
        // to share every root (the route's default), pass "all", or pass a subset.
        await client.knowledgeAssetShare({
          contextGraphId: pid,
          name,
          subGraphName,
          entities,
        });
        const scope = Array.isArray(entities)
          ? `${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}`
          : 'all root entities';
        return ok(`Shared ${scope} from knowledge asset '${name}' (project '${pid}') to SWM.`);
      } catch (e) {
        return errResult(`Failed to share knowledge asset: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_knowledge_asset_publish ─────────────────────────────────
  server.registerTool(
    'dkg_knowledge_asset_publish',
    {
      title: 'Publish Knowledge Asset to VM',
      description:
        'Step 5 of the canonical write flow: publish ONE finalized + shared ' +
        'knowledge asset (by name) from Shared Working Memory to Verifiable ' +
        'Memory on-chain, minting or updating it. Returns the asset\'s UAL ' +
        '(Universal Asset Locator, `did:dkg:<chainId>/<author>/<number>`) plus ' +
        '`kaId`, `txHash`, `status`, and `kas`. The seal already selects the ' +
        'author and the whole asset — do not pass author or selection overrides. ' +
        'Prefer this over dkg_shared_memory_publish when publishing a single ' +
        'named asset; it is multi-root-safe and avoids the legacy single-root ' +
        'SWM constraint. Fails 409 if the asset is not yet finalized + shared ' +
        '(run dkg_knowledge_asset_finalize / dkg_knowledge_asset_share first). ' +
        'vm/publish requires the context graph to be registered on-chain — set ' +
        '`registerIfNeeded: true` to register it first (idempotent) before publishing.',
      inputSchema: {
        // CONTRACT §C: publishEpochs is a POSITIVE integer (zod rejects 0 /
        // negative / non-integer at the boundary → a fail-fast tool error).
        name: z.string().describe('Knowledge asset name to publish (must be finalized + shared)'),
        publishEpochs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional number of epochs to publish for (positive integer)'),
        // CONTRACT §C: NON-NEGATIVE integer as a decimal string (daemon /^\d+$/).
        // Validated at the boundary so a bad value is a clear tool error, not a
        // generic client throw.
        publisherNodeIdentityIdOverride: z
          .string()
          .regex(/^\d+$/, 'publisher_node_identity_id_override must be a non-negative integer (decimal string)')
          .optional()
          .describe('Optional publisher node identity id override (non-negative integer, decimal string)'),
        // CONTRACT §G: vm/publish requires the CG to be registered on-chain and
        // does NOT auto-register. registerIfNeeded registers first (idempotent),
        // mirroring dkg_shared_memory_publish.
        registerIfNeeded: z
          .boolean()
          .optional()
          .describe(
            'If the context graph is not yet registered on-chain, register it first (idempotent), then ' +
            'publish. Registration may spend gas/TRAC; opt-in. Default false — when false and the CG is ' +
            'unregistered, publish fails with the daemon\'s not-registered error.',
          ),
        accessPolicy: z
          .union([z.literal(0), z.literal(1)])
          .optional()
          .describe('Used only when `registerIfNeeded: true`. 0 = open, 1 = private.'),
        // CONTRACT §D: clear_shared_memory_after is NOT exposed on the per-asset
        // publish tool — on vm/publish it is graph-wide destructive (wipes every
        // other agent's unpublished SWM under the CG/sub-graph). The this-asset
        // cleanup runs unconditionally regardless. The CG-wide clear stays on
        // dkg_publish / dkg_shared_memory_publish.
        projectId: z.string().optional().describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
        subGraphName: z.string().optional(),
      },
    },
    async ({
      name,
      publishEpochs,
      publisherNodeIdentityIdOverride,
      registerIfNeeded,
      accessPolicy,
      projectId,
      subGraphName,
    }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      // CONTRACT §G: vm/publish requires the CG to be registered on-chain and does
      // NOT auto-register. When registerIfNeeded is true, register first (the
      // client short-circuits an already-registered CG via alreadyRegistered), then
      // publish — mirroring dkg_shared_memory_publish. A hard registration failure
      // is a tool error: do NOT publish.
      if (registerIfNeeded === true) {
        try {
          await client.registerContextGraph({ id: pid, accessPolicy });
        } catch (err) {
          return errResult(`Failed to register context graph: ${formatError(err)}`);
        }
      }
      try {
        // Per-KA sealed publish (CONTRACT §1 Stage5). The seal selects the author
        // and the whole asset, so author/selection overrides are never sent. The
        // daemon returns the UAL plus kaId/txHash/status/kas; 409
        // VM_PUBLISH_PRECONDITION (not finalized / empty SWM) and 502 (on-chain
        // not-confirmed) surface verbatim. MCP is JSON-facing, so the node
        // identity id override is a decimal string (not a JS number).
        const result = await client.knowledgeAssetPublish({
          contextGraphId: pid,
          name,
          subGraphName,
          publishEpochs,
          publisherNodeIdentityIdOverride,
        });
        // CONTRACT §1 Stage5 / §7: vm/publish returns HTTP 207 (treated as success
        // by DkgClient.request, which only throws on !res.ok) when the KA minted
        // on-chain but the context-graph binding FAILED — `contextGraphError` is
        // present in the body. The UAL/kaId are valid and the asset IS published
        // on-chain, so this is NOT a hard failure and must NOT be reported as full
        // success — but the agent must NOT re-publish: a confirmed publish clears
        // SWM, so a retry 409s VM_PUBLISH_PRECONDITION (and never re-binds the CG).
        // The CG-binding retry is an operator/daemon concern.
        const contextGraphError = (result as Record<string, unknown>).contextGraphError;
        if (typeof contextGraphError === 'string' && contextGraphError.length > 0) {
          return ok(
            `PARTIAL publish of knowledge asset '${name}' (project '${pid}'): the asset IS published ` +
            `on-chain (the UAL/kaId below are valid and final) — only the context-graph binding FAILED ` +
            `(${contextGraphError}). Do NOT re-publish: the asset is already minted, the publish cleared ` +
            `Shared Working Memory, and a retry will fail the VM precondition without re-binding the context ` +
            `graph. Surface this to the operator to re-attempt the context-graph binding.` +
            `\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
          );
        }
        return ok(
          `Published knowledge asset '${name}' (project '${pid}') to Verifiable Memory:\n\n\`\`\`json\n${JSON.stringify(
            result,
            null,
            2,
          )}\n\`\`\``,
        );
      } catch (e) {
        return errResult(`Failed to publish knowledge asset: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_knowledge_asset_pull_from ───────────────────────────────
  server.registerTool(
    'dkg_knowledge_asset_pull_from',
    {
      title: 'Pull Knowledge Asset into WM Draft',
      description:
        'Seed a fresh Working Memory draft for a knowledge asset from its ' +
        'current Shared Working Memory (swm) or Verifiable Memory (vm) state — ' +
        'the edit-loop primitive (like git checkout). Use this to re-open an ' +
        'already-shared or published asset for editing. Fails 409 ' +
        '(WM_DRAFT_CONFLICT) if an open draft already exists; pass ' +
        '`onConflict: "replace"` to overwrite it or discard the draft first.',
      inputSchema: {
        name: z.string().describe('Knowledge asset name to seed a draft for'),
        layer: z
          .enum(['swm', 'vm'])
          .describe('Which layer to seed the draft from: "swm" (Shared Working Memory) or "vm" (Verifiable Memory)'),
        onConflict: z
          .enum(['reject', 'replace'])
          .optional()
          .describe('What to do if an open WM draft already exists. Defaults to "reject".'),
        projectId: z.string().optional().describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
        subGraphName: z.string().optional(),
      },
    },
    async ({ name, layer, onConflict, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        // Seed a fresh WM draft from SWM/VM (CONTRACT §1 side-verbs). A dirty
        // draft → 409 WM_DRAFT_CONFLICT, surfaced verbatim; the agent can retry
        // with onConflict:"replace".
        const result = await client.knowledgeAssetPullFrom({
          contextGraphId: pid,
          name,
          layer,
          onConflict,
          subGraphName,
        });
        return ok(
          `Seeded a WM draft for knowledge asset '${name}' (project '${pid}') from ${layer.toUpperCase()}:\n\n\`\`\`json\n${JSON.stringify(
            result,
            null,
            2,
          )}\n\`\`\``,
        );
      } catch (e) {
        return errResult(`Failed to pull knowledge asset into a WM draft: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_knowledge_asset_discard ─────────────────────────────────
  server.registerTool(
    'dkg_knowledge_asset_discard',
    {
      title: 'Discard Knowledge Asset Draft',
      description:
        'Discard a Working Memory draft without sharing it. Idempotent — ' +
        'no-op on a missing draft. Use before re-writing an asset ' +
        'whose name you want to keep stable but whose contents you want to ' +
        '*replace* rather than *merge*.',
      inputSchema: {
        name: z.string().describe('Existing assertion name'),
        projectId: z.string().optional().describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
        subGraphName: z.string().optional(),
      },
    },
    async ({ name, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        await client.knowledgeAssetDiscard({
          contextGraphId: pid,
          name,
          subGraphName,
        });
        return ok(`Discarded assertion '${name}' from project '${pid}'.`);
      } catch (e) {
        return errResult(`Failed to discard assertion: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_knowledge_asset_query ───────────────────────────────────
  server.registerTool(
    'dkg_knowledge_asset_query',
    {
      title: 'Dump Knowledge Asset Quads',
      description:
        'Return every quad in a knowledge asset\'s Working Memory DRAFT (the ' +
        'un-shared working copy). Query it BEFORE sharing: a FULL share empties ' +
        'the WM draft, so a query after sharing returns 0 quads. To inspect ' +
        'already-shared content use `dkg_query` with `view: ' +
        '"shared-working-memory"` (or `"verifiable-memory"` once published). Not ' +
        'a SPARQL endpoint — for ad-hoc filtering of the draft use `dkg_query` ' +
        'with `view: "working-memory"`.',
      inputSchema: {
        name: z.string().describe('Existing assertion name'),
        projectId: z.string().optional().describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
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

  // ── dkg_knowledge_asset_import_file ─────────────────────────────
  // Wave-2 P1 add (audit §7 item 4). Wraps
  // `POST /api/knowledge-assets/{name}/wm/import-file` (multipart/form-data) —
  // the daemon's extraction pipeline turns markdown / PDF / DOCX /
  // etc. into RDF triples and writes them into the assertion's graph.
  server.registerTool(
    'dkg_knowledge_asset_import_artifact_resolve',
    {
      title: 'Resolve Imported Artifact',
      description:
        'Optional validation/debug helper: resolve a completed imported attachment/assertion into deterministic metadata such as source file hash, Markdown hash/form, extraction method, root entity, and structural counts. Skipped imports are rejected.',
      inputSchema: {
        projectId: z.string().optional().describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
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
    'dkg_knowledge_asset_import_artifact_read_markdown',
    {
      title: 'Read Imported Artifact Markdown',
      description:
        'Read Markdown for a completed imported attachment via the daemon content-addressed file store. This never reads arbitrary filesystem paths.',
      inputSchema: {
        projectId: z.string().optional().describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
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
    'dkg_knowledge_asset_semantic_enrichment_write',
    {
      title: 'Write Semantic Enrichment',
      description:
        'Append model-derived semantic triples to a completed imported assertion with daemon-stamped provenance. Does not promote, finalize, or publish.',
      inputSchema: {
        projectId: z.string().optional().describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
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
    'dkg_knowledge_asset_import_file',
    {
      title: 'Import File into Knowledge Asset',
      description:
        'Import a local document (markdown, PDF, DOCX, etc.) into a ' +
        'Working Memory draft: the daemon runs its extraction ' +
        'pipeline and writes the resulting triples. text/markdown is ' +
        'native; other types need a registered converter (extraction ' +
        'returns `status: "skipped"` if none). Useful for seeding a ' +
        'context graph from existing documents in a single step.',
      inputSchema: {
        name: z.string().describe('Target assertion name'),
        filePath: z.string().describe('Absolute local path to the file to import'),
        projectId: z.string().optional().describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
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

  // ── dkg_knowledge_asset_history ─────────────────────────────────
  // Wave-2 P3 add (audit §7 item 12). Wraps
  // `GET /api/knowledge-assets/{name}` — lifecycle introspection.
  server.registerTool(
    'dkg_knowledge_asset_history',
    {
      title: 'Knowledge Asset History',
      description:
        "Fetch an assertion's lifecycle descriptor: author, " +
        'extraction status, promotion state, timestamps. Returns a ' +
        '404 (surfaced as a tool error) if no record exists for the ' +
        '(contextGraphId, name, agentAddress) tuple. Useful for ' +
        'debug/audit; not required for the canonical write flow.',
      inputSchema: {
        name: z.string().describe('Assertion name'),
        projectId: z.string().optional().describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
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
        // Read hits the KA descriptor route (`GET /api/knowledge-assets/{name}`),
        // which accepts `contextGraphId`, `subGraphName`, and `agentAddress`
        // as query params — so author-scoped history lookups still work.
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
