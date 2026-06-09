/**
 * Assertion lifecycle, import-artifact, semantic-enrichment & sub-graph tool
 * definitions for {@link DkgNodePlugin}.
 *
 * Moved verbatim out of `DkgNodePlugin.tools()` — same metadata and handler
 * delegation, only relocated. The `execute` callbacks forward to the host's
 * `handle*` methods (see {@link DkgToolHost}). No behavior change.
 */
import type { OpenClawTool } from '../types.js';
import { EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION } from '../dkg-node-plugin-constants.js';
import type { DkgToolHost } from './tool-host.js';

export function buildAssertionTools(ctx: DkgToolHost): OpenClawTool[] {
  return [
    // ── Assertion lifecycle (Working Memory) ───────────────────────────────
    {
      name: 'dkg_knowledge_asset_create',
      description:
        'Step 1 of the canonical flow (create → write → finalize → share → publish). Create a per-agent ' +
        'Working Memory draft for a knowledge asset. Idempotent: a duplicate name returns ' +
        '`{ assertionUri: null, alreadyExists: true }`.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          name: { type: 'string', description: 'Assertion name (lowercase letters, digits, hyphens).' },
          sub_graph_name: { type: 'string', description: 'Optional sub-graph (must be pre-registered).' },
        },
        required: ['context_graph_id', 'name'],
      },
      execute: async (_toolCallId, args) => ctx.handleAssertionCreate(args),
    },
    {
      name: 'dkg_knowledge_asset_write',
      description:
        'Step 2 of the canonical flow. Append triples to a knowledge asset\'s Working Memory draft. Object ' +
        'values are auto-typed as URI or literal. The daemon pins every triple to the per-asset WM graph, so ' +
        'no named-graph field is accepted. Example: ' +
        '`{ subject: "https://example.org/a", predicate: "https://schema.org/name", object: "Alpha" }`.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          name: { type: 'string', description: 'Knowledge asset name (must already exist).' },
          quads: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                subject: { type: 'string', description: 'Subject URI.' },
                predicate: { type: 'string', description: 'Predicate URI.' },
                object: { type: 'string', description: 'Object URI or literal.' },
              },
              required: ['subject', 'predicate', 'object'],
            },
            description: 'Non-empty array of triples to append.',
          },
          sub_graph_name: { type: 'string', description: 'Must match the one used at create time.' },
        },
        required: ['context_graph_id', 'name', 'quads'],
      },
      execute: async (_toolCallId, args) => ctx.handleAssertionWrite(args),
    },
    {
      name: 'dkg_knowledge_asset_finalize',
      description:
        'Step 3 of the canonical flow. Seal a knowledge asset\'s Working Memory draft — computes the merkle ' +
        'root and signs the EIP-712 AuthorAttestation. Finalize always seals the WHOLE draft (there is no ' +
        'subset parameter). A FULL share (dkg_knowledge_asset_share with entities omitted or "all") ' +
        'auto-seals for you, so you only need to call this explicitly before sharing a SELECTIVE subset of ' +
        'entities, or to re-seal after editing a previously-sealed draft.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          name: { type: 'string', description: 'Knowledge asset name to finalize.' },
          author_agent_address: {
            type: 'string',
            description:
              'Optional 0x author address to attest as. Mutually exclusive with pre_signed_author_attestation. ' +
              'Omit to let the daemon default the author to the request token\'s agent.',
          },
          scheme_version: { type: 'integer', description: 'Optional attestation scheme version.' },
          sub_graph_name: { type: 'string', description: 'Must match the one used at write time.' },
        },
        required: ['context_graph_id', 'name'],
      },
      execute: async (_toolCallId, args) => ctx.handleAssertionFinalize(args),
    },
    {
      name: 'dkg_knowledge_asset_share',
      description:
        'Step 4 of the canonical flow. Share a knowledge asset (or selected root entities) from Working ' +
        'Memory into Shared Working Memory. A FULL share (omit `entities` or pass "all") auto-seals the ' +
        'draft best-effort and is publish-ready — follow it with dkg_knowledge_asset_publish to mint the ' +
        'asset on-chain (Verifiable Memory). A SELECTIVE subset (`entities` set to a proper subset) shares ' +
        'to SWM only for peer visibility, is NOT auto-sealed, and is NOT publishable to Verifiable Memory: ' +
        'dkg_knowledge_asset_publish reconstructs the seal\'s full root set and rejects a truncated SWM with ' +
        'a merkleRoot mismatch. To publish on-chain, share the full asset (or model the subset as its own ' +
        'knowledge asset).',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          name: { type: 'string', description: 'Knowledge asset name to share.' },
          entities: {
            type: 'array',
            items: { type: 'string', description: 'Root entity URI.' },
            description:
              'Root entity URIs to share. Omit to share every root entity (default, auto-seals + publish-ready). ' +
              'When provided, must be a non-empty array of URIs that already exist in the asset; a subset shares ' +
              'to SWM only and is NOT publishable to Verifiable Memory.',
          },
          sub_graph_name: { type: 'string', description: 'Must match the one used at write time.' },
        },
        required: ['context_graph_id', 'name'],
      },
      execute: async (_toolCallId, args) => ctx.handleAssertionPromote(args),
    },
    {
      name: 'dkg_knowledge_asset_publish',
      description:
        'Step 5 of the canonical flow. Publish ONE finalized + shared knowledge asset (by name) from Shared ' +
        'Working Memory to Verifiable Memory on-chain, minting or updating it. Returns the asset\'s UAL ' +
        '(Universal Asset Locator, `did:dkg:<chainId>/<author>/<number>`) plus `kaId`, `txHash`, `status`, ' +
        'and `kas`. The seal already selects the author and the whole asset — do not pass author or selection ' +
        'overrides. Prefer this over dkg_shared_memory_publish when publishing a single named asset; it is ' +
        'multi-root-safe and avoids the legacy single-root SWM constraint. Fails 409 if the asset is not yet ' +
        'finalized + shared (run dkg_knowledge_asset_finalize / dkg_knowledge_asset_share first).',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          name: { type: 'string', description: 'Knowledge asset name to publish (must be finalized + shared).' },
          publish_epochs: { type: 'integer', description: 'Optional number of epochs to publish for (positive integer).' },
          publisher_node_identity_id_override: {
            type: 'string',
            description: 'Optional publisher node identity id override (decimal string).',
          },
          clear_shared_memory_after: {
            type: 'boolean',
            description: 'When true, clear the asset\'s Shared Working Memory after a confirmed publish.',
          },
          sub_graph_name: { type: 'string', description: 'Must match the one used at write/share time.' },
        },
        required: ['context_graph_id', 'name'],
      },
      execute: async (_toolCallId, args) => ctx.handleAssertionPublish(args),
    },
    {
      name: 'dkg_knowledge_asset_pull_from',
      description:
        'Seed a fresh Working Memory draft for a knowledge asset from its current Shared Working Memory (swm) ' +
        'or Verifiable Memory (vm) state — the edit-loop primitive (like git checkout). Use this to re-open ' +
        'an already-shared or published asset for editing. Fails 409 (WM_DRAFT_CONFLICT) if an open draft ' +
        'already exists; pass `on_conflict: "replace"` to overwrite it or discard the draft first.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          name: { type: 'string', description: 'Knowledge asset name to seed a draft for.' },
          layer: {
            type: 'string',
            enum: ['swm', 'vm'],
            description: 'Which layer to seed the draft from: "swm" (Shared Working Memory) or "vm" (Verifiable Memory).',
          },
          on_conflict: {
            type: 'string',
            enum: ['reject', 'replace'],
            description: 'What to do if an open WM draft already exists. Defaults to "reject".',
          },
          sub_graph_name: { type: 'string', description: 'Must match the one used at write/share time.' },
        },
        required: ['context_graph_id', 'name', 'layer'],
      },
      execute: async (_toolCallId, args) => ctx.handleAssertionPullFrom(args),
    },
    {
      name: 'dkg_knowledge_asset_discard',
      description:
        'Discard a Working Memory assertion without promoting it. Errors (400) if the assertion is missing.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          name: { type: 'string', description: 'Assertion name to discard.' },
          sub_graph_name: { type: 'string', description: 'Must match the one used at create time.' },
        },
        required: ['context_graph_id', 'name'],
      },
      execute: async (_toolCallId, args) => ctx.handleAssertionDiscard(args),
    },
    {
      name: 'dkg_knowledge_asset_import_file',
      description:
        'Import a local document (markdown, PDF, etc.) into an assertion: the daemon runs its extraction ' +
        'pipeline and writes the resulting triples. text/markdown is native; other types need a registered ' +
        'converter (extraction returns `status: "skipped"` if none).',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          name: { type: 'string', description: 'Target assertion name.' },
          file_path: { type: 'string', description: 'Absolute local path to the file to import.' },
          content_type: { type: 'string', description: 'MIME override (e.g. "text/markdown", "application/pdf"). Inferred from extension when omitted — covers .md/.markdown/.pdf/.docx/.html/.htm/.txt/.csv; other extensions fall through to application/octet-stream.' },
          ontology_ref: { type: 'string', description: "Optional ontology URI to guide extraction (e.g. the CG's `_ontology`)." },
          sub_graph_name: { type: 'string', description: 'Optional sub-graph (must be pre-registered).' },
        },
        required: ['context_graph_id', 'name', 'file_path'],
      },
      execute: async (_toolCallId, args) => ctx.handleAssertionImportFile(args),
    },
    {
      name: 'dkg_knowledge_asset_query',
      description:
        'Dump every triple in a knowledge asset\'s Working Memory draft as `{ quads, count }`. NOT a SPARQL ' +
        'endpoint — use dkg_query for ad-hoc SPARQL.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          name: { type: 'string', description: 'Assertion name to dump.' },
          sub_graph_name: { type: 'string', description: 'Must match the one used at write time.' },
        },
        required: ['context_graph_id', 'name'],
      },
      execute: async (_toolCallId, args) => ctx.handleAssertionQuery(args),
    },
    {
      name: 'dkg_knowledge_asset_import_artifact_resolve',
      description:
        'Optional validation/debug helper. Resolve a completed imported attachment/assertion into deterministic artifact metadata: source file hash, ' +
        'Markdown hash/form when available, extraction method, root entity, and structural counts. Skipped imports are rejected.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Context graph id from the attachment ref. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          assertion_uri: { type: 'string', description: 'Completed imported assertion URI from the attachment ref.' },
          assertion_name: { type: 'string', description: 'Optional source assertion name to cross-check against assertion_uri.' },
          file_hash: { type: 'string', description: 'Optional source file hash to verify against deterministic metadata.' },
          sub_graph_name: { type: 'string', description: 'Optional sub-graph for the imported assertion.' },
        },
        required: ['context_graph_id', 'assertion_uri'],
      },
      execute: async (_toolCallId, args) => ctx.handleImportArtifactResolve(args),
    },
    {
      name: 'dkg_knowledge_asset_import_artifact_read_markdown',
      description:
        'Read the Markdown source for a completed imported attachment through the daemon content-addressed file store. ' +
        'Never reads arbitrary filesystem paths; the daemon resolves the Markdown hash from import metadata.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Context graph id from the attachment ref. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          assertion_uri: { type: 'string', description: 'Completed imported assertion URI from the attachment ref.' },
          assertion_name: { type: 'string', description: 'Optional source assertion name to cross-check against assertion_uri.' },
          file_hash: { type: 'string', description: 'Optional source file hash to verify against deterministic metadata.' },
          sub_graph_name: { type: 'string', description: 'Optional sub-graph for the imported assertion.' },
          max_bytes: { type: 'integer', description: 'Optional positive integer byte cap; daemon maximum is 5 MiB.' },
        },
        required: ['context_graph_id', 'assertion_uri'],
      },
      execute: async (_toolCallId, args) => ctx.handleImportArtifactReadMarkdown(args),
    },
    {
      name: 'dkg_knowledge_asset_semantic_enrichment_write',
      description:
        'Append model-derived semantic triples into the completed imported assertion with daemon-stamped provenance. ' +
        'This does not promote, finalize, or publish.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Context graph id from the attachment ref. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          assertion_uri: { type: 'string', description: 'Source imported assertion URI from the attachment ref.' },
          assertion_name: { type: 'string', description: 'Optional source assertion name to cross-check against assertion_uri.' },
          file_hash: { type: 'string', description: 'Optional source file hash to verify against deterministic metadata.' },
          semantic_quads: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                subject: { type: 'string', description: 'Semantic subject URI.' },
                predicate: { type: 'string', description: 'Semantic predicate URI.' },
                object: { type: 'string', description: 'Semantic object URI, RDF literal, or plain text literal.' },
              },
              required: ['subject', 'predicate', 'object'],
            },
            description: 'Model-derived triples to append to the source imported assertion graph. Plain-text objects become RDF literals; provenance quads are added by the daemon.',
          },
          generation_method: { type: 'string', description: 'Extraction/generation method label.' },
          agent_identity: { type: 'string', description: 'Agent identity URI or label for provenance; only URIs are emitted as prov:wasAttributedTo resources.' },
          generated_at: { type: 'string', description: 'ISO timestamp for generation; defaults to daemon time.' },
          sub_graph_name: { type: 'string', description: 'Optional sub-graph for the source imported assertion.' },
        },
        required: ['context_graph_id', 'assertion_uri', 'semantic_quads'],
      },
      execute: async (_toolCallId, args) => ctx.handleSemanticEnrichmentWrite(args),
    },
    {
      name: 'dkg_knowledge_asset_history',
      description:
        'Fetch an assertion\'s lifecycle descriptor (author, extraction status, promotion state). ' +
        'Returns 404 if no record exists.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          name: { type: 'string', description: 'Assertion name.' },
          agent_address: { type: 'string', description: "Optional author — defaults to this node's agent address." },
          sub_graph_name: { type: 'string', description: 'Must match the one used at write time.' },
        },
        required: ['context_graph_id', 'name'],
      },
      execute: async (_toolCallId, args) => ctx.handleAssertionHistory(args),
    },

    // ── Sub-graph management ──────────────────────────────────────────────
    {
      name: 'dkg_sub_graph_create',
      description:
        'Create a named sub-graph inside a context graph (optional partition for scoped assertions).',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Parent context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          sub_graph_name: { type: 'string', description: 'Sub-graph name (lowercase letters, digits, hyphens; must not start with "_").' },
        },
        required: ['context_graph_id', 'sub_graph_name'],
      },
      execute: async (_toolCallId, args) => ctx.handleSubGraphCreate(args),
    },
    {
      name: 'dkg_sub_graph_list',
      description:
        'List sub-graphs in a context graph with best-effort entity / triple counts.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Parent context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
        },
        required: ['context_graph_id'],
      },
      execute: async (_toolCallId, args) => ctx.handleSubGraphList(args),
    },
  ];
}
