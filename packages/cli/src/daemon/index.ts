// Barrel for the split `daemon` module.
//
// The original `packages/cli/src/daemon.ts` became unmanageable at
// ~10.5k lines. This directory hosts the sub-modules it was cut into;
// the barrel re-exports the intended public surface so consumers can import
// from `./daemon/index.js` without depending on the internal file
// layout.
//
// Cross-cutting mutable module state that used to live at the top
// level of the old daemon.ts is kept in `./state.js` so the split
// modules share one canonical instance.

export { daemonState, resolveAutoUpdateEnabled, type CorsAllowlist } from './state.js';
export * from './types.js';
export * from './manifest.js';
export * from './http-utils.js';
export * from '../auto-update-ref.js';
export * from './auto-update.js';
export * from './openclaw.js';
export * from './local-agents.js';
export * from './lifecycle.js';
export {
  CHAIN_FULL_SCAN_EVERY,
  CHAIN_DISCOVERY_SCAN_PAGE_BUDGET,
  chainDiscoveryScanOptions,
  createChainDiscoveryScanRunner,
  type LegacyChainDiscoveryScanOptionsInput,
  type ChainDiscoveryScanOptions,
} from './chain-discovery-scan-runner.js';
export * from './memory-tool-context.js';
export * from './handle-request.js';
