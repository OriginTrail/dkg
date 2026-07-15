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
import {
  escapeRdfLiteral,
  isRdfTerm as isSharedRdfTerm,
  normalizeRdfObject as normalizeSharedRdfObject,
} from '@origintrail-official/dkg-rdf-utils';
import { z } from 'zod';
import type { DkgClient } from '../client.js';
import { DkgHttpError } from '../client.js';
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

// #1116 share-outcome warnings. These three constants + the classifier below are
// duplicated byte-identical across the MCP, OpenClaw, and Hermes adapters. There
// is intentionally NO shared runtime module: MCP has no @origintrail-official/
// dkg-core dependency (deliberately dependency-light — it inlines shared rules),
// OpenClaw imports dkg-core but MCP must not, and adding a new package is out of
// scope. Drift is instead caught by a TEST: each adapter's suite asserts these
// values are byte-identical to the canonical fixture at
// `tests/fixtures/share-seal-warnings.json`. Update the fixture + all three
// adapters together; the parity tests flag any mismatch.

// Defensive warnings for mixed-version daemon replies. New clients only issue
// atomic, sealed full-KA shares, but an older daemon may still report one of the
// historical non-publish-ready outcomes.
export const SHARE_NOT_PUBLISH_READY_WARNING =
  'The atomic SWM share did not become publish-ready (sealed:false). Keep the ' +
  'Working Memory draft and retry the complete Knowledge Asset share; do not publish it.';

// Defensive mixed-version classification for a legacy partial-share outcome.
export const SHARE_SUBSET_NOT_PUBLISH_READY_WARNING =
  'A legacy partial-share outcome was reported. Root-scoped subsets are read-only ' +
  'and not publishable; model the intended data as its own Knowledge Asset and share it atomically.';

// A sealed atomic share can still report incomplete delivery; retry from WM.
export const SHARE_INCOMPLETE_PROMOTE_WARNING =
  'The complete sealed Knowledge Asset did not reach SWM and is not publish-ready; ' +
  'keep the Working Memory draft and retry the atomic share.';

/**
 * #1116: pick the not-publish-ready share warning from the share outcome. Returns
 * `undefined` when the share IS publish-ready (no warning). Branch precedence:
 *  1. sealed:true + publishReady:false → incomplete atomic delivery.
 *  2. sealed:false + legacy subset response → legacy read-only warning.
 *  3. sealed:false + atomic response → retry the complete share from WM.
 * Duplicated byte-identical on OpenClaw (TS) + Hermes (Python).
 */
export function classifyShareWarning(outcome: {
  sealed?: boolean;
  publishReady?: boolean;
  isSubset: boolean;
}): string | undefined {
  if (outcome.publishReady !== false) return undefined;
  if (outcome.sealed === true) return SHARE_INCOMPLETE_PROMOTE_WARNING;
  if (outcome.isSubset) return SHARE_SUBSET_NOT_PUBLISH_READY_WARNING;
  return SHARE_NOT_PUBLISH_READY_WARNING;
}

/**
 * The daemon's real assertion-name rule, replicated verbatim from
 * `@origintrail-official/dkg-core` `validateAssertionName`
 * (core/src/constants.ts:346-352). MCP does not depend on dkg-core, so the rule
 * is inlined here (and on Hermes) rather than imported. Any IRI-safe name up to
 * 256 chars — NOT a lowercase-hyphen slug. Keep in sync with the core source.
 */
function validateAssertionName(name: string): { valid: boolean; reason?: string } {
  if (!name || name.length === 0) return { valid: false, reason: 'Assertion name cannot be empty' };
  if (name.includes('/')) return { valid: false, reason: 'Assertion name cannot contain "/"' };
  if (/[<>"{}|^`\\\s]/.test(name)) return { valid: false, reason: 'Assertion name contains characters unsafe for IRIs' };
  if (name.length > 256) return { valid: false, reason: 'Assertion name exceeds 256 characters' };
  return { valid: true };
}

/**
 * Object-term normalizer for the `dkg_knowledge_asset_create` one-shot `quads`
 * path. The complete dependency-free normalization boundary (term classification,
 * literal escaping, and quote wrapping) lives in
 * `@origintrail-official/dkg-rdf-utils`. MCP remains independent of the full
 * dkg-core runtime. OpenClaw + Hermes
 * route the SAME create-tool `quads` shape through that core normalizer, so a bare
 * literal object must auto-quote identically across all three runtimes
 * (portable-agent parity). A value that is already an http(s)/urn/did URI, a blank
 * node (`_:`), or an already-quoted literal (`"…"`) is kept as-is; anything else is
 * treated as a plain literal and wrapped in quotes with the N-Triples ECHAR set
 * escaped.
 *
 * DRIFT GUARD: the public contract of these three functions is pinned by a GOLDEN
 * conformance fixture in `packages/mcp-dkg/test/rdf-object-normalization-conformance.test.ts`
 * whose expected strings are HAND-WRITTEN (not derived from this impl).
 *
 * Exported so the conformance test can pin them directly.
 */
export function isRdfTerm(value: string): boolean {
  return isSharedRdfTerm(value);
}

export function escapeRdfLiteralBody(value: string): string {
  return escapeRdfLiteral(value);
}

export function normalizeRdfObject(value: string): string {
  return normalizeSharedRdfObject(value);
}

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
  // [D3] Step 1 of the canonical flow, now optionally a one-shot. Three modes,
  // selected by the params (see the tool description):
  //   - no `quads`               → open an empty WM draft (today's behavior)
  //   - `quads`                  → create→write→seal, STOPS at a sealed WM draft
  //   - `quads` + alsoShareSwm   → create→write→seal→share, STOPS at SWM
  // It deliberately does NOT expose `alsoPublishVm` — VM mint stays the explicit
  // `dkg_knowledge_asset_publish` step (no direct-publish bypass). `alsoShareSwm`
  // defaults to FALSE and is passed EXPLICITLY to the client helper so its
  // internal seal-true default (`client.ts` createKnowledgeAsset) cannot leak and
  // silently auto-share.
  server.registerTool(
    'dkg_knowledge_asset_create',
    {
      title: 'Create Knowledge Asset',
      description:
        'Step 1 of the canonical write flow (create → write → finalize → share → publish): ' +
        'create a Working Memory draft for a knowledge asset. Idempotent — ' +
        'duplicate names land as `alreadyExists: true` rather than throwing. Accepts any ' +
        'valid assertion name: an IRI-safe name up to 256 chars (no "/", no whitespace, no ' +
        '<>"{}|^`\\ characters) — NOT restricted to a lowercase-hyphen slug.\n\n' +
        'ONE-SHOT (optional): pass non-empty `quads` to write + seal in this one call — it ' +
        'STOPS at a sealed Working Memory draft (private; does NOT auto-share). Add ' +
        '`alsoShareSwm: true` to also share to Shared Working Memory in the same call, landing a ' +
        'publish-ready knowledge asset in SWM — the recommended create→write→seal→share one-shot. ' +
        'This NEVER mints on-chain: to publish to Verifiable Memory you then call ' +
        '`dkg_knowledge_asset_publish` (the explicit VM step). For the stepwise flow instead, omit ' +
        '`quads` and use `dkg_knowledge_asset_write` / `dkg_knowledge_asset_finalize` / ' +
        '`dkg_knowledge_asset_share` separately.',
      inputSchema: {
        name: z
          .string()
          .refine((n) => validateAssertionName(n).valid, (n) => ({
            message: validateAssertionName(n).reason ?? 'Invalid assertion name',
          }))
          .describe('Assertion name. Any IRI-safe name up to 256 chars (e.g. "session-2026-04-30", "My_Asset.v2") — no "/", whitespace, or <>"{}|^`\\ characters.'),
        // [D3] optional one-shot quads. Same triple shape as dkg_knowledge_asset_write:
        // subjects/predicates are URIs (angle brackets tolerated + stripped); objects are
        // AUTO-TYPED (URI vs literal) identically to dkg_knowledge_asset_write and to the
        // OpenClaw/Hermes create one-shot. No per-quad `graph` field — the daemon pins
        // quads to the per-KA WM graph.
        quads: z
          .array(
            z.object({
              subject: z.string().describe(
                'Subject URI. Plain string like "urn:my-thing". Angle brackets are tolerated and ' +
                'stripped (`<urn:foo>` → `urn:foo`). MUST NOT contain spaces.',
              ),
              predicate: z.string().describe(
                'Predicate URI. Same rules as subject (e.g. "rdfs:label", "rdf:type", or any custom URI).',
              ),
              object: z.string().describe(
                'Object value, AUTO-TYPED: a value starting with http://, https://, urn:, or did: ' +
                '(angle brackets tolerated + stripped) is a URI; an already-quoted "..." or blank ' +
                'node _:b is kept as-is; anything else is treated as a plain literal and wrapped in ' +
                'quotes for you (e.g. `Hello world` → `"Hello world"`). Same normalization as ' +
                'dkg_knowledge_asset_write and the OpenClaw/Hermes one-shot.',
              ),
            }),
          )
          .min(1)
          .optional()
          .describe(
            'Optional one-shot triples. When present, the create call also writes these quads and ' +
            'SEALS the draft (stops at a sealed WM draft). Omit for an empty draft you fill with ' +
            'dkg_knowledge_asset_write.',
          ),
        // [D3] alsoShareSwm — only meaningful with `quads`. Defaults to FALSE; the handler passes
        // it EXPLICITLY so the client helper's internal seal-true default cannot leak.
        alsoShareSwm: z
          .boolean()
          .optional()
          .describe(
            'When true (and `quads` are supplied), also SHARE the sealed asset to Shared Working ' +
            'Memory in the same call, landing a publish-ready knowledge asset in SWM (the full ' +
            'create→write→seal→share one-shot). Default false: stop at a sealed, private WM draft — ' +
            'sharing (the private→networked step) stays explicit. Ignored when there are no `quads`.',
          ),
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
    async ({ name, quads, alsoShareSwm, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();

      // [D3] No quads → the unchanged bare create (empty WM draft). Idempotent
      // get-or-create on `POST /api/knowledge-assets` reporting `alreadyExists`.
      if (!quads || quads.length === 0) {
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
      }

      // [D3] Quads present → the one-shot via `client.createKnowledgeAsset`
      // (create→write→seal, +share when alsoShareSwm). Strip angle brackets from
      // subject/predicate AND object (the engine wants bare URIs), then NORMALIZE
      // the object the SAME way OpenClaw + Hermes do (via dkg-core's
      // normalizeDkgPublisherObject — inlined here as `normalizeRdfObject`): a bare
      // literal auto-quotes, a URI / blank / already-quoted term passes through. The
      // strip runs BEFORE normalize so `<http://x>` → `http://x` stays a URI rather
      // than being treated as a literal. This keeps a `create({quads})` call's object
      // handling identical across all three adapters (portable-agent parity). Wire
      // shape carries the empty `graph` the client type requires — the daemon pins
      // quads to the per-KA WM graph regardless. We pass `alsoShareSwm` EXPLICITLY
      // (default false) so the helper's internal seal-true default cannot leak and
      // silently auto-share. We do NOT pass `alsoPublishVm` — VM mint is always the
      // separate dkg_knowledge_asset_publish step.
      const strip = (t: string): string =>
        t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t;
      const kaQuads = quads.map((q) => ({
        subject: strip(q.subject),
        predicate: strip(q.predicate),
        object: normalizeRdfObject(strip(q.object)),
        graph: '',
      }));
      const share = alsoShareSwm === true;
      try {
        const result = await client.createKnowledgeAsset({
          contextGraphId: pid,
          name,
          subGraphName,
          quads: kaQuads,
          alsoShareSwm: share,
        });
        const r = result as Record<string, unknown>;
        const sealed = r.sealed;
        const publishReady = r.publishReady;
        const status = r.status;
        // The daemon returns 207 with an `errors` array when create+seal succeeds but
        // the opt-in SWM share fails; DkgClient treats 207 as success, so judge from the
        // daemon OUTCOME here, not from the requested `alsoShareSwm` flag.
        const errors = Array.isArray(r.errors)
          ? (r.errors as Array<{ phase?: string; error?: string }>)
          : [];
        const jsonBlock =
          '```json\n' +
          JSON.stringify(
            {
              status: status ?? null,
              sealed: sealed ?? null,
              publishReady: publishReady ?? null,
              ...(errors.length ? { errors } : {}),
            },
            null,
            2,
          ) +
          '\n```';

        const shareError = errors.find((e) => e?.phase === 'swm-share');
        if (share && (shareError || publishReady === false)) {
          // Create + seal landed, but the requested SWM share did NOT — the asset is a
          // sealed private WM draft, NOT publish-ready. Surface as an error so the agent
          // doesn't publish an asset that never reached Shared Working Memory.
          return errResult(
            `Created and sealed knowledge asset '${name}' in '${pid}' (${kaQuads.length} quad(s)), ` +
            `but the opt-in Shared Working Memory share FAILED${shareError?.error ? `: ${shareError.error}` : ''}. ` +
            `The asset did NOT reach Shared Working Memory and is NOT publish-ready — do not publish yet; ` +
            `retry the share with dkg_knowledge_asset_share, then publish.\n\n${jsonBlock}`,
          );
        }

        const landed = share
          ? 'sealed and shared to Shared Working Memory (publish-ready)'
          : 'written and sealed in a private Working Memory draft (not yet shared)';
        const next = share
          ? 'Publish it on-chain with dkg_knowledge_asset_publish.'
          : 'Share it with dkg_knowledge_asset_share, then publish with dkg_knowledge_asset_publish.';
        return ok(
          `Created knowledge asset '${name}' in '${pid}' — ${kaQuads.length} quad(s) ${landed}.\n` +
          `${next}\n\n${jsonBlock}`,
        );
      } catch (e) {
        return errResult(`Failed to create knowledge asset: ${formatError(e)}`);
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
        'AuthorAttestation. Finalize always seals the WHOLE draft. The share ' +
        'step also seals automatically, so call this explicitly when custom ' +
        'authorship options are needed or after editing a previously-sealed draft. Sealing works even ' +
        'if the context graph is NOT yet registered on-chain (registration ' +
        'happens at publish). Existing root-scoped SWM assets are read-only. (External-signer / ' +
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
        layer: z.literal('wm').optional().describe('Deprecated compatibility alias; only Working Memory finalization is supported.'),
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
        'Step 4 of the canonical write flow: atomically seal and share the complete ' +
        'knowledge asset from private Working Memory to Shared Working Memory. ' +
        'The exact submitted triple set is the asset boundary; root-entity subset ' +
        'selection and unsealed shares are not supported. A successful share is publish-ready — ' +
        'follow it with dkg_knowledge_asset_publish to mint the asset on-chain ' +
        '(Verifiable Memory). If sealing or the complete transfer fails, the ' +
        'operation fails CLOSED (Working Memory preserved) and returns ' +
        'a recovery hint. For custom finalize/attestation options — ' +
        'authorAgentAddress / schemeVersion — call dkg_knowledge_asset_finalize ' +
        'EXPLICITLY first (the default seal cannot carry them).',
      inputSchema: {
        name: z.string().describe('Existing knowledge asset name'),
        entities: z.literal('all').optional().describe('Deprecated compatibility sentinel; the complete Knowledge Asset is always shared.'),
        skipSeal: z.literal(false).optional().describe('Deprecated compatibility sentinel; Knowledge Assets are always sealed before sharing.'),
        projectId: z.string().optional().describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`),
        subGraphName: z.string().optional(),
      },
    },
    async ({ name, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        const result = await client.knowledgeAssetShare({
          contextGraphId: pid,
          name,
          subGraphName,
        });
        const warning = classifyShareWarning({
          sealed: result.sealed,
          publishReady: result.publishReady,
          isSubset: false,
        });
        if (warning) {
          return ok(
            `Atomic share for knowledge asset '${name}' (project '${pid}') did not complete. ` +
            `${warning}`,
          );
        }
        return ok(
          `Shared complete knowledge asset '${name}' (project '${pid}') to SWM ` +
          `(sealed:true, publish-ready).`,
        );
      } catch (e) {
        // #1116: a default (sealing) share that cannot seal fails CLOSED — the
        // daemon returns 409 UNSEALED_SHARE_BLOCKED with a recovery hint and WM
        // preserved. Surface the recovery text verbatim so the agent can act.
        if (e instanceof DkgHttpError && e.status === 409) {
          const body = e.body as { code?: string; recovery?: string } | undefined;
          if (body?.code === 'UNSEALED_SHARE_BLOCKED' && body.recovery) {
            return errResult(body.recovery);
          }
        }
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
        '(Universal Asset Locator, `did:dkg:<chainId>/<knowledgeAssetsContractAddress>/<number>` — ' +
        'the middle segment is the KnowledgeAssets (KAV10) contract address, NOT the author; the ' +
        'separate `authorAddress` response field is the (different) seal author) plus ' +
        '`kaId`, `txHash`, `status`, and `kas`. The seal already selects the ' +
        'author and the whole asset — do not pass author or selection overrides. ' +
        'Multi-root-safe. This is THE canonical publish for a single named asset. ' +
        'Fails 409 if the asset is not yet finalized + shared ' +
        '(run dkg_knowledge_asset_finalize / dkg_knowledge_asset_share first). ' +
        'vm/publish AUTO-registers an unregistered context graph on-chain at ' +
        'gas/TRAC cost regardless of `registerIfNeeded` (no explicit register ' +
        'step is needed). `registerIfNeeded: true` only lets you choose the ' +
        'registration\'s accessPolicy first.',
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
        // CONTRACT §G: vm/publish AUTO-registers an unregistered CG transparently
        // (#1116) at gas/TRAC cost regardless of registerIfNeeded. registerIfNeeded
        // only runs an EXPLICIT register first so you can choose the registration's
        // accessPolicy (the implicit auto-register defaults the policy).
        registerIfNeeded: z
          .boolean()
          .optional()
          .describe(
            'Run an EXPLICIT on-chain registration before publishing, which lets you set `accessPolicy` on ' +
            'that registration. NOTE: this does NOT gate whether registration happens — vm/publish ' +
            'AUTO-registers an unregistered context graph at gas/TRAC cost regardless of this flag. Set it ' +
            'only to choose the registration\'s accessPolicy (the implicit auto-register on publish otherwise ' +
            'defaults the policy). CAVEAT: this explicit register route registers with the daemon\'s DEFAULT ' +
            'publishPolicy (derived from accessPolicy) and does NOT preserve a context graph\'s stored custom ' +
            'publishPolicy / contribution governance. For a CG created with a non-default publishPolicy/PCA, ' +
            'register it explicitly with the desired policy first rather than relying on registerIfNeeded. ' +
            '(Read access is unaffected; daemon-side rehydration tracked in OriginTrail/dkg#1085.)',
          ),
        accessPolicy: z
          .union([z.literal(0), z.literal(1)])
          .optional()
          .describe('0 = open, 1 = private. Requires `registerIfNeeded: true` — it only applies when registering the CG, and is rejected otherwise. Sets only the access policy; it does NOT preserve a stored custom publishPolicy (see registerIfNeeded; OriginTrail/dkg#1085).'),
        // CONTRACT §D: clear_shared_memory_after is NOT exposed on the per-asset
        // publish tool — on vm/publish it is graph-wide destructive (wipes every
        // other agent's unpublished SWM under the CG/sub-graph). The this-asset
        // cleanup runs unconditionally regardless; there is no agent-facing CG-wide
        // SWM clear (the legacy bridge tools that carried it were removed in #1087).
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
      // FIX S: accessPolicy only applies when registering the CG — reject it
      // (rather than silently drop the privacy setting) when registerIfNeeded != true.
      if (accessPolicy !== undefined && registerIfNeeded !== true) {
        return errResult('"accessPolicy" requires "registerIfNeeded": true — it only applies when registering the context graph.');
      }
      // CONTRACT §G: vm/publish AUTO-registers an unregistered CG transparently
      // (#1116) regardless of registerIfNeeded. When registerIfNeeded is true we
      // run an EXPLICIT register first (the client short-circuits an already-
      // registered CG via alreadyRegistered) so the caller can choose the
      // registration's accessPolicy. A hard registration failure is a tool error:
      // do NOT publish.
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
        'un-shared working copy). Query it BEFORE sharing: an atomic share empties ' +
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
