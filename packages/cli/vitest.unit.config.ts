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
          'test/agent-connect-routes.test.ts',
          'test/preferred-relays.test.ts',
          'test/reconcile-503-mapping.test.ts',
          'test/config.test.ts',
          'test/status-route-rpc.test.ts',
          'test/status-route-store-quads.test.ts',
          'test/status-command-store.test.ts',
          'test/memory-graph-events.test.ts',
          'test/memory-turn-route.test.ts',
          'test/trust-endpoint-validation.test.ts',
          'test/daemon/plugin-loader.test.ts',
          'test/daemon/routes/plugins.test.ts',
          'test/daemon-pca-routes.test.ts',
          // R8 — #1085 /register policy-matrix route tests, extracted from
          // daemon-http-behavior-extra so they run here (pure route handler,
          // no hardhat/daemon spawn) instead of the daemon-http lane.
          'test/daemon-context-graph-register.test.ts',
          // Private-CG bootstrap readiness: clean-empty responses are only
          // terminal when authoritative metadata has been confirmed.
          'test/context-graph-subscribe-readiness.test.ts',
          'test/context-graph-readiness-migration.test.ts',
          // R9 — PCA advisory wire derivation (pure) + CLI register-agent output
          // rendering (in-process, mocked ApiClient). No hardhat/daemon.
          'test/pca-confirmation-wire.test.ts',
          'test/pca-command-render.test.ts',
          'test/auth.test.ts',
          // Pure logic — no hardhat needed. Adding to the unit config means
          // contributors can run it via `pnpm test:unit` in ~2s instead of
          // paying the 2-minute hardhat-boot tax of the default config.
          'test/resolve-standalone-install.test.ts',
          'test/auto-update.test.ts',
          'test/dkg-doctor.test.ts',
          'test/init.test.ts',
          'test/nat-status.test.ts',
          'test/core-prereq-check.test.ts',
          'test/random-sampling-status.test.ts',
          'test/catchup-runner.test.ts',
          'test/relay-status-block.test.ts',
          'test/supervisor-liveness.test.ts',
          'test/promote-async-routes.test.ts',
          'test/promote-async-daemon-lifecycle.test.ts',
          'test/daemon-ka-transport.test.ts',
          'test/async-promote-worker.test.ts',
          'test/async-promote-queue-e2e.test.ts',
          'test/knowledge-assets-1116-share-errors.test.ts',
          'test/import-artifact-routes.test.ts',
          'test/shared-memory-catchup-durable.test.ts',
          'test/skill-endpoint.test.ts',
          // R6-B — metric COUNT getter TTL memo. Pure logic, no hardhat.
          'test/metrics-queries.test.ts',
          // #1066 Item 1 — metrics presence gate. Pure logic (injected clock).
          'test/metrics-presence.test.ts',
          'test/rpc-usage-log.test.ts',
          'test/dashboard-log-volume-pruner.test.ts',
          // RFC 120 / plan PR 1 + 2 — Blazegraph support. Pure logic
          // (mocked fetch + in-memory config); cheap to keep in the
          // fast unit lane.
          'test/chain-reset-wipe.test.ts',
          'test/chain-reset-wipe-backup.test.ts',
          'test/store-health-check.test.ts',
          'test/validate-store-config.test.ts',
          'test/store-wizard.test.ts',
          'test/blazegraph-docker.test.ts',
          'test/store-identity-tag.test.ts',
          'test/publisher-runner-lu11.test.ts',
          'test/publisher-runner-ack-transport.test.ts',
          // SQLite-backed vector store. Pure local DB coverage; no hardhat.
          'test/vector-store-extra.test.ts',
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
          // Track B — write-preflight resilience when the local store is
          // slow/closed. Real resolver + real agent probe + real (closed)
          // OxigraphWorkerStore; no hardhat needed.
          'test/write-preflight-resilience.test.ts',
          'test/http-literal-size-validation.test.ts',
          // CLI subprocess smoke with stub daemon only; no hardhat needed.
          'test/context-graph-join-policy-cli.test.ts',
          'test/context-graph-join-policy-route.test.ts',
          'test/assertion-cli-smoke.test.ts',
          'test/knowledge-asset-cli-smoke.test.ts',
          'test/okf-subcommands.test.ts',
          'test/okf-private-lifecycle.test.ts',
          'test/epcis-route-readiness.test.ts',
          // Notifications-pane redesign (A3) — assertion_activity emitter
          // helper. Pure logic + a tmp SQLite DashboardDB, no hardhat.
          'test/activity-notification.test.ts',
          // Notifications-pane redesign (A4) — scoped GET/POST route. Real
          // DashboardDB + mocked agent; no hardhat.
          'test/notifications-route.test.ts',
          'test/notifications-route-pca.test.ts',
          // Local-agent bridge routes are mocked HTTP/runtime tests; include
          // timeout attribution regressions in the fast unit lane too.
          'test/daemon-openclaw.part-*.test.ts',
          'test/daemon-hermes.test.ts',
          'test/chain-discovery-scan-mode.test.ts',
          'test/context-graph-subscriptions-route.test.ts',
          // Daemon call-site wiring guard: runDaemonInner passes the resolved
          // syncAgentsMeta into DKGAgent.create. Fully mocked (network/agent/
          // wallets) — no hardhat.
          'test/daemon-context-graph-bootstrap.test.ts',
          'test/daemon-sync-agents-meta-wiring.test.ts',
          'test/daemon-storage-ack-timing-wiring.test.ts',
        ],
    testTimeout: runsDaemonHttpBehavior ? 120_000 : 60_000,
    globalSetup: runsDaemonHttpBehavior ? ['../chain/test/hardhat-global-setup.ts'] : [],
    env: runsDaemonHttpBehavior ? { HARDHAT_PORT: '9548' } : undefined,
    maxWorkers: 1,
  },
});
