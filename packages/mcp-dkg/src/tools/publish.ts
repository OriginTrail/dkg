/**
 * Publish tools — Shared Working Memory writes / on-chain finalization.
 *
 * Wave-2 P1 adds (audit §7 items 2 + 3). Two distinct surfaces, both
 * documented in SKILL.md §4a:
 *
 *   - `dkg_publish` — "I have fresh quads, publish them now" one-shot.
 *     Two-call helper: writes the quads to SWM, then publishes the
 *     entire SWM to Verified Memory and clears SWM.
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
  graph: z.string().optional().describe('Optional named graph URI'),
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
        'writes the supplied quads to Shared Working Memory, then ' +
        'publishes the entire SWM in the CG to Verified Memory ' +
        '(on-chain) and clears SWM. For the canonical step-wise flow ' +
        '(write → promote → publish) use `dkg_assertion_create / write ' +
        '/ promote` followed by `dkg_shared_memory_publish` — that ' +
        'path keeps WM as a draft staging area before SWM. Use ' +
        '`dkg_publish` only when you have fresh quads to anchor ' +
        'immediately.',
      inputSchema: {
        contextGraphId: z.string().min(1).describe('Target context graph id'),
        quads: z
          .array(QuadSchema)
          .min(1)
          .describe(
            'Non-empty array of quads to publish. Object values are auto-typed (URI vs literal).',
          ),
      },
    },
    async ({ contextGraphId, quads }): Promise<ToolResult> => {
      const cgId = contextGraphId.trim();
      if (!cgId) return errResult('"contextGraphId" is required.');
      if (!quads.length) {
        return errResult('"quads" must be a non-empty array.');
      }
      // Auto-type the object: URI vs literal. Mirrors the adapter's
      // handlePublish at `DkgNodePlugin.ts:2721-2729` byte-for-byte so
      // a memory written via either surface lands as identical triples.
      const wireQuads = quads.map((q) => {
        const objVal = String(q.object ?? '');
        return {
          subject: String(q.subject ?? ''),
          predicate: String(q.predicate ?? ''),
          object: isUri(objVal) ? objVal : `"${escapeRdfLiteral(objVal)}"`,
          graph: q.graph ? String(q.graph) : '',
        };
      });
      try {
        const result = await client.publishQuads({
          contextGraphId: cgId,
          quads: wireQuads,
        });
        const kcId = (result as Record<string, unknown>).kcId as string | undefined;
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
        const summary = [
          `Published ${wireQuads.length} quad(s) to '${cgId}'.`,
          kcId ? `KC: ${kcId}` : null,
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
        'Canonical step-4 finalizer for "publish existing SWM" (one HTTP ' +
        'call). Publishes all Shared Working Memory in a context graph to ' +
        'Verified Memory (on-chain) and clears SWM. Use after ' +
        '`dkg_assertion_promote` to finalize promoted data. Pass ' +
        '`rootEntities` to publish only specific roots (subset publishes ' +
        'default to NOT clearing SWM, so other unpublished roots are not ' +
        'dropped). Set `registerIfNeeded: true` to upgrade a local-only CG ' +
        'to on-chain registration before publishing — note this MAY spend ' +
        'gas/TRAC; opt-in only.',
      inputSchema: {
        contextGraphId: z.string().min(1).describe('Target context graph id'),
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
            'When true, register the CG on-chain before publishing if needed. May spend gas/TRAC; opt-in only.',
          ),
        accessPolicy: z
          .union([z.literal(0), z.literal(1)])
          .optional()
          .describe(
            'Used only when `registerIfNeeded: true`. 0 = open, 1 = private.',
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
        const kcId = result.kcId as string | undefined;
        const kas = result.kas as Array<{ tokenId: string; rootEntity: string }> | undefined;
        const txHash = result.txHash as string | undefined;
        // F3+F13: see `resolveChainId` JSDoc — chainId is echoed for
        // post-hoc caller verification. accessPolicy is also echoed
        // when the registration step ran (registerIfNeeded path) so
        // the caller can verify the daemon committed the value they
        // requested. Both are read-only echoes; no warning prose.
        const chainId = await resolveChainId(client);
        const summary = [
          `Published ${cgId}'s SWM to Verified Memory.`,
          roots ? `Roots: ${roots.length}` : 'Selection: all',
          kcId ? `KC: ${kcId}` : null,
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
