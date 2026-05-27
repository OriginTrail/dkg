/**
 * Context-graph and sub-graph setup tools.
 *
 * Wave-2 P0 + P2 adds (audit §7 items 1, 8, 9). These three tools cover
 * the SKILL.md Quickstart Step 1 ("create a project") and Step 3 ("join
 * a peer-shared CG") plus the sub-graph staging primitive that the
 * other write tools previously consumed indirectly via
 * `client.ensureSubGraph`.
 *
 * Naming: `dkg_context_graph_create` matches both SKILL.md §3 Step 1
 * and the OpenClaw adapter (`DkgNodePlugin.ts:1924`). Description
 * includes the "(also called 'projects' in the DKG node UI)" UX note
 * per the team-lead direction on tool-surface UI/canonical
 * reconciliation, mirroring the same pattern locked on
 * `dkg_list_context_graphs` in the rename pass.
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
 * Slugify a human-readable CG name into a URL-safe id (e.g. "My
 * Research Context Graph" → "my-research-context-graph"). Matches the
 * adapter's `slugify` at `DkgNodePlugin.ts:3460-3464`.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const VALID_CG_ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function registerSetupTools(
  server: McpServer,
  client: DkgClient,
  _config: DkgConfig,
): void {
  // ── dkg_context_graph_create ────────────────────────────────────
  // Description string opens with the audit v1.1 verbatim-locked
  // reconciliation note (SKILL.md §6 line 297 user-vs-internal
  // terminology). The follow-up sentence about slug derivation is
  // mcp-dkg-specific UX ergonomics.
  //
  // Policy dials (`sharing` / `contribution`) follow SPEC_CG_MEMORY_MODEL
  // and map onto the daemon's `accessPolicy` / `publishPolicy` wire
  // fields. Defaults are safe (`invite-only` + `curators-only`) so an
  // agent that "just creates a CG" starts in the most-locked-down
  // state; opening it up later is explicit. Sharing controls who can
  // read (off-chain peers) and Contribution controls who can publish
  // to Verified Memory.
  server.registerTool(
    'dkg_context_graph_create',
    {
      title: 'Create Context Graph',
      description:
        "Create a context graph (called 'projects' in the DKG node UI). " +
        'Idempotent — re-creating an existing CG with the same id is a ' +
        "no-op and surfaces `already exists` in the response. Returns the " +
        "CG's id, URI, and whether it was newly created or already existed. " +
        'The `id` slug is auto-derived from `name` when omitted (e.g. ' +
        '"My Research" → "my-research"); slugs must match ' +
        '/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/. ' +
        'This create-only slug is not the same contract as existing-CG write targets: ' +
        'after creation, call `dkg_list_context_graphs` and pass the returned canonical `id` ' +
        'or full `did:dkg:context-graph:...` URI to assertion, sub-graph, publish, and other write tools. ' +
        'Defaults to safe `sharing="invite-only"` + `contribution="curators-only"`; ' +
        'switch to `"open"` to make the CG publicly discoverable or to allow ' +
        'anyone to publish to Verified Memory respectively.',
      inputSchema: {
        name: z.string().min(1).describe('Human-readable name (e.g. "My Research Context Graph")'),
        description: z.string().optional().describe('Optional description of the CG\'s purpose'),
        id: z
          .string()
          .optional()
          .describe(
            'Optional explicit slug for creating a new CG. Auto-derived from `name` when omitted. ' +
              'Must match /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/. Do not use this field as a model for write-tool contextGraphId values; use `dkg_list_context_graphs` after creation.',
          ),
        sharing: z
          .enum(['open', 'invite-only'])
          .optional()
          .default('invite-only')
          .describe(
            '"open" = publicly discoverable, anyone may subscribe. ' +
              '"invite-only" = curator gates membership (default). ' +
              'Maps to on-chain accessPolicy.',
          ),
        contribution: z
          .enum(['open', 'curators-only'])
          .optional()
          .default('curators-only')
          .describe(
            '"open" = any agent may publish to Verified Memory. ' +
              '"curators-only" = only the curator may publish (default). ' +
              'Maps to on-chain publishPolicy.',
          ),
      },
    },
    async ({ name, description, id, sharing, contribution }): Promise<ToolResult> => {
      const trimmedName = name.trim();
      if (!trimmedName) return errResult('"name" is required.');
      const explicitId = id?.trim();
      const cgId = explicitId || slugify(trimmedName);
      if (!cgId) {
        return errResult(
          'Could not derive a valid context graph ID from the name. Provide an explicit `id`.',
        );
      }
      if (!VALID_CG_ID_RE.test(cgId)) {
        return errResult(
          `Invalid context graph ID "${cgId}". Use lowercase letters, numbers, and hyphens (e.g. "my-research"). Must start and end with a letter or digit.`,
        );
      }
      // Map UX-level dials to wire fields. accessPolicy: 0 = public, 1 = private.
      // publishPolicy: 0 = curated, 1 = open. Defaults above keep both locked.
      const accessPolicy = sharing === 'open' ? 0 : 1;
      const publishPolicy = contribution === 'open' ? 1 : 0;
      try {
        const result = await client.createContextGraph({
          id: cgId,
          name: trimmedName,
          description: description?.trim() || undefined,
          accessPolicy,
          publishPolicy,
        });
        // Mirror dkg_assertion_create's idempotency surfacing: distinct
        // success messages for "newly created" vs "already existed" so
        // callers don't have to do an extra `dkg_list_context_graphs`
        // round-trip to figure out which path the daemon took.
        if (result.alreadyExists) {
          return ok(
            `Context graph '${cgId}' already exists.\n` +
              `URI: ${result.uri}`,
          );
        }
        return ok(
          `Created context graph '${cgId}'.\n` +
            `URI: ${result.uri}\n` +
            `Name: ${trimmedName}` +
            (description ? `\nDescription: ${description}` : ''),
        );
      } catch (e) {
        return errResult(`Failed to create context graph: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_subscribe ───────────────────────────────────────────────
  server.registerTool(
    'dkg_subscribe',
    {
      title: 'Subscribe to Context Graph',
      description:
        'Subscribe to a context graph so its data syncs locally from ' +
        'peers. Call once before querying or publishing a remotely-' +
        'authored CG. Defaults to also syncing Shared Working Memory; ' +
        'pass `includeSharedMemory: false` to skip SWM sync (saves ' +
        'bandwidth when you only need on-chain data).',
      inputSchema: {
        contextGraphId: z.string().min(1).describe(EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION),
        includeSharedMemory: z
          .boolean()
          .optional()
          .default(true)
          .describe('Also sync SWM. Default true.'),
      },
    },
    async ({ contextGraphId, includeSharedMemory }): Promise<ToolResult> => {
      const cgId = contextGraphId.trim();
      if (!cgId) return errResult('"contextGraphId" is required.');
      try {
        const result = await client.subscribe({
          contextGraphId: cgId,
          includeSharedMemory,
        });
        const catchup = result.catchup
          ? `\nCatchup job: ${result.catchup.jobId} (status: ${result.catchup.status}, includeSharedMemory: ${result.catchup.includeSharedMemory})`
          : '';
        return ok(`Subscribed to '${result.subscribed}'.${catchup}`);
      } catch (e) {
        return errResult(`Failed to subscribe: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_sub_graph_create ────────────────────────────────────────
  // Idempotent semantics — final lock per parity-analyst matrix v0.8
  // §4.18 (2026-05-04). Routes through `client.ensureSubGraph` which
  // catches the daemon's 409 on duplicate-name and returns silent
  // success.
  //
  // Rationale (the create-family-wide view): the three `*_create`
  // tools have asymmetric daemon-side idempotency:
  //   - dkg_assertion_create   → daemon-idempotent (`alreadyExists: true`)
  //   - dkg_context_graph_create → daemon-idempotent (returns existing CG)
  //   - dkg_sub_graph_create   → daemon-strict (409 on duplicate)
  //
  // Wrapping the strict one at the client level via `ensureSubGraph`
  // gives agents a uniform "all *_create tools are safe to retry"
  // mental model. Adapter parity loses to UX consistency on this one;
  // matrix v0.8 §4.18 documents the divergence as deliberate.
  server.registerTool(
    'dkg_sub_graph_create',
    {
      title: 'Create Sub-graph',
      description:
        'Create a named sub-graph inside a context graph (an optional ' +
        'partition for scoped assertions, e.g. "code", "tasks", "meta"). ' +
        'Idempotent — a pre-existing sub-graph with the same name is ' +
        'silently reused, no error. Names must be lowercase letters, ' +
        'digits, and hyphens, and must not start with `_`.',
      inputSchema: {
        contextGraphId: z.string().min(1).describe(`Parent context graph id. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}`),
        subGraphName: z
          .string()
          .min(1)
          .describe('Sub-graph name (lowercase letters, digits, hyphens; not starting with "_")'),
      },
    },
    async ({ contextGraphId, subGraphName }): Promise<ToolResult> => {
      const cgId = contextGraphId.trim();
      const sgName = subGraphName.trim();
      if (!cgId) return errResult('"contextGraphId" is required.');
      if (!sgName) return errResult('"subGraphName" is required.');
      try {
        await client.ensureSubGraph(cgId, sgName);
        return ok(`Sub-graph '${sgName}' ready in '${cgId}'.`);
      } catch (e) {
        return errResult(`Failed to create sub-graph: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_request_hosting (intentionally NOT registered) ──────────
  // OT-RFC-38 / LU-6 Phase B — `POST /api/shared-memory/host-mode/
  // subscribe` is the operator-driven manual path (#4 of the four
  // LU-6 discovery mechanisms). It changes WHICH NODE hosts a
  // curated CG's opaque ciphertext, which is a trust-boundary
  // decision the curator owns — the agent must not invoke it
  // autonomously through an MCP tool.
  //
  // Codex review #672 (id=3302086584): the previous `dkg_request_
  // hosting` MCP tool let any connected agent flip its core into a
  // host for any curated CG by name. Removed entirely here; the
  // route stays in place for operators who invoke it directly via
  // `curl` or the `dkg` CLI (see
  // `docs/runbooks/RUNBOOK_HOST_MODE_MANUAL_SUBSCRIBE.md`).
  //
  // The `requestHostMode` client method (`packages/mcp-dkg/src/
  // client.ts`) stays — it's still useful inside operator scripts
  // that wrap the daemon API for their own internal tooling, just
  // not exposed as an MCP-discoverable tool. The drop-sweep guard
  // in `packages/mcp-dkg/test/drop-sweep.test.ts` blocks silent
  // re-registration.
}
