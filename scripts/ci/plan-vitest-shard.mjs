#!/usr/bin/env node
/**
 * Runtime-discovered, duration-weighted Vitest shards for the CLI and chain
 * packages.
 *
 * Durations are test-body timings from GitHub Actions run 29321182804:
 * - CLI job 87046972140
 * - core/storage/chain job 87046972116
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
import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const PER_FILE_OVERHEAD_MS = 600;
export const UNKNOWN_FILE_BODY_MS = 60_000;

const CLI_BODY_MS = Object.freeze({
  'test/activity-notification.test.ts': 535,
  'test/agent-chat-update-route.test.ts': 3435,
  'test/agent-connect-routes.test.ts': 8,
  'test/agent-encryption-key-routes.test.ts': 8,
  'test/api-client.test.ts': 50,
  'test/api-slo-route.test.ts': 37,
  'test/assertion-cli-smoke.test.ts': 13710,
  'test/async-promote-queue-e2e.test.ts': 304,
  'test/async-promote-worker.test.ts': 179,
  'test/auth.test.ts': 67,
  'test/auto-update-jitter.test.ts': 10,
  'test/auto-update-versioned-e2e.test.ts': 2740,
  'test/auto-update.test.ts': 65,
  'test/backfill-rs-percgid-meta-route.test.ts': 91,
  'test/batching.test.ts': 5,
  'test/blazegraph-docker.test.ts': 109,
  'test/blazegraph-image-metadata.test.ts': 29,
  'test/blazegraph-integration.test.ts': 0,
  'test/blue-green-integration.test.ts': 883,
  'test/catchup-runner-worker-impl.test.ts': 63,
  'test/catchup-runner.test.ts': 3,
  'test/chain-discovery-scan-mode.test.ts': 4,
  'test/chain-reset-wipe-backup.test.ts': 67,
  'test/chain-reset-wipe.test.ts': 33,
  'test/chain-rpc-transport-status.test.ts': 4,
  'test/chat-acl.test.ts': 7,
  'test/cli-rpc.test.ts': 21,
  'test/config.test.ts': 51,
  'test/context-graph-cli-smoke.test.ts': 2459,
  'test/context-graph-subscriptions-route.test.ts': 31,
  'test/context-graph-write-path-validation.test.ts': 3416,
  'test/core-prereq-check.test.ts': 16,
  'test/daemon-auth-signed-extra.test.ts': 41,
  'test/daemon-context-graph-register.test.ts': 45,
  'test/daemon-entrypoint-resolution.test.ts': 9,
  'test/daemon-hermes.test.ts': 130,
  'test/daemon-http-behavior-extra.test.ts': 12770,
  'test/daemon-http-inflight-cap.test.ts': 2934,
  'test/daemon-http-replication.test.ts': 3293,
  'test/daemon-ka-transport.test.ts': 10,
  'test/daemon-keystore-extra.test.ts': 546,
  'test/daemon-lifecycle-memory-agent-address.test.ts': 3,
  'test/daemon-lifecycle.test.ts': 2450,
  'test/daemon-log-rotation-io.test.ts': 4,
  'test/daemon-log-rotation.test.ts': 9,
  'test/daemon-openclaw.part-01.test.ts': 11,
  'test/daemon-openclaw.part-02.test.ts': 23,
  'test/daemon-openclaw.part-03.test.ts': 22,
  'test/daemon-openclaw.part-04.test.ts': 26,
  'test/daemon-openclaw.part-05.test.ts': 26,
  'test/daemon-openclaw.part-06.test.ts': 33,
  'test/daemon-openclaw.part-07.test.ts': 3,
  'test/daemon-openclaw.part-08.test.ts': 8,
  'test/daemon-openclaw.part-09.test.ts': 5,
  'test/daemon-openclaw.part-10.test.ts': 3,
  'test/daemon-openclaw.part-11.test.ts': 13,
  'test/daemon-openclaw.part-12.test.ts': 13,
  'test/daemon-openclaw.part-13.test.ts': 12,
  'test/daemon-openclaw.part-14.test.ts': 3,
  'test/daemon-openclaw.part-15.test.ts': 3,
  'test/daemon-openclaw.part-16.test.ts': 24,
  'test/daemon-openclaw.part-17.test.ts': 27,
  'test/daemon-openclaw.part-18.test.ts': 10,
  'test/daemon-openclaw.part-19.test.ts': 3,
  'test/daemon-operational-wallet-routes.test.ts': 13,
  'test/daemon-pca-routes.test.ts': 52,
  'test/daemon-publish-encryption-factory.test.ts': 2,
  'test/daemon-startup-validation.test.ts': 347,
  'test/daemon-storage-ack-timing-wiring.test.ts': 10109,
  'test/daemon-sync-agents-meta-wiring.test.ts': 82,
  'test/daemon/plugin-loader.test.ts': 38,
  'test/daemon/plugin-routes-api.e2e.test.ts': 5353,
  'test/daemon/routes/plugins.test.ts': 10,
  'test/daemon/routes/query.test.ts': 3285,
  'test/log-lifecycle.test.ts': 5,
  'test/dashboard-log-volume-pruner.test.ts': 5,
  'test/devnet-publish-helpers-smoke.test.ts': 12027,
  'test/dkg-doctor.test.ts': 16,
  'test/document-processor-e2e.test.ts': 10,
  'test/edge-auto-update-entrypoint-e2e.test.ts': 70,
  'test/epcis-api-client.test.ts': 8,
  'test/epcis-route-readiness.test.ts': 19,
  'test/epcis-subcommands.test.ts': 17865,
  'test/extraction-markdown.test.ts': 21,
  'test/extraction-markitdown.test.ts': 14,
  'test/extraction-status.test.ts': 9,
  'test/file-store.test.ts': 92,
  'test/finalize-author-token-attribution.test.ts': 4,
  'test/foreground-supervisor-command.test.ts': 1386,
  'test/foreground-supervisor.test.ts': 1580,
  'test/hermes-setup-cli-args.test.ts': 7,
  'test/hermes-setup-orchestration.test.ts': 631,
  'test/http-admission-control.test.ts': 48,
  'test/http-literal-size-validation.test.ts': 4,
  'test/import-artifact-routes.test.ts': 234,
  'test/import-file-integration.part-01.test.ts': 49,
  'test/import-file-integration.part-02.test.ts': 33,
  'test/import-file-integration.part-03.test.ts': 34,
  'test/import-file-integration.part-04.test.ts': 39,
  'test/import-file-integration.part-05.test.ts': 36,
  'test/import-file-integration.part-06.test.ts': 43,
  'test/import-file-integration.part-07.test.ts': 237,
  'test/import-file-integration.part-08.test.ts': 28,
  'test/import-file-integration.part-09.test.ts': 31,
  'test/import-file-integration.part-10.test.ts': 2,
  'test/import-file-integration.part-11.test.ts': 13,
  'test/indexer-solidity-ast.test.ts': 14,
  'test/indexer.test.ts': 32,
  'test/init.test.ts': 7,
  'test/integrations.test.ts': 61,
  'test/issue-306-787-write-quad-validation.test.ts': 3423,
  'test/kc-author-route.e2e.test.ts': 50,
  'test/keystore.test.ts': 1156,
  'test/knowledge-asset-cli-smoke.test.ts': 57816,
  'test/knowledge-assets-1116-share-errors.test.ts': 255,
  'test/knowledge-assets-no-funded-wallet-route.test.ts': 35,
  'test/knowledge-assets-route.test.ts': 5596,
  'test/lifecycle-public-rpc-warn.test.ts': 4,
  'test/log-sink.test.ts': 5,
  'test/markitdown-binaries.test.ts': 76,
  'test/mcp-setup.test.ts': 331,
  'test/memory-graph-events.test.ts': 3303,
  'test/memory-search-sparql-injection.test.ts': 5,
  'test/memory-turn-route.test.ts': 8,
  'test/metrics-presence.test.ts': 3,
  'test/metrics-queries.test.ts': 6,
  'test/migration.test.ts': 131,
  'test/multipart.test.ts': 9,
  'test/nat-status.test.ts': 913,
  'test/no-funded-publisher-wallet-helpers.test.ts': 6,
  'test/node-ops-receipt-timeout.test.ts': 161,
  'test/node-ui-static.test.ts': 4,
  'test/notifications-route-pca.test.ts': 7,
  'test/notifications-route.test.ts': 3076,
  'test/okf-private-lifecycle.test.ts': 14030,
  'test/okf-subcommands.test.ts': 13431,
  'test/openclaw-setup-cli-args.test.ts': 5,
  'test/oxigraph-binary.test.ts': 39,
  'test/oxigraph-listen-port.test.ts': 2,
  'test/oxigraph-managed.test.ts': 2962,
  'test/oxigraph-memory.test.ts': 3,
  'test/oxigraph-parent-watchdog.test.ts': 17,
  'test/oxigraph-server.test.ts': 3567,
  'test/pca-command-render.test.ts': 7,
  'test/pca-confirmation-wire.test.ts': 4,
  'test/preferred-relays.test.ts': 6,
  'test/promote-async-daemon-lifecycle.test.ts': 89,
  'test/promote-async-routes.test.ts': 166,
  'test/promote-route-not-persisted.test.ts': 35,
  'test/publish-async-get-benchmark.test.ts': 129,
  'test/publisher-availability.test.ts': 6,
  'test/publisher-findings.local.test.ts': 0,
  'test/publisher-route-snapshot.test.ts': 62,
  'test/publisher-runner-ack-transport.test.ts': 123,
  'test/publisher-runner-lu11.test.ts': 123,
  'test/publisher-runner-private-encryption.test.ts': 123,
  'test/publisher-runner-rpc-usage.test.ts': 207,
  'test/publisher-runtime-chain-config.test.ts': 2,
  'test/publisher-wallets.test.ts': 1069,
  'test/random-sampling-status.test.ts': 2,
  'test/rdf-parser.test.ts': 10,
  'test/reconcile-503-mapping.test.ts': 4,
  'test/relay-status-block.test.ts': 4,
  'test/repro-issue-633.test.ts': 74,
  'test/resolve-standalone-install.test.ts': 5,
  'test/rfc-41-bundle-b.test.ts': 31,
  'test/rollback-node-ui.test.ts': 5,
  'test/rollback.test.ts': 652,
  'test/rpc-usage-log.test.ts': 262,
  'test/shared-memory-catchup-durable.test.ts': 10,
  'test/shutdown-timeout.test.ts': 1243,
  'test/skill-endpoint.test.ts': 37,
  'test/skill-route-parity.test.ts': 5,
  'test/slot-helpers.test.ts': 603,
  'test/source-worker-daemon-client-validation.test.ts': 19,
  'test/source-worker-daemon-client.test.ts': 3464,
  'test/source-worker-runner.test.ts': 3445,
  'test/status-command-store.test.ts': 5,
  'test/status-route-rpc.test.ts': 3316,
  'test/status-route-store-quads.test.ts': 46,
  'test/store-health-check.test.ts': 38,
  'test/store-identity-tag.test.ts': 19,
  'test/store-wizard.test.ts': 15,
  'test/supervisor-liveness.test.ts': 174,
  'test/swm-large-payload-benchmark.test.ts': 5,
  'test/swm-triple-volume-benchmark.test.ts': 10,
  'test/telemetry-config.test.ts': 4,
  'test/trust-endpoint-validation.test.ts': 3283,
  'test/validate-store-config.test.ts': 6,
  'test/vector-store-extra.test.ts': 266,
  'test/write-preflight-resilience.test.ts': 849,
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
    shardCount: 4,
    excludedPrefixes: Object.freeze([]),
    bodyWeightsMs: CLI_BODY_MS,
  }),
  chain: Object.freeze({
    packageDirectory: 'packages/chain',
    shardCount: 3,
    excludedPrefixes: Object.freeze(['test/archive/']),
    bodyWeightsMs: CHAIN_BODY_MS,
  }),
});

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function walk(directory, packageRoot, output) {
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareAscii(left.name, right.name));

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(absolutePath, packageRoot, output);
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      const relativePath = path.relative(packageRoot, absolutePath).split(path.sep).join('/');
      if (relativePath.includes('\n') || relativePath.includes('\r')) {
        throw new Error('Test file paths may not contain newlines: ' + relativePath);
      }
      output.push(relativePath);
    }
  }
}

export function discoverEligibleTestFiles(packageName, repoRoot) {
  const spec = PACKAGE_SPECS[packageName];
  if (!spec) {
    throw new Error('Unsupported package ' + packageName + '; expected cli or chain');
  }

  const packageRoot = path.join(repoRoot, spec.packageDirectory);
  const testRoot = path.join(packageRoot, 'test');
  const files = [];
  walk(testRoot, packageRoot, files);

  return files
    .filter((file) => !spec.excludedPrefixes.some((prefix) => file.startsWith(prefix)))
    .sort(compareAscii);
}

export function planWeightedShards({
  files,
  bodyWeightsMs,
  shardCount,
  perFileOverheadMs = PER_FILE_OVERHEAD_MS,
  unknownFileBodyMs = UNKNOWN_FILE_BODY_MS,
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
    estimatedMs: 0,
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
      + 'CLI has 4 shards and chain has 3 shards.',
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
