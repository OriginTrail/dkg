import { defineConfig } from 'vitest/config';
import { hardhatTestEnvironment } from '../../scripts/lib/hardhat-test-env.mjs';

const runsDaemonHttpBehavior = process.argv.some((arg) =>
  arg.includes('daemon-http-behavior-extra.test.ts'),
);

const hardhatEnv = runsDaemonHttpBehavior ? hardhatTestEnvironment() : undefined;

export default defineConfig({
  test: {
    include: runsDaemonHttpBehavior
      ? ['test/daemon-http-behavior-extra.test.ts']
      : [
          'test/api-client.test.ts',
          'test/live-daemon-isolation.test.ts',
          'test/async-vm-publish-registration.test.ts',
          // #1828 — durable-admission recovery lookup route (pure handler, no hardhat).
          'test/publisher-job-by-intent-route.test.ts',
          'test/publisher-journal-route.test.ts',
          'test/publisher-clear-job-route.test.ts',
          // GH#2270 follow-up — who may force-clear a job whose transaction may still land.
          // A pure route-handler test, no hardhat, so it belongs in this lane.
          'test/publisher-clear-job-override-authz.test.ts',
          // #1890 — shared request-body boundary for the four publisher admin
          // POST routes (pure handler, no hardhat). Belongs in the fast lane
          // alongside its clear-job sibling above.
          'test/publisher-admin-body-boundary.test.ts',
          // #1828 — daemon-boot intent-index backfill wiring (fail-open contract).
          'test/vm-publish-intent-backfill.test.ts',
          'test/agent-connect-routes.test.ts',
          'test/preferred-relays.test.ts',
          'test/reconcile-503-mapping.test.ts',
          'test/config.test.ts',
          'test/status-route-rpc.test.ts',
          'test/backpressure-route.test.ts',
      'test/status-route-store-quads.test.ts',
      'test/query-route-lifecycle.test.ts',
      'test/query-catalog-profile-route.test.ts',
      'test/store-unavailable-response.test.ts',
          'test/status-command-store.test.ts',
          // Local-LLM command parsing/session controls are pure and never spawn
          // MCP or llama.cpp in this fast lane.
          'test/llm-command.test.ts',
          'test/daemon-local-llm-route.test.ts',
          'test/daemon-local-llm-service.test.ts',
          'test/local-llm-runtime-factory.test.ts',
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
          'test/context-graph-catchup-readiness.test.ts',
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
          'test/maintenance-update-gate.test.ts',
          'test/dkg-doctor.test.ts',
          'test/metrics-collector-config.test.ts',
          'test/init.test.ts',
          'test/init-command.test.ts',
          'test/init-chain-config.test.ts',
          'test/start-store-preflight.test.ts',
          'test/nat-status.test.ts',
          'test/core-prereq-check.test.ts',
          'test/random-sampling-status.test.ts',
          'test/catchup-runner.test.ts',
          'test/catchup-runner-worker-impl.test.ts',
          'test/catchup-runner-worker-lifecycle.test.ts',
          // W1 §6.6/§6.7 — catch-up request/job accounting (I7–I9) and the
          // producer-quiescent shutdown drain. Real WorkerCatchupRunner behind
          // a fake worker thread; no hardhat.
          'test/daemon-catchup-telemetry-shutdown.test.ts',
          'test/catchup-runner-worker-killswitch.test.ts',
          // #2050 — `DKG_SWM_CATCHUP_PASS_BUDGET_MS=0` continuation-pass kill
          // switch, end to end through the worker with per-job config resolution.
          'test/catchup-runner-worker-pass-budget-killswitch.test.ts',
          // #2050 — the sibling lever, `DKG_SWM_CATCHUP_MAX_PASSES=1`.
          'test/catchup-runner-worker-max-passes-cap.test.ts',
          // #2050 — a deferred CONTINUATION pass must not demote a job that
          // already succeeded (the daemon route short-circuits classification
          // on the job-level scalar), and denial counts DISTINCT peers.
          'test/catchup-runner-worker-continuation-deferral.test.ts',
          'test/relay-status-block.test.ts',
          'test/supervisor-liveness.test.ts',
          'test/promote-async-routes.test.ts',
          'test/promote-async-daemon-lifecycle.test.ts',
          'test/daemon-ka-transport.test.ts',
          // Pure HTTP classification coverage for chain transport failures,
          // including preserving a known transaction hash on endpoint exhaustion.
          'test/chain-rpc-transport-status.test.ts',
          'test/async-promote-worker.test.ts',
          'test/async-promote-error-classification.test.ts',
          'test/async-promote-publisher-recovery.test.ts',
          'test/async-promote-bookkeeping-recovery.test.ts',
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
          'test/log-sink.test.ts',
          'test/log-lifecycle.test.ts',
          'test/telemetry-runtime.test.ts',
          'test/update-telemetry-status.test.ts',
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
          'test/blazegraph-image-metadata.test.ts',
          'test/store-identity-tag.test.ts',
          'test/publisher-runner-lu11.test.ts',
          'test/publisher-runner-ack-transport.test.ts',
          'test/publisher-runtime-snapshot-store-injection.test.ts',
          'test/publisher-ka-recovery.test.ts',
          // #2270 — the runner's chain lookup reports WHICH chain fact it found
          // (pending vs proven-absent vs inconclusive), and the two-state
          // resolver derived from it. Pure logic over stub adapters.
          'test/publisher-chain-proof-resolution.test.ts',
          // #1836 — publisher.maxRetries must propagate through
          // createPublisherControlFromStore (incl. a literal 0). Pure logic.
          'test/publisher-maxretries-1836.test.ts',
          // #1836 — config→construction wiring seam (runDaemonInner forwards
          // config.publisher.maxRetries into both admission constructors).
          'test/publisher-maxretries-wiring-1836.test.ts',
          // #2270 — the four retry knobs must reach the publisher instance whose
          // scheduler/sweep run (config→construction seam, #1836 class), the
          // daemon must reject a bad knob at config validation instead of
          // mid-boot construction, and `publisher enable` must not erase them.
          'test/publisher-retry-tuning-wiring-2270.test.ts',
          'test/publisher-retry-tuning-boot-validation-2270.test.ts',
          'test/publisher-enable-preserves-keys-2270.test.ts',
          // #2270 — what the daemon TELLS an operator: the three retry counts on
          // POST /api/publisher/retry, the derived `retryState` on the job-detail
          // routes (real publisher control, no hardhat), and the CLI rendering.
          'test/publisher-retry-surfacing-2270.test.ts',
          'test/publisher-retry-command-output-2270.test.ts',
          // #1828 — daemon-boot wiring seam (runDaemonInner invokes the VM-publish
          // intent-index backfill with the admission publisher control).
          'test/publisher-backfill-wiring-1828.test.ts',
          // Public snapshot paging — one SQLite-indexed store must reach the
          // agent sync responder, admission publisher, and background runtime.
          'test/daemon-snapshot-page-index-wiring.test.ts',
          // SQLite-backed vector store. Pure local DB coverage; no hardhat.
          'test/vector-store-extra.test.ts',
          'test/snapshot-page-index-store.test.ts',
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
          'test/context-graph-join-request-route.test.ts',
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
          'test/daemon-prime-agent.test.ts',
          'test/daemon-prime-agent-persistence.test.ts',
          'test/daemon-sse-final-frame.test.ts',
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
    env: hardhatEnv,
    maxWorkers: 1,
  },
});
