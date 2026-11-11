#!/usr/bin/env node
/**
 * Runtime-discovered, duration-weighted Vitest shards for the CLI and chain
 * packages.
 *
 * Durations are test-body timings from GitHub Actions runs:
 * - CLI: run 43067576492, its eight `cli [n/8]` jobs (coverage enabled); a
 *   file that run did not time keeps its earlier timing
 * - core/storage/chain: run 29321182804, job 87046972116
 *
 * Each file also receives PER_FILE_OVERHEAD_MS to account for import and
 * collection work that Vitest reports separately from test-body duration.
 * Files absent from the timing snapshot are still included and receive a
 * deliberately conservative UNKNOWN_FILE_BODY_MS estimate.
 *
 * Usage from the repository root:
 *   node scripts/ci/plan-vitest-shard.mjs cli 1
 *   node scripts/ci/plan-vitest-shard.mjs chain 1
 *
 * Stdout contains only paths relative to the package root, one per line.
 * A short diagnostic summary is written to stderr.
 */
import { PACKAGE_SHARD_COUNTS } from '../lib/ci-lanes.mjs';
import { discoverVitestFiles } from './discover-vitest-files.mjs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const PER_FILE_OVERHEAD_MS = 600;
export const UNKNOWN_FILE_BODY_MS = 60_000;

const CLI_BODY_MS = Object.freeze({
  'test/activity-notification.test.ts': 219,
  'test/agent-chat-update-route.test.ts': 3768,
  'test/agent-chat-update-term-validation.test.ts': 11,
  'test/agent-connect-routes.test.ts': 9,
  'test/agent-encryption-key-routes.test.ts': 12,
  'test/agent-http-auth.test.ts': 501,
  'test/agents-list-routes.test.ts': 81,
  'test/api-client.test.ts': 1641,
  'test/api-slo-route.test.ts': 46,
  'test/approved-member-empty-graph-first-write.test.ts': 1071,
  'test/assertion-cli-smoke.test.ts': 29544,
  'test/async-admission-routes.test.ts': 184,
  'test/async-admission-store-correlation.test.ts': 26,
  'test/async-admission-trace.test.ts': 16,
  'test/async-admission-usage-log.test.ts': 219,
  'test/async-admission-usage-retention.test.ts': 13,
  'test/async-job-failure-cli.test.ts': 21,
  'test/async-promote-bookkeeping-recovery.test.ts': 64,
  'test/async-promote-error-classification.test.ts': 14,
  'test/async-promote-publisher-recovery.test.ts': 302,
  'test/async-promote-queue-e2e.test.ts': 241,
  'test/async-promote-supervisor-bookkeeping.test.ts': 242,
  'test/async-promote-swm-pointer-recovery.test.ts': 194,
  'test/async-promote-worker-diagnostics.test.ts': 76,
  'test/async-promote-worker.test.ts': 1128,
  'test/async-share-bound-recovery.test.ts': 15720,
  'test/async-share-control-busy-admission.test.ts': 472,
  'test/async-share-evidence-worker.test.ts': 56,
  'test/async-vm-publish-registration.test.ts': 6,
  'test/auth.test.ts': 93,
  'test/authority-index-startup-line.test.ts': 2,
  'test/auto-update-holdoff-gate.test.ts': 24,
  'test/auto-update-holdoff-store.test.ts': 8,
  'test/auto-update-jitter.test.ts': 5,
  'test/auto-update-polling.test.ts': 85,
  'test/auto-update-runner.test.ts': 26,
  'test/auto-update-versioned-e2e.test.ts': 8914,
  'test/auto-update-workspace-clean.test.ts': 61,
  'test/auto-update.test.ts': 83,
  'test/backfill-rs-percgid-meta-route.test.ts': 122,
  'test/backpressure-route.test.ts': 49,
  'test/batching.test.ts': 7,
  'test/blazegraph-docker.test.ts': 537,
  'test/blazegraph-image-metadata.test.ts': 537,
  'test/blazegraph-integration.test.ts': 0,
  'test/blue-green-integration.test.ts': 1381,
  'test/boolean-env-override.test.ts': 6,
  'test/bounded-query.test.ts': 437,
  'test/case-variant-address.test.ts': 5,
  'test/catalog-publication-admission-route.test.ts': 58,
  'test/catalog-readiness-replay-integration.test.ts': 331,
  'test/catchup-proof.test.ts': 10,
  'test/catchup-runner-worker-continuation-deferral.test.ts': 1642,
  'test/catchup-runner-worker-impl.test.ts': 2555,
  'test/catchup-runner-worker-killswitch.test.ts': 26,
  'test/catchup-runner-worker-lifecycle.test.ts': 243,
  'test/catchup-runner-worker-max-passes-cap.test.ts': 12,
  'test/catchup-runner-worker-pass-budget-killswitch.test.ts': 17,
  'test/catchup-runner.test.ts': 20,
  'test/catchup-selected-lane.test.ts': 17,
  'test/catchup-status-cli.test.ts': 7,
  'test/catchup-status-compatibility.test.ts': 4,
  'test/chain-discovery-scan-mode.test.ts': 260,
  'test/chain-discovery-scan-storage.test.ts': 10,
  'test/chain-reset-wipe-backup.test.ts': 31,
  'test/chain-reset-wipe-outcome.test.ts': 4,
  'test/chain-reset-wipe.test.ts': 39,
  'test/chain-rpc-transport-status.test.ts': 67,
  'test/chat-acl.test.ts': 8,
  'test/chat-turn-persistence-session-recovery.test.ts': 61,
  'test/chat-turn-persistence.test.ts': 141,
  'test/clear-job-cli.test.ts': 58936,
  'test/cli-client-startup.test.ts': 9376,
  'test/cli-rpc.test.ts': 3052,
  'test/commands-prime-agent.test.ts': 4,
  'test/config.test.ts': 137,
  'test/confirmed-catalog-obligation-http.test.ts': 7494,
  'test/confirmed-catalog-obligation-response.test.ts': 19,
  'test/context-graph-activation-catchup.test.ts': 579,
  'test/context-graph-activation-committed.test.ts': 170,
  'test/context-graph-activation-provisional.test.ts': 52,
  'test/context-graph-authority-attribution.test.ts': 64,
  'test/context-graph-authority-route.test.ts': 59,
  'test/context-graph-catchup-readiness.test.ts': 131,
  'test/context-graph-cli-smoke.test.ts': 4203,
  'test/context-graph-empty-vm-readiness.test.ts': 1057,
  'test/context-graph-empty-vm-repeat.test.ts': 149,
  'test/context-graph-held-content-readiness.test.ts': 139,
  'test/context-graph-join-policy-cli.test.ts': 15,
  'test/context-graph-join-policy-route.test.ts': 80,
  'test/context-graph-join-request-route.test.ts': 71,
  'test/context-graph-list-cli.test.ts': 17,
  'test/context-graph-name-adoption-crash.test.ts': 5694,
  'test/context-graph-name-hash-catchup-status.test.ts': 16941,
  'test/context-graph-name-hash-subscribe-route.test.ts': 107,
  'test/context-graph-on-chain-id-helpers.test.ts': 8,
  'test/context-graph-on-chain-id-startup.test.ts': 783,
  'test/context-graph-on-chain-id-subscribe.test.ts': 2094,
  'test/context-graph-ontology-claim-subscribe-route.test.ts': 587,
  'test/context-graph-owner-write-after-restart.test.ts': 696,
  'test/context-graph-queued-join-cli.test.ts': 14,
  'test/context-graph-read-authority-response.test.ts': 16,
  'test/context-graph-read-model.test.ts': 54,
  'test/context-graph-readiness-migration.test.ts': 58,
  'test/context-graph-readiness-repeat-authority.test.ts': 126,
  'test/context-graph-readiness-repeat.test.ts': 551,
  'test/context-graph-readiness-swm-shortfall.test.ts': 10,
  'test/context-graph-reconcile-route.test.ts': 64,
  'test/context-graph-restored-empty-vm.evm.test.ts': 33336,
  'test/context-graph-route-read-authority-native.test.ts': 4268,
  'test/context-graph-route-read-authority.test.ts': 84,
  'test/context-graph-subscribe-empty-vm.test.ts': 9155,
  'test/context-graph-subscribe-readiness.test.ts': 8207,
  'test/context-graph-subscriptions-route.test.ts': 43,
  'test/context-graph-write-path-validation.test.ts': 3301,
  'test/context-graph-write-readiness-shutdown.test.ts': 1443,
  'test/context-graph-write-readiness.test.ts': 316,
  'test/core-chain-cache-config.test.ts': 10,
  'test/core-prereq-check.test.ts': 26,
  'test/cpu-profile-command.test.ts': 15,
  'test/cpu-profile-live.test.ts': 7828,
  'test/cpu-profile-real.test.ts': 1402,
  'test/cpu-profile.test.ts': 373,
  'test/curator-publish-member-subgraph-share.test.ts': 13461,
  'test/current-commit-full.test.ts': 1671,
  'test/daemon-auth-signed-extra.test.ts': 54,
  'test/daemon-catchup-telemetry-shutdown.test.ts': 1231,
  'test/daemon-chain-reset-wipe.test.ts': 14841,
  'test/daemon-checkpoint-startup.test.ts': 701,
  'test/daemon-context-graph-bootstrap.test.ts': 177,
  'test/daemon-context-graph-register.test.ts': 53,
  'test/daemon-entrypoint-resolution.test.ts': 39,
  'test/daemon-evm-signing.test.ts': 138,
  'test/daemon-external-signer.test.ts': 16319,
  'test/daemon-hermes.test.ts': 2225,
  'test/daemon-http-behavior-extra.test.ts': 22536,
  'test/daemon-http-inflight-cap.test.ts': 3889,
  'test/daemon-http-replication.test.ts': 3591,
  'test/daemon-identity-wallet-routes.test.ts': 34,
  'test/daemon-ka-transport.test.ts': 67,
  'test/daemon-keystore-extra.test.ts': 650,
  'test/daemon-lifecycle-memory-agent-address.test.ts': 3,
  'test/daemon-lifecycle.test.ts': 6960,
  'test/daemon-local-llm-route.test.ts': 148,
  'test/daemon-local-llm-service.test.ts': 173,
  'test/daemon-log-rotation-io.test.ts': 29,
  'test/daemon-log-rotation.test.ts': 1946,
  'test/daemon-managed-boot-wiring.test.ts': 182,
  'test/daemon-managed-oxigraph-store-wiring.test.ts': 18,
  'test/daemon-memory-tool-context.test.ts': 11,
  'test/daemon-openclaw-persistence.test.ts': 52,
  'test/daemon-openclaw.part-01.test.ts': 13,
  'test/daemon-openclaw.part-02.test.ts': 66,
  'test/daemon-openclaw.part-03.test.ts': 36,
  'test/daemon-openclaw.part-04.test.ts': 63,
  'test/daemon-openclaw.part-05.test.ts': 81,
  'test/daemon-openclaw.part-06.test.ts': 37,
  'test/daemon-openclaw.part-07.test.ts': 4,
  'test/daemon-openclaw.part-08.test.ts': 12,
  'test/daemon-openclaw.part-09.test.ts': 5,
  'test/daemon-openclaw.part-10.test.ts': 3,
  'test/daemon-openclaw.part-11.test.ts': 21,
  'test/daemon-openclaw.part-12.test.ts': 14,
  'test/daemon-openclaw.part-13.test.ts': 15,
  'test/daemon-openclaw.part-14.test.ts': 5,
  'test/daemon-openclaw.part-15.test.ts': 4,
  'test/daemon-openclaw.part-16.test.ts': 35,
  'test/daemon-openclaw.part-17.test.ts': 31,
  'test/daemon-openclaw.part-18.test.ts': 11,
  'test/daemon-openclaw.part-19.test.ts': 3,
  'test/daemon-operational-wallet-routes.test.ts': 16,
  'test/daemon-operator-scope-live.test.ts': 2744,
  'test/daemon-pca-routes.test.ts': 78,
  'test/daemon-prime-agent-election.test.ts': 11,
  'test/daemon-prime-agent-persistence.test.ts': 195,
  'test/daemon-prime-agent.test.ts': 153,
  'test/daemon-protocol-store-wiring.test.ts': 208,
  'test/daemon-publish-encryption-factory.test.ts': 5,
  'test/daemon-publisher-startup-cancellation.test.ts': 226,
  'test/daemon-queue-retention-live.test.ts': 16167,
  'test/daemon-share-admission-shutdown.test.ts': 3,
  'test/daemon-snapshot-page-index-wiring.test.ts': 93,
  'test/daemon-sse-final-frame.test.ts': 9,
  'test/daemon-startup-validation.test.ts': 557,
  'test/daemon-startup-wait.test.ts': 702,
  'test/daemon-storage-ack-timing-wiring.test.ts': 10631,
  'test/daemon-store-control-path-wiring.test.ts': 309,
  'test/daemon-sync-agents-meta-wiring.test.ts': 2693,
  'test/daemon-ui-token-delivery.test.ts': 32,
  'test/daemon-worker-commands.test.ts': 8,
  'test/daemon-write-preflight-window-wiring.test.ts': 141,
  'test/daemon/plugin-loader.test.ts': 38,
  'test/daemon/plugin-routes-api.e2e.test.ts': 7459,
  'test/daemon/routes/plugins.test.ts': 16,
  'test/daemon/routes/query.test.ts': 3237,
  'test/dashboard-log-volume-pruner.test.ts': 7,
  'test/devnet-publish-helpers-smoke.test.ts': 37192,
  'test/direct-store-writers-read-graphs.test.ts': 48,
  'test/dkg-doctor.test.ts': 39,
  'test/doctor-command-config.test.ts': 4511,
  'test/document-processor-e2e.test.ts': 11,
  'test/durable-chat-turn-response.test.ts': 24,
  'test/durable-gossip-signer-lookup.test.ts': 2379,
  'test/durable-inventory-worker.test.ts': 3081,
  'test/durable-native-reopen-worker.test.ts': 741,
  'test/durable-private-payload-recovery.test.ts': 400,
  'test/durable-share-preparation-race.test.ts': 428,
  'test/durable-superseded-vm-ownership.test.ts': 1324,
  'test/durable-synchronous-share.test.ts': 8749,
  'test/durable-unregistered-author-process.test.ts': 19718,
  'test/durable-vm-inventory-worker.test.ts': 2935,
  'test/edge-auto-update-entrypoint-e2e.test.ts': 76,
  'test/encryption-enrollment-routes.test.ts': 10,
  'test/entity-index-store.test.ts': 202,
  'test/entity-inference-cancellation.test.ts': 251,
  'test/entity-model-identity.test.ts': 180,
  'test/entity-module-boundaries.test.ts': 508,
  'test/entity-request-contract.test.ts': 7,
  'test/entity-search.test.ts': 2301,
  'test/entity-store-migration.test.ts': 32,
  'test/epcis-api-client.test.ts': 9,
  'test/epcis-capture-publication.test.ts': 1216,
  'test/epcis-route-readiness.test.ts': 36,
  'test/epcis-subcommands.test.ts': 31298,
  'test/event-loop-delay-monitor.test.ts': 506,
  'test/external-signer-commands.test.ts': 55,
  'test/extraction-markdown.test.ts': 31,
  'test/extraction-markitdown.test.ts': 19,
  'test/extraction-status.test.ts': 10,
  'test/file-store.test.ts': 555,
  'test/finalize-author-token-attribution.test.ts': 5,
  'test/finalized-publish-options.test.ts': 12,
  'test/foreground-supervisor-command.test.ts': 12166,
  'test/foreground-supervisor.test.ts': 1611,
  'test/genui-read-authority.test.ts': 16,
  'test/graph-catalog-config.test.ts': 3004,
  'test/hermes-setup-cli-args.test.ts': 7,
  'test/hermes-setup-orchestration.test.ts': 590,
  'test/historical-context-graph-discovery.test.ts': 267,
  'test/http-admission-control.test.ts': 46,
  'test/http-literal-size-validation.test.ts': 9,
  'test/http-quad-term-validation.test.ts': 16,
  'test/import-artifact-routes.test.ts': 2436,
  'test/import-file-integration.part-01.test.ts': 66,
  'test/import-file-integration.part-02.test.ts': 43,
  'test/import-file-integration.part-03.test.ts': 36,
  'test/import-file-integration.part-04.test.ts': 48,
  'test/import-file-integration.part-05.test.ts': 62,
  'test/import-file-integration.part-06.test.ts': 43,
  'test/import-file-integration.part-07.test.ts': 233,
  'test/import-file-integration.part-08.test.ts': 30,
  'test/import-file-integration.part-09.test.ts': 29,
  'test/import-file-integration.part-10.test.ts': 3,
  'test/import-file-integration.part-11.test.ts': 15,
  'test/indexer-solidity-ast.test.ts': 16,
  'test/indexer.test.ts': 49,
  'test/init-chain-config.test.ts': 7,
  'test/init-command.test.ts': 746,
  'test/init.test.ts': 9,
  'test/integrations-commands.test.ts': 90,
  'test/integrations-install-service.test.ts': 25,
  'test/integrations.test.ts': 59,
  'test/issue-306-787-write-quad-validation.test.ts': 3580,
  'test/job-failure-views.test.ts': 9,
  'test/job-list-paging-cli.test.ts': 65,
  'test/job-list-paging-routes.test.ts': 4261,
  'test/join-policy-store.test.ts': 46,
  'test/jsonld-knowledge-asset-lifecycle.test.ts': 22670,
  'test/kc-author-route.e2e.test.ts': 59,
  'test/keystore.test.ts': 5704,
  'test/knowledge-asset-cli-smoke.test.ts': 91745,
  'test/knowledge-asset-pull-recovery.test.ts': 21,
  'test/knowledge-asset-share-catalog-handoff.test.ts': 30,
  'test/knowledge-assets-1116-share-errors.test.ts': 790,
  'test/knowledge-assets-error-mapping.test.ts': 78,
  'test/knowledge-assets-local-curator-read.test.ts': 670,
  'test/knowledge-assets-no-funded-wallet-route.test.ts': 69,
  'test/knowledge-assets-publish-authority-route.test.ts': 49,
  'test/knowledge-assets-route.test.ts': 8704,
  'test/knowledge-assets-sub-graph-refusal.test.ts': 54,
  'test/knowledge-subscribe-command.test.ts': 18,
  'test/lan-addresses.test.ts': 6,
  'test/lifecycle-public-rpc-warn.test.ts': 5,
  'test/lifecycle-shutdown-wait.test.ts': 10,
  'test/live-daemon-isolation.test.ts': 3324,
  'test/liveness-diagnostics.test.ts': 612,
  'test/liveness-supervisor-log.test.ts': 266,
  'test/llm-command.test.ts': 10,
  'test/local-llm-runtime-factory.test.ts': 61,
  'test/local-private-first-write.test.ts': 1208,
  'test/log-lifecycle.test.ts': 77,
  'test/log-sink.test.ts': 7,
  'test/maintenance-shutdown-abort.test.ts': 1666,
  'test/maintenance-update-gate.test.ts': 75,
  'test/marketplace-buyer.evm.test.ts': 5801,
  'test/marketplace-daemon.evm.test.ts': 4415,
  'test/marketplace-landing.evm.test.ts': 22995,
  'test/marketplace-route-gateway.test.ts': 262,
  'test/marketplace-route-seller-start.test.ts': 17,
  'test/marketplace-route-startup.test.ts': 35,
  'test/marketplace-route-top-up.test.ts': 257,
  'test/marketplace-routes.test.ts': 284,
  'test/marketplace-serving.evm.test.ts': 63318,
  'test/markitdown-binaries.test.ts': 4036,
  'test/mcp-claude-relocated.test.ts': 93,
  'test/mcp-config-document.test.ts': 81,
  'test/mcp-config-metadata.test.ts': 38,
  'test/mcp-launch-command.test.ts': 35,
  'test/mcp-physical-config.test.ts': 94,
  'test/mcp-registered-server-keys.test.ts': 20,
  'test/mcp-setup.test.ts': 661,
  'test/mcp-uninstall-command.test.ts': 1664,
  'test/mcp-uninstall.test.ts': 1494,
  'test/memory-graph-events.test.ts': 4008,
  'test/memory-search-devnet.test.ts': 5064,
  'test/memory-search-guarded-query-path.test.ts': 374,
  'test/memory-search-read-authority.test.ts': 17,
  'test/memory-search-sparql-injection.test.ts': 7,
  'test/memory-turn-route.test.ts': 14,
  'test/memory-vector-tenant-isolation.test.ts': 104,
  'test/messenger-outbox-memory.test.ts': 6109,
  'test/metrics-collector-config.test.ts': 7,
  'test/metrics-presence.test.ts': 4,
  'test/metrics-queries.test.ts': 41,
  'test/migration.test.ts': 126,
  'test/multipart.test.ts': 11,
  'test/nat-status.test.ts': 920,
  'test/no-funded-publisher-wallet-helpers.test.ts': 8,
  'test/node-admin-scope-routes.test.ts': 36,
  'test/node-ops-receipt-timeout.test.ts': 801,
  'test/node-runtime-preflight.test.ts': 9,
  'test/node-ui-static.test.ts': 5,
  'test/notifications-route-bounded.test.ts': 103,
  'test/notifications-route-pca.test.ts': 11,
  'test/notifications-route.test.ts': 3376,
  'test/okf-private-lifecycle.test.ts': 23396,
  'test/okf-scoped-verify.test.ts': 75,
  'test/okf-subcommands.test.ts': 29462,
  'test/okf-subgraph-roundtrip.test.ts': 9710,
  'test/openclaw-persist-turn.e2e.test.ts': 4723,
  'test/openclaw-setup-cli-args.test.ts': 6,
  'test/other-network-relays.test.ts': 35,
  'test/outbound-brotli-refusal.test.ts': 3005,
  'test/oxigraph-binary.test.ts': 870,
  'test/oxigraph-launch-strategy.test.ts': 66,
  'test/oxigraph-listen-port.test.ts': 411,
  'test/oxigraph-managed-caller-abort.e2e.test.ts': 66619,
  'test/oxigraph-managed-start-options.test.ts': 24,
  'test/oxigraph-managed.test.ts': 11832,
  'test/oxigraph-memory.test.ts': 5,
  'test/oxigraph-orphan-lifecycle.test.ts': 19653,
  'test/oxigraph-orphan-native.test.ts': 1204,
  'test/oxigraph-orphan-policy.test.ts': 67,
  'test/oxigraph-parent-watchdog.test.ts': 1107,
  'test/oxigraph-reclaim-policy.test.ts': 9,
  'test/oxigraph-server-native.test.ts': 8585,
  'test/oxigraph-server-wal.test.ts': 18064,
  'test/oxigraph-server.test.ts': 9665,
  'test/oxigraph-wal-maintenance.test.ts': 17,
  'test/oxigraph-wal.test.ts': 8,
  'test/pca-command-render.test.ts': 8,
  'test/pca-confirmation-wire.test.ts': 5,
  'test/peer-write-term-validation-oxigraph-server.test.ts': 1363,
  'test/pre-agent-store-boot.test.ts': 9,
  'test/preferred-relays.test.ts': 7,
  'test/private-access-route.test.ts': 55,
  'test/process-inventory.test.ts': 100,
  'test/promote-admission-route.test.ts': 57,
  'test/promote-async-daemon-lifecycle.test.ts': 138,
  'test/promote-async-routes.test.ts': 266,
  'test/promote-attempt-result.test.ts': 53,
  'test/promote-job-view-attempts.test.ts': 38,
  'test/promote-queue-config.test.ts': 7,
  'test/promote-route-not-persisted.test.ts': 101,
  'test/protocol-persistence.test.ts': 400,
  'test/public-checkpoint-config.test.ts': 48,
  'test/public-checkpoint-job.test.ts': 61,
  'test/public-snapshot-job.test.ts': 93,
  'test/publish-async-get-benchmark.test.ts': 142,
  'test/publisher-admin-body-boundary.test.ts': 13,
  'test/publisher-availability.test.ts': 8,
  'test/publisher-backfill-wiring-1828.test.ts': 58,
  'test/publisher-chain-proof-resolution.test.ts': 240,
  'test/publisher-clear-job-override-authz.test.ts': 907,
  'test/publisher-clear-job-route.test.ts': 96,
  'test/publisher-default-snapshot-retirement.test.ts': 188,
  'test/publisher-enable-preserves-keys-2270.test.ts': 8,
  'test/publisher-findings.local.test.ts': 0,
  'test/publisher-job-by-intent-route.test.ts': 87,
  'test/publisher-jobs-graph-inventory.test.ts': 166,
  'test/publisher-journal-route.test.ts': 198,
  'test/publisher-ka-recovery.test.ts': 75,
  'test/publisher-live-control-route.test.ts': 14,
  'test/publisher-live-control.test.ts': 1687,
  'test/publisher-maxretries-1836.test.ts': 45,
  'test/publisher-maxretries-wiring-1836.test.ts': 419,
  'test/publisher-offline-read-only.test.ts': 9691,
  'test/publisher-offline-write-guard.test.ts': 90,
  'test/publisher-retry-command-output-2270.test.ts': 16,
  'test/publisher-retry-surfacing-2270.test.ts': 342,
  'test/publisher-retry-tuning-boot-validation-2270.test.ts': 198,
  'test/publisher-retry-tuning-wiring-2270.test.ts': 14557,
  'test/publisher-route-snapshot.test.ts': 82,
  'test/publisher-runner-ack-transport.test.ts': 222,
  'test/publisher-runner-lu11.test.ts': 188,
  'test/publisher-runner-private-encryption.test.ts': 191,
  'test/publisher-runner-rpc-usage.test.ts': 1630,
  'test/publisher-runtime-chain-config.test.ts': 16,
  'test/publisher-runtime-cleanup.test.ts': 119,
  'test/publisher-runtime-snapshot-store-injection.test.ts': 144,
  'test/publisher-startup-admission.test.ts': 1082,
  'test/publisher-startup-lifecycle.test.ts': 456,
  'test/publisher-store.test.ts': 1272,
  'test/publisher-wallet-balances.test.ts': 5,
  'test/publisher-wallets.test.ts': 2296,
  'test/query-catalog-command.test.ts': 19,
  'test/query-catalog-profile-route.test.ts': 112,
  'test/query-client-error-classification.test.ts': 11,
  'test/query-route-lifecycle.test.ts': 42,
  'test/random-sampling-status.test.ts': 7,
  'test/rdf-parser.test.ts': 542,
  'test/read-authority-diagnostics.test.ts': 7,
  'test/read-graph-rollback-target.test.ts': 30,
  'test/read-graphs-command.test.ts': 2055,
  'test/read-graphs-config.test.ts': 6,
  'test/read-graphs-route.test.ts': 744,
  'test/reconcile-503-mapping.test.ts': 4,
  'test/relay-status-block.test.ts': 5,
  'test/repro-issue-633.test.ts': 200,
  'test/request-actor-authentication.test.ts': 4,
  'test/request-actor-route-identity.test.ts': 15,
  'test/resolve-standalone-install.test.ts': 7,
  'test/resource-usage-log.test.ts': 12,
  'test/retention-config.test.ts': 50,
  'test/retention-publisher-sweep.test.ts': 5812,
  'test/retention-runtime-scope.test.ts': 518,
  'test/retention-share-sweep.test.ts': 5475,
  'test/retention-sweeps.test.ts': 27,
  'test/retention-timer.test.ts': 17,
  'test/rfc-41-bundle-b.test.ts': 32,
  'test/rollback-node-ui.test.ts': 6,
  'test/rollback-read-graphs.test.ts': 901,
  'test/rollback-stores.test.ts': 1738,
  'test/rollback.test.ts': 1220,
  'test/rpc-usage-log.test.ts': 1025,
  'test/rpc-usage-snapshot-route.test.ts': 11,
  'test/sealed-create-retry-route.test.ts': 10770,
  'test/semantic-runtime-asset-program.test.ts': 19382,
  'test/semantic-runtime-bound-inbox.test.ts': 201,
  // The slowest CLI suite, longer than an even share of the shards: it gets a shard of its own.
  'test/semantic-runtime-configuration-api.test.ts': 475131,
  'test/semantic-runtime-execution-output.test.ts': 542,
  'test/semantic-runtime-graph-configuration-limits.test.ts': 36960,
  'test/semantic-runtime-inbox.test.ts': 257,
  'test/semantic-runtime-local-llm-adapter.test.ts': 12,
  'test/semantic-runtime-n8n-adapter.test.ts': 103,
  'test/semantic-runtime-n8n-authority.test.ts': 46054,
  'test/semantic-runtime-n8n-fingerprint.test.ts': 194,
  'test/semantic-runtime-n8n-native.test.ts': 218,
  'test/semantic-runtime-n8n-recovery.test.ts': 170160,
  'test/semantic-runtime-n8n-wire.test.ts': 23,
  'test/semantic-runtime-native-assets.test.ts': 539,
  'test/semantic-runtime-program-bindings.test.ts': 5506,
  'test/semantic-runtime-program-policy.test.ts': 8733,
  'test/semantic-runtime-query-adapter.test.ts': 35,
  'test/semantic-runtime-query-pins.test.ts': 34,
  'test/semantic-runtime-receipt-lifecycle.test.ts': 41,
  'test/semantic-runtime-remote-execute-adapter.test.ts': 137,
  'test/semantic-runtime-routes.test.ts': 17,
  'test/semantic-runtime-safe-llm-adapter.test.ts': 394,
  'test/semantic-runtime-sparql-adapter.test.ts': 150,
  'test/semantic-runtime-studio-authority.test.ts': 111068,
  'test/semantic-runtime.test.ts': 3760,
  'test/share-reconciliation-route.test.ts': 20,
  'test/shared-memory-catchup-durable.test.ts': 48,
  'test/shared-memory-metadata-devnet.test.ts': 4914,
  'test/shutdown-server-drain.test.ts': 11632,
  'test/shutdown-timeout.test.ts': 1242,
  'test/shutdown-wait.test.ts': 6557,
  'test/skill-dynamic-substitution.test.ts': 19,
  'test/skill-endpoint.test.ts': 53,
  'test/skill-route-parity.test.ts': 7,
  'test/slot-helpers.test.ts': 992,
  'test/snapshot-job-isolation.test.ts': 153,
  'test/snapshot-page-index-store.test.ts': 119,
  'test/source-worker-daemon-client-validation.test.ts': 27,
  'test/source-worker-daemon-client.test.ts': 4380,
  'test/source-worker-runner.test.ts': 4570,
  'test/sparql-update-written-graphs-census.test.ts': 4,
  'test/start-store-preflight.test.ts': 11,
  'test/status-chain-rpc.test.ts': 1625,
  'test/status-command-store.test.ts': 31,
  'test/status-route-rpc.test.ts': 7489,
  'test/status-route-store-quads.test.ts': 10270,
  'test/storage-ack-peers.test.ts': 5,
  'test/store-control-path-config.test.ts': 13,
  'test/store-count-metrics.test.ts': 62,
  'test/store-health-check.test.ts': 41,
  'test/store-identity-tag.test.ts': 21,
  'test/store-reachability.test.ts': 293,
  'test/store-unavailable-response.test.ts': 56,
  'test/store-wizard.test.ts': 26,
  'test/supervisor-liveness.test.ts': 258,
  'test/swm-large-payload-benchmark.test.ts': 5,
  'test/swm-triple-volume-benchmark.test.ts': 10,
  'test/sync-checkpoint-command.test.ts': 2035,
  'test/telemetry-config.test.ts': 7,
  'test/telemetry-lifecycle.test.ts': 6,
  'test/telemetry-runtime.test.ts': 60,
  'test/terminal-clear-response.test.ts': 8,
  'test/trust-endpoint-validation.test.ts': 3114,
  'test/update-telemetry-status.test.ts': 3,
  'test/validate-store-config.test.ts': 14,
  'test/vector-store-extra.test.ts': 228,
  'test/view-semantics-report.test.ts': 12,
  'test/vm-publish-intent-backfill.test.ts': 4,
  'test/writable-quad-terms.test.ts': 9,
  'test/write-preflight-coalescing-seam.test.ts': 180,
  'test/write-preflight-coalescing.test.ts': 110,
  'test/write-preflight-diagnostics.test.ts': 497,
  'test/write-preflight-resilience.test.ts': 912,
  'test/write-preflight-store-busy-route.test.ts': 111,
});

const CHAIN_BODY_MS = Object.freeze({
  'test/abi-pinning.test.ts': 13,
  'test/agent-provenance-cross-cutting.test.ts': 653,
  'test/bounded-retry-fetch.test.ts': 9,
  'test/build-knowledge-asset-ual.test.ts': 5,
  'test/chain-lifecycle-extra.test.ts': 3264,
  'test/chain-rpc-telemetry.unit.test.ts': 80,
  'test/chain-rpc-transport-error.test.ts': 7,
  'test/context-graph-registry-scan.unit.test.ts': 268,
  'test/conviction-cost-covered-decode.test.ts': 24,
  'test/endpoint-stickiness.acceptance.unit.test.ts': 46,
  'test/enrich-evm-error-extra.test.ts': 35,
  'test/evm-adapter-cg-deposit-failover.unit.test.ts': 62,
  'test/evm-adapter-cg-deposit.test.ts': 840,
  'test/evm-adapter-cg-policy-read-stickiness.unit.test.ts': 60,
  'test/evm-adapter-hub-rotation.e2e.test.ts': 31747,
  'test/evm-adapter-nonce-serialization.unit.test.ts': 291,
  'test/evm-adapter-op-wallet.unit.test.ts': 98,
  'test/evm-adapter-pca-enrich.test.ts': 84,
  'test/evm-adapter-pca-rpc.unit.test.ts': 127,
  'test/evm-adapter-random-sampling.test.ts': 28182,
  'test/evm-adapter-resolve-contract-memo.unit.test.ts': 96,
  'test/evm-adapter-tip-read-carveouts.unit.test.ts': 1103,
  'test/evm-adapter.test.ts': 28092,
  'test/evm-adapter.unit.test.ts': 14289,
  'test/evm-event-decode.test.ts': 99,
  'test/evm-relay-registry.test.ts': 555,
  'test/filter-error-console-suppressor.test.ts': 8,
  'test/filter-error-silencer.test.ts': 14,
  'test/getmaxka-view-e2e.test.ts': 27467,
  'test/getmaxkanumberforauthor.unit.test.ts': 258,
  'test/hardhat-harness-parser.test.ts': 5,
  'test/hub-resolution-cache.unit.test.ts': 7,
  'test/hub-rotation-poller.unit.test.ts': 52,
  'test/keyed-mutex.unit.test.ts': 124,
  'test/keyed-ttl-single-flight-cache.unit.test.ts': 11,
  'test/mock-adapter-kc-views.test.ts': 13,
  'test/mock-adapter-parity.test.ts': 59,
  'test/mock-adapter-publishing-conviction-v10.test.ts': 171,
  'test/mock-adapter-random-sampling.test.ts': 14,
  'test/mock-adapter-relay-registry.test.ts': 9,
  'test/mock-publish-cg-events.test.ts': 8,
  'test/multi-rpc-provider-shape.test.ts': 44,
  'test/multi-rpc-read-failover.test.ts': 107,
  'test/multi-rpc-write-failover.test.ts': 120,
  'test/no-chain-adapter-extra.test.ts': 11,
  'test/no-chain-adapter.test.ts': 7,
  'test/publisher-plan.unit.test.ts': 9,
  'test/publishing-conviction-account-v10.test.ts': 4863,
  'test/readwithfailover-loop.unit.test.ts': 83,
  'test/receipt-wait.unit.test.ts': 18,
  'test/rpc-failover-client.unit.test.ts': 43,
  'test/rpc-failover-log.test.ts': 13,
  'test/rpc-failover-telemetry.unit.test.ts': 36,
  'test/rpc-usage.unit.test.ts': 18052,
  'test/v10-update-ack-digest-parity.unit.test.ts': 89,
  'test/v8-v9-archive.test.ts': 16,
  'test/vitest-config-extra.test.ts': 5,
  'test/write-tx-safety-invariants.unit.test.ts': 93,
});

export const PACKAGE_SPECS = Object.freeze({
  cli: Object.freeze({
    packageDirectory: 'packages/cli',
    shardCount: PACKAGE_SHARD_COUNTS.cli,
    bodyWeightsMs: CLI_BODY_MS,
  }),
  chain: Object.freeze({
    packageDirectory: 'packages/chain',
    shardCount: PACKAGE_SHARD_COUNTS.chain,
    bodyWeightsMs: CHAIN_BODY_MS,
  }),
});

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function discoverEligibleTestFiles(packageName, repoRoot) {
  const spec = PACKAGE_SPECS[packageName];
  if (!spec) {
    throw new Error('Unsupported package ' + packageName + '; expected cli or chain');
  }
  return discoverVitestFiles(path.join(repoRoot, spec.packageDirectory));
}

export function planWeightedShards({
  files,
  bodyWeightsMs,
  shardCount,
  perFileOverheadMs = PER_FILE_OVERHEAD_MS,
  unknownFileBodyMs = UNKNOWN_FILE_BODY_MS,
  shardOverheadMs,
}) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error('shardCount must be a positive integer');
  }
  if (!Array.isArray(files) || files.length < shardCount) {
    throw new Error('Need at least one eligible test file per shard');
  }
  if (new Set(files).size !== files.length) {
    throw new Error('Eligible test file list contains duplicates');
  }
  const overhead = shardOverheadMs ?? Array(shardCount).fill(0);
  if (!Array.isArray(overhead) || overhead.length !== shardCount
      || overhead.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Expected one non-negative overhead per shard');
  }

  const weightedFiles = files.map((file) => {
    const known = Object.hasOwn(bodyWeightsMs, file);
    const bodyMs = known ? bodyWeightsMs[file] : unknownFileBodyMs;
    if (!Number.isFinite(bodyMs) || bodyMs < 0) {
      throw new Error('Invalid test duration for ' + file);
    }
    return {
      file,
      known,
      weightMs: bodyMs + perFileOverheadMs,
    };
  }).sort((left, right) => (
    right.weightMs - left.weightMs || compareAscii(left.file, right.file)
  ));

  const shards = Array.from({ length: shardCount }, (_, index) => ({
    index: index + 1,
    estimatedMs: overhead[index],
    files: [],
    unknownFiles: [],
  }));

  for (const weightedFile of weightedFiles) {
    let target = shards[0];
    for (const candidate of shards.slice(1)) {
      if (
        candidate.estimatedMs < target.estimatedMs
        || (
          candidate.estimatedMs === target.estimatedMs
          && candidate.index < target.index
        )
      ) {
        target = candidate;
      }
    }
    target.estimatedMs += weightedFile.weightMs;
    target.files.push(weightedFile.file);
    if (!weightedFile.known) target.unknownFiles.push(weightedFile.file);
  }

  for (const shard of shards) {
    shard.files.sort(compareAscii);
    shard.unknownFiles.sort(compareAscii);
  }
  return shards;
}

export function planPackageShards(packageName, repoRoot) {
  const spec = PACKAGE_SPECS[packageName];
  if (!spec) {
    throw new Error('Unsupported package ' + packageName + '; expected cli or chain');
  }
  const files = discoverEligibleTestFiles(packageName, repoRoot);
  return planWeightedShards({
    files,
    bodyWeightsMs: spec.bodyWeightsMs,
    shardCount: spec.shardCount,
  });
}

export function defaultRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

function runCli() {
  const [packageName, shardText] = process.argv.slice(2);
  const spec = PACKAGE_SPECS[packageName];
  const shardNumber = Number.parseInt(shardText, 10);
  if (
    !spec
    || String(shardNumber) !== shardText
    || shardNumber < 1
    || shardNumber > spec.shardCount
  ) {
    console.error(
      'Usage: node scripts/ci/plan-vitest-shard.mjs <cli|chain> <shard>; '
      + `CLI has ${PACKAGE_SHARD_COUNTS.cli} shards and chain has ${PACKAGE_SHARD_COUNTS.chain} shards.`,
    );
    process.exitCode = 2;
    return;
  }

  const shard = planPackageShards(packageName, defaultRepoRoot())[shardNumber - 1];
  const estimatedSeconds = (shard.estimatedMs / 1000).toFixed(1);
  console.error(
    'vitest-shard: ' + packageName + ' ' + shardNumber + '/' + spec.shardCount
    + ' files=' + shard.files.length
    + ' estimated=' + estimatedSeconds + 's'
    + ' unknown=' + shard.unknownFiles.length,
  );
  process.stdout.write(shard.files.join('\n') + '\n');
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runCli();
