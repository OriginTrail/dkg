export { DkgNodePlugin } from './DkgNodePlugin.js';
export { DkgDaemonClient, type DkgClientOptions } from './dkg-client.js';
export { DkgChannelPlugin, CHANNEL_NAME } from './DkgChannelPlugin.js';
export {
  mergeOpenClawConfig,
  openclawConfigPath,
  removeCanonicalNodeSkill,
  resolveWorkspaceDirFromConfig,
  runSetup,
  unmergeOpenClawConfig,
  verifyMemorySlotInvariants,
  verifyUnmergeInvariants,
  type AdapterEntryConfig,
  type SetupOptions,
} from './setup.js';
// Codex Bug B24: the `DkgMemoryPlugin` class no longer exposes the legacy
// `OpenClawMemorySearchManager` surface (see the breaking-change JSDoc on
// the class). Both explicit tool surfaces that previously shipped alongside
// it — `dkg_memory_import` (writes) and the `dkg_memory_search` legacy-
// gateway compat tool — have also been retired; reads and writes flow
// through the memory slot via `api.registerMemoryCapability`. Programmatic
// search remains available to external consumers via `DkgMemorySearchManager`
// (the standalone search implementation that used to be backed by methods
// on `DkgMemoryPlugin`) and `buildDkgMemoryRuntime` (the factory used with
// `api.registerMemoryCapability`), along with the resolver interface they
// depend on. Re-export them from the barrel so the migration path documented
// on `DkgMemoryPlugin` is actually reachable from
// `@origintrail-official/dkg-adapter-openclaw`.
export {
  DkgMemoryPlugin,
  DkgMemorySearchManager,
  buildDkgMemoryRuntime,
  AGENT_CONTEXT_GRAPH,
  CHAT_TURNS_ASSERTION,
  PROJECT_MEMORY_ASSERTION,
} from './DkgMemoryPlugin.js';
export type {
  DkgMemorySession,
  DkgMemorySessionResolver,
} from './DkgMemoryPlugin.js';
export type {
  ChannelInboundMessage,
  ChannelOutboundReply,
  DkgOpenClawConfig,
  JSONSchemaObject,
  MemoryLayer,
  MemoryPluginCapability,
  MemoryPluginRuntime,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchOptions,
  MemorySearchResult,
  MemorySource,
  OpenClawChannelAdapter,
  OpenClawPluginApi,
  OpenClawTool,
  OpenClawToolResult,
} from './types.js';
