/**
 * Module-scope constants and small types for {@link DkgNodePlugin}.
 *
 * Extracted verbatim from `DkgNodePlugin.ts` to keep the plugin class
 * manageable. No behavior change — same values/types, only relocated.
 */

export const EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION =
  'Use the injected target context graph id/URI when present; otherwise use ' +
  'an exact existing context graph id from dkg_list_context_graphs, or its ' +
  'full did:dkg:context-graph:<id> URI. Locally-created context graphs ' +
  'may have ids like "local-notes"; joined/curated context graphs use ' +
  '<curatorAddress>/<slug> ids like "0x.../team-notes". Do not guess, ' +
  'shorten, or pass only the suffix slug for curator-scoped graphs.';

export const OPENCLAW_LOCAL_AGENT_CAPABILITIES = {
  localChat: true,
  chatAttachments: true,
  connectFromUi: true,
  installNode: true,
  dkgPrimaryMemory: true,
  wmImportPipeline: true,
  nodeServedSkill: true,
} as const;

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:9200';

export type ChatTurnWriterStateDirSource =
  | 'runtime'
  | 'env'
  | 'config'
  | 'workspace'
  | 'setup-default'
  | 'home';

export const STATE_DIR_SOURCE_PRIORITY: Record<ChatTurnWriterStateDirSource, number> = {
  runtime: 0,
  env: 1,
  config: 2,
  workspace: 3,
  'setup-default': 4,
  home: 5,
};

export const OPENCLAW_LOCAL_AGENT_MANIFEST = {
  packageName: '@origintrail-official/dkg-adapter-openclaw',
  setupEntry: './setup-entry.mjs',
} as const;
/**
 * Base delay before the first retry of `syncLocalAgentIntegrationState`
 * after a failed daemon fetch. The retry is exponential — each failure
 * doubles the previous wait, capped at `LOCAL_AGENT_STATE_RETRY_MAX_DELAY_MS`.
 * First delay is 5 s (not 1 s) so a cold daemon has a useful grace window
 * before the first retry fires.
 */
export const LOCAL_AGENT_STATE_RETRY_BASE_DELAY_MS = 5_000;
/** Cap on the retry delay growth. 60 s matches typical cold-start windows. */
export const LOCAL_AGENT_STATE_RETRY_MAX_DELAY_MS = 60_000;

/**
 * Delay before the deferred "first-failure" re-probe of the node peer ID
 * fires after `refreshMemoryResolverState` reports a missing peerId at
 * register time. Gives the daemon a grace window to finish startup when
 * the gateway registers before `/api/status` is healthy. Subsequent
 * recovery is handled by the on-demand `ensureNodePeerId` fired from the
 * resolver when an actual call needs the peerId. Codex Bug B9.
 */
export const NODE_PEER_ID_DEFERRED_RETRY_DELAY_MS = 5_000;
/**
 * Wall-clock TTL for the subscribed-context-graph cache consulted by
 * `memorySessionResolver.listAvailableContextGraphs`. Once the cache is
 * older than this, the next resolver call fires a best-effort background
 * refresh so newly-created or newly-subscribed CGs flow into the
 * `needs_clarification` choices returned by `dkg_memory_import`. Set
 * conservatively: the refresh is a single `/api/context-graphs` listing,
 * cheap enough to run every few turns but not so frequent that it
 * stampedes the daemon. Codex Bug B23.
 */
export const AVAILABLE_CONTEXT_GRAPH_CACHE_TTL_MS = 30_000;

/**
 * R16.3 — Maximum length of the auto-recall query passed to
 * `DkgMemorySearchManager.searchNarrow` from the `before_prompt_build`
 * hook. The manager expands every 2+ char token into the SPARQL filter,
 * so a pasted log/code block can blow up the fan-out cost. 500 chars
 * preserves enough signal for natural-language turns while bounding
 * worst-case daemon work per prompt build.
 */
export const AUTO_RECALL_QUERY_MAX_CHARS = 500;
