/**
 * Publish tools — Shared Working Memory writes / on-chain finalization.
 *
 * Wave-2 P1 adds (audit §7 items 2 + 3). Two distinct surfaces, both
 * documented in SKILL.md §4a:
 *
 *   - `dkg_publish` — "I have fresh quads, publish them now" one-shot.
 *     Two-call helper: writes the quads to SWM, then publishes the
 *     entire SWM to Verifiable Memory and clears SWM.
 *
 *   - `dkg_shared_memory_publish` — canonical Step 5 finalizer for the
 *     stepwise flow (`assertion_create + write + promote` then this).
 *     UNGATED per matrix v0.6 / user lock 2026-04-30 — no
 *     `agent.canPublishToVm` flag; matches the OpenClaw adapter shape
 *     exactly.
 *
 * Both call the same daemon endpoints
 * (`POST /api/shared-memory/{write,publish}`); the difference is in
 * the input shape — `dkg_publish` accepts fresh quads, while
 * `dkg_shared_memory_publish` consumes existing SWM (filterable by
 * `rootEntities`) and clears as a side-effect.
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

/**
 * F3+F13: resolve the daemon's configured chainId for the success
 * summary. The daemon's `/api/shared-memory/publish` response does
 * not include `chainId` in the JSON body (it's threaded through the
 * tracker only — see `packages/cli/src/daemon/routes/memory.ts:483-488`),
 * so we read it from `/api/wallets/balances` which already exposes it
 * as a first-class field. Returns `null` when the wallet-balances
 * probe fails — non-fatal, the publish itself already succeeded.
 *
 * Why expose chainId at all: lets the caller verify which chain the
 * publish landed on without a separate roundtrip. F3 was originally
 * "warn loudly before publish to mainnet"; the user explicitly opted
 * for echo-only (no warning prose) so callers self-verify post-hoc
 * instead.
 */
async function resolveChainId(client: DkgClient): Promise<string | null> {
  try {
    const balances = await client.getWalletBalances();
    return balances.chainId ?? null;
  } catch {
    return null;
  }
}

/**
 * URI auto-detection for object terms — matches the adapter's `isUri`
 * at `DkgNodePlugin.ts:3468-3470`. Anything starting with http://,
 * https://, urn:, or did: is treated as a URI; anything else gets
 * wrapped as a literal at the wire boundary.
 */
function isUri(value: string): boolean {
  return /^(?:https?:\/\/|urn:|did:)/i.test(value);
}

/**
 * Escape literal-text inside an RDF object term. Mirrors the adapter's
 * literal-handling in `handlePublish` so SWM writes from either surface
 * produce identical triples.
 */
function escapeRdfLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

const QuadSchema = z.object({
  subject: z.string().min(1).describe('Subject URI'),
  predicate: z.string().min(1).describe('Predicate URI'),
  object: z
    .string()
    .describe(
      'Object — URI or literal. Auto-detected: values starting with http://, https://, urn:, or did: pass as URIs; anything else becomes a literal.',
    ),
});

export function registerPublishTools(
  server: McpServer,
  client: DkgClient,
  _config: DkgConfig,
): void {
  // ── dkg_publish ─────────────────────────────────────────────────
  // Description quotes SKILL.md §4a line 182's `dkg_publish` vs
  // `dkg_shared_memory_publish` disambiguation verbatim per audit
  // v1.1 lock — agents need to pick the right tool without re-
  // reading SKILL.md.
  server.registerTool(
    'dkg_publish',
    {
      title: 'Publish Fresh Quads',
      description:
        '"I have fresh quads, write+publish now." Two-call helper: ' +
        'creates a fresh auto-named assertion from the supplied quads ' +
        '(seal + share), then publishes THAT one assertion to Verifiable ' +
        'Memory (on-chain). NOTE: this is two HTTP calls (create, then ' +
        'publish), not a single transactional operation — either phase can ' +
        'partially fail (a share-phase failure aborts before publish; a ' +
        'context-graph-binding failure still mints the asset on-chain). For ' +
        'the canonical step-wise flow ' +
        '(create → write → finalize → share → publish) use ' +
        '`dkg_knowledge_asset_create / write / finalize / share` followed ' +
        'by `dkg_knowledge_asset_publish` — that path keeps WM as a draft ' +
        'staging area before SWM. Use `dkg_publish` only when you have ' +
        'fresh quads to anchor immediately. Publishing requires the context ' +
        'graph to be registered on-chain — set `registerIfNeeded: true` to ' +
        'register it first (idempotent) before publishing.',
      inputSchema: {
        contextGraphId: z.string().min(1).describe(`Target context graph id. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}`),
        quads: z
          .array(QuadSchema)
          .min(1)
          .describe(
            'Non-empty array of quads to publish. Object values are auto-typed (URI vs literal).',
          ),
        registerIfNeeded: z
          .boolean()
          .optional()
          .describe(
            'When true, register the CG on-chain before publishing if needed. May spend gas/TRAC; opt-in only. ' +
            'CAVEAT: this uses the explicit register route, which registers with the daemon\'s DEFAULT ' +
            'publishPolicy (derived from accessPolicy) and does NOT preserve a context graph\'s stored custom ' +
            'publishPolicy / contribution governance. For a CG created with a non-default publishPolicy/PCA, ' +
            'register it explicitly with the desired policy first rather than relying on registerIfNeeded. ' +
            '(Read access is unaffected; daemon-side rehydration tracked in OriginTrail/dkg#1085.)',
          ),
        accessPolicy: z
          .union([z.literal(0), z.literal(1)])
          .optional()
          .describe(
            '0 = open, 1 = private. Requires `registerIfNeeded: true` — it only applies when registering the CG, and is rejected otherwise. Sets only the access policy; it does NOT preserve a stored custom publishPolicy (see registerIfNeeded; OriginTrail/dkg#1085).',
          ),
      },
    },
    async ({ contextGraphId, quads, registerIfNeeded, accessPolicy }): Promise<ToolResult> => {
      const cgId = contextGraphId.trim();
      if (!cgId) return errResult('"contextGraphId" is required.');
      if (!quads.length) {
        return errResult('"quads" must be a non-empty array.');
      }
      // FIX S: accessPolicy only applies when registering the CG — reject it
      // (rather than silently drop the privacy setting) when registerIfNeeded != true.
      if (accessPolicy !== undefined && registerIfNeeded !== true) {
        return errResult('"accessPolicy" requires "registerIfNeeded": true — it only applies when registering the context graph.');
      }
      // Auto-type the object: URI vs literal. Mirrors the adapter's
      // handlePublish at `DkgNodePlugin.ts:2721-2729` byte-for-byte so
      // a memory written via either surface lands as identical triples.
      // Wire shape is {subject, predicate, object} only — no per-quad `graph`
      // (CONTRACT §0 invariant 2; the daemon pins quads to the per-KA WM graph).
      const wireQuads = quads.map((q) => {
        const objVal = String(q.object ?? '');
        return {
          subject: String(q.subject ?? ''),
          predicate: String(q.predicate ?? ''),
          object: isUri(objVal) ? objVal : `"${escapeRdfLiteral(objVal)}"`,
        };
      });

      // CONTRACT §G: publishing requires the CG to be registered on-chain and the
      // daemon does NOT auto-register. When registerIfNeeded is true, register
      // first (the client short-circuits an already-registered CG via its typed
      // alreadyRegistered flag — no double-mint), mirroring dkg_shared_memory_publish.
      // A hard registration failure is a tool error: do NOT publish.
      let registered = false;
      if (registerIfNeeded === true) {
        try {
          const reg = await client.registerContextGraph({ id: cgId, accessPolicy });
          registered = !reg.alreadyRegistered;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errResult(`Failed to register context graph: ${message}`);
        }
      }

      try {
        const result = await client.publishQuads({
          contextGraphId: cgId,
          quads: wireQuads,
        });
        const kaId = (result as Record<string, unknown>).kaId as string | undefined;
        const kas = (result as Record<string, unknown>).kas as
          | Array<{ tokenId: string; rootEntity: string }>
          | undefined;
        const txHash = (result as Record<string, unknown>).txHash as string | undefined;
        // F3+F13: echo the configured chainId so callers can verify
        // which chain the publish landed on without a separate
        // wallet-balances roundtrip. Fetched after the publish
        // succeeds; if the wallet-balances probe itself fails the
        // publish stands and we just omit the chain line.
        const chainId = await resolveChainId(client);
        // FIX E — the dkg_publish path publishes via POST /api/shared-memory/publish
        // {assertionName}, which (like vm/publish) returns HTTP 207 with
        // `contextGraphError` set when the KA minted on-chain but the context-graph
        // binding FAILED (memory.ts:1772). `this.request` treats 207 as success, so
        // without this the partial reads as clean success. The UAL/kaId are valid and
        // the asset IS published on-chain — surface a PARTIAL warning. The agent must
        // NOT re-run dkg_publish: each call mints a FRESH assertion, so a retry would
        // DUPLICATE the published asset and still not re-bind the CG. The CG-binding
        // retry is an operator/daemon concern.
        const contextGraphError = (result as Record<string, unknown>).contextGraphError;
        const ual = (result as Record<string, unknown>).ual as string | undefined;
        const summary = [
          typeof contextGraphError === 'string' && contextGraphError.length > 0
            ? `PARTIAL publish to '${cgId}': the asset IS published on-chain (KC/UAL below are valid and ` +
              `final) — only the context-graph binding FAILED (${contextGraphError}). Do NOT re-run ` +
              `dkg_publish: it would mint a DUPLICATE asset and still not re-bind the context graph. Surface ` +
              `this to the operator to re-attempt the context-graph binding.`
            : `Published ${wireQuads.length} quad(s) to '${cgId}'.`,
          registered ? `Registered context graph '${cgId}' on-chain.` : null,
          kaId ? `KC: ${kaId}` : null,
          ual ? `UAL: ${ual}` : null,
          kas?.length ? `KAs: ${kas.length}` : null,
          txHash ? `Tx: ${txHash}` : null,
          chainId ? `Chain: ${chainId}` : null,
        ]
          .filter((line): line is string => line !== null)
          .join('\n');
        return ok(summary);
      } catch (e) {
        return errResult(`Publish failed: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_shared_memory_publish ───────────────────────────────────
  // Description quotes SKILL.md §4a line 182's `dkg_publish` vs
  // `dkg_shared_memory_publish` disambiguation verbatim per audit
  // v1.1 lock.
  server.registerTool(
    'dkg_shared_memory_publish',
    {
      title: 'Publish Shared Working Memory',
      description:
        'SWM-bridge / CG-wide publish (legacy, retained). Publishes all ' +
        'Shared Working Memory in a context graph to Verifiable Memory ' +
        '(on-chain) and clears SWM. To publish a SINGLE named knowledge ' +
        'asset, prefer `dkg_knowledge_asset_publish` (multi-root-safe); this ' +
        'bulk route is single-root-per-call and returns 409 ' +
        'MULTI_ROOT_PUBLISH_NOT_ATOMIC when more than one root entity is in ' +
        'SWM. Use after `dkg_knowledge_asset_share`. Pass `rootEntities` to ' +
        'publish only specific roots (subset publishes default to NOT ' +
        'clearing SWM, so other unpublished roots are not dropped). NOTE: this ' +
        'CG-wide publish AUTO-registers an unregistered context graph on-chain at ' +
        'gas/TRAC cost regardless of `registerIfNeeded` — omitting the flag is ' +
        'NOT gas-free. `registerIfNeeded` only lets you set the registration\'s ' +
        '`accessPolicy`.',
      inputSchema: {
        contextGraphId: z.string().min(1).describe(`Target context graph id. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}`),
        rootEntities: z
          .array(z.string())
          .optional()
          .describe(
            'Optional filter — publish only these root entity URIs. Omit to publish all SWM in the CG.',
          ),
        subGraphName: z
          .string()
          .optional()
          .describe(
            'Optional sub-graph scope. Must match the sub-graph used during create/write/promote.',
          ),
        registerIfNeeded: z
          .boolean()
          .optional()
          .describe(
            'Run an EXPLICIT on-chain registration before publishing, which lets you set `accessPolicy` on that registration. NOTE: this does NOT gate whether registration happens — a CG-wide publish AUTO-registers an unregistered context graph at gas/TRAC cost regardless of this flag. Set it only to choose the registration\'s accessPolicy (the implicit auto-register on publish otherwise defaults the policy).',
          ),
        accessPolicy: z
          .union([z.literal(0), z.literal(1)])
          .optional()
          .describe(
            '0 = open, 1 = private — for the EXPLICIT registration. Requires `registerIfNeeded: true` — it only applies to that explicit registration and is rejected otherwise (the implicit auto-register on publish defaults the policy).',
          ),
      },
    },
    async ({
      contextGraphId,
      rootEntities,
      subGraphName,
      registerIfNeeded,
      accessPolicy,
    }): Promise<ToolResult> => {
      const cgId = contextGraphId.trim();
      if (!cgId) return errResult('"contextGraphId" is required.');
      // FIX S: accessPolicy only applies when registering the CG — reject it
      // (rather than silently drop the privacy setting) when registerIfNeeded != true.
      if (accessPolicy !== undefined && registerIfNeeded !== true) {
        return errResult('"accessPolicy" requires "registerIfNeeded": true — it only applies when registering the context graph.');
      }
      // Mirror handleAssertionPromote's `entities` validation: omit →
      // daemon-side default (selection="all"); non-empty array of
      // strings only — no other shapes silently 400 at the daemon.
      let roots: string[] | undefined;
      if (rootEntities !== undefined) {
        if (!Array.isArray(rootEntities) || rootEntities.length === 0) {
          return errResult(
            '"rootEntities" must be omitted or a non-empty array of root entity URIs.',
          );
        }
        roots = rootEntities;
      }

      // Optional on-chain registration before publish. Tolerates the
      // already-registered case (just publishes); other failures
      // propagate as tool errors. F12: branch on the typed
      // `alreadyRegistered: true` flag the client now surfaces from
      // the daemon's 409 — replaces the locale-fragile
      // `message.includes('already registered')` substring match.
      let registration: Record<string, unknown> | undefined;
      if (registerIfNeeded === true) {
        try {
          const result = await client.registerContextGraph({
            id: cgId,
            accessPolicy,
          });
          // Capture the registration record (and on-chain id when
          // newly-registered) for the success summary; if it was
          // already registered, leave `registration` undefined so
          // the summary doesn't claim we just registered something.
          if (!result.alreadyRegistered) {
            registration = result;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errResult(`Failed to register context graph: ${message}`);
        }
      }

      try {
        const result = await client.publishSharedMemory({
          contextGraphId: cgId,
          rootEntities: roots,
          subGraphName,
        });
        const kaId = result.kaId as string | undefined;
        const kas = result.kas as Array<{ tokenId: string; rootEntity: string }> | undefined;
        const txHash = result.txHash as string | undefined;
        // F3+F13: see `resolveChainId` JSDoc — chainId is echoed for
        // post-hoc caller verification. accessPolicy is also echoed
        // when the registration step ran (registerIfNeeded path) so
        // the caller can verify the daemon committed the value they
        // requested. Both are read-only echoes; no warning prose.
        const chainId = await resolveChainId(client);
        const summary = [
          `Published ${cgId}'s SWM to Verifiable Memory.`,
          roots ? `Roots: ${roots.length}` : 'Selection: all',
          kaId ? `KC: ${kaId}` : null,
          kas?.length ? `KAs: ${kas.length}` : null,
          txHash ? `Tx: ${txHash}` : null,
          chainId ? `Chain: ${chainId}` : null,
          registration ? `Registered on-chain: ${registration.onChainId ?? '(unknown)'}${accessPolicy != null ? ` (accessPolicy=${accessPolicy})` : ''}` : null,
        ]
          .filter((line): line is string => line !== null)
          .join('\n');
        return ok(summary);
      } catch (e) {
        return errResult(`Publish failed: ${formatError(e)}`);
      }
    },
  );
}
