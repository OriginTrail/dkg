import { defineConfig } from 'vitest/config';

const runsDaemonHttpBehavior = process.argv.some((arg) =>
  arg.includes('daemon-http-behavior-extra.test.ts'),
);

if (runsDaemonHttpBehavior) {
  process.env.HARDHAT_PORT = '9548';
}

export default defineConfig({
  test: {
    include: runsDaemonHttpBehavior
      ? ['test/daemon-http-behavior-extra.test.ts']
      : [
          'test/api-client.test.ts',
          'test/config.test.ts',
          'test/status-route-rpc.test.ts',
          'test/memory-graph-events.test.ts',
          'test/trust-endpoint-validation.test.ts',
          'test/daemon/plugin-loader.test.ts',
          'test/daemon/routes/plugins.test.ts',
          'test/auth.test.ts',
          // Pure logic — no hardhat needed. Adding to the unit config means
          // contributors can run it via `pnpm test:unit` in ~2s instead of
          // paying the 2-minute hardhat-boot tax of the default config.
          'test/resolve-standalone-install.test.ts',
          'test/nat-status.test.ts',
          'test/core-prereq-check.test.ts',
          'test/relay-status-block.test.ts',
          'test/supervisor-liveness.test.ts',
          'test/promote-async-routes.test.ts',
          'test/promote-async-daemon-lifecycle.test.ts',
          'test/async-promote-worker.test.ts',
          'test/async-promote-queue-e2e.test.ts',
          'test/import-artifact-routes.test.ts',
          'test/file-store.test.ts',
          'test/skill-endpoint.test.ts',
          // RFC 120 / plan PR 1 + 2 — Blazegraph support. Pure logic
          // (mocked fetch + in-memory config); cheap to keep in the
          // fast unit lane.
          'test/chain-reset-wipe.test.ts',
          'test/store-health-check.test.ts',
          'test/validate-store-config.test.ts',
          'test/store-wizard.test.ts',
          'test/blazegraph-docker.test.ts',
          'test/store-identity-tag.test.ts',
          // Release 2 — managed local Oxigraph server (opt-in). Pure logic
          // + injected fetch/spawn/fs; no network, no real binary.
          'test/oxigraph-binary.test.ts',
          'test/oxigraph-listen-port.test.ts',
          'test/oxigraph-server.test.ts',
          'test/oxigraph-managed.test.ts',
          // Opt-in via BLAZEGRAPH_INTEGRATION_TEST=1. Skips silently
          // (no fetch / no docker spawn) when the env-var is unset, so
          // keeping it in the fast unit lane costs nothing.
          'test/blazegraph-integration.test.ts',
          // #761 — context graph write-target validation (from main).
          'test/context-graph-write-path-validation.test.ts',
          // Notifications-pane redesign (A3) — assertion_activity emitter
          // helper. Pure logic + a tmp SQLite DashboardDB, no hardhat.
          'test/activity-notification.test.ts',
          // Notifications-pane redesign (A4) — scoped GET/POST route. Real
          // DashboardDB + mocked agent; no hardhat.
          'test/notifications-route.test.ts',
          // Local-agent bridge routes are mocked HTTP/runtime tests; include
          // timeout attribution regressions in the fast unit lane too.
          'test/daemon-openclaw.test.ts',
          'test/daemon-hermes.test.ts',
        ],
    testTimeout: runsDaemonHttpBehavior ? 120_000 : 60_000,
    globalSetup: runsDaemonHttpBehavior ? ['../chain/test/hardhat-global-setup.ts'] : [],
    env: runsDaemonHttpBehavior ? { HARDHAT_PORT: '9548' } : undefined,
    maxWorkers: 1,
  },
});
