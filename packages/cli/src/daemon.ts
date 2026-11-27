// Split-refactor barrel: every helper that used to live inline in
// this 10.5k-line file now lives under `./daemon/*.ts`. External
// consumers (cli.ts, tests) import from `./daemon.js`, so we re-
// export every public symbol here. See `./daemon/index.ts` for the
// per-module barrel used inside the refactor.

export {
  daemonState,
  resolveAutoUpdateEnabled,
  resolveStandaloneInstall,
  type CorsAllowlist,
} from './daemon/state.js';
export * from './daemon/types.js';
export * from './daemon/manifest.js';
export * from './daemon/http-utils.js';
export * from './auto-update-ref.js';
export * from './daemon/auto-update.js';
export * from './daemon/openclaw.js';
export * from './daemon/hermes.js';
export * from './daemon/local-agents.js';
export * from './daemon/lifecycle.js';
export * from './daemon/memory-tool-context.js';
export * from './daemon/handle-request.js';
export * from './daemon/shutdown.js';
export * from './daemon/core-prereq-check.js';
export * from './daemon/relay-status-block.js';
export * from './daemon/supervisor-liveness.js';
