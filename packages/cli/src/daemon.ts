// Split-refactor barrel: every helper that used to live inline in
// this 10.5k-line file now lives under `./daemon/*.ts`. External
// consumers (cli.ts, tests) import from `./daemon.js`, so we re-
// export every public symbol here. See `./daemon/index.ts` for the
// per-module barrel used inside the refactor.

export { daemonState, resolveAutoUpdateEnabled, type CorsAllowlist } from './daemon/state.js';
export * from './daemon/types.js';
export * from './daemon/manifest.js';
export * from './daemon/http-utils.js';
export * from './daemon/auto-update.js';
export * from './daemon/openclaw.js';
export * from './daemon/local-agents.js';
export * from './daemon/lifecycle.js';
export * from './daemon/handle-request.js';
