#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * W1 §8.3 packet REACHABILITY gate.
 *
 * ## Why the previous gate could not work
 *
 * §8.3's pre-flight gate asserted `fs.existsSync` for each packet file. That is
 * necessary and NOT sufficient, and it was blind to the failure this repo
 * actually produced: `packages/agent/test/sync-transport-metrics.test.ts` exists
 * on disk (tracked since a148062ad) but was absent from the `include` array in
 * `packages/agent/vitest.unit.config.ts`. Vitest treats positional arguments as
 * FILTERS against `include`, never as additions — so the file contributed
 * nothing, six of the seven named suites ran, and the command exited **0**.
 *
 * Exit 0 is what makes that worse than the three earlier packet failures. v1
 * matched zero tests and exited 1, so it announced itself. A green run that
 * silently drops a suite does not.
 *
 * ## What this gate does instead
 *
 * It asks the real Vitest resolver which files it would actually run
 * (`vitest list --filesOnly`) and fails unless the resolved set EQUALS the named
 * set — both directions. A count-only comparison would pass on two wrong files
 * of the right number. Existence is still checked, so this strictly supersedes
 * the old gate.
 *
 *   node scripts/verify-w1-packet.mjs [repoRoot]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The §8.3 packet. `config: null` means the package's default Vitest config is
 * correct for this suite — true only for node-ui, whose default config has no
 * hardhat `globalSetup`. Every other entry pins the unit config, because the
 * default configs boot Hardhat via `globalSetup` and that is what made v3
 * environment-dependent.
 */
const PACKET = [
  {
    pkg: '@origintrail-official/dkg-agent',
    dir: 'packages/agent',
    config: 'vitest.unit.config.ts',
    files: [
      'test/sync-transport-metrics.test.ts',
      // The two suites carrying most of W1's evidence: M1, M2, M3, M5, M6, M10,
      // M11, M13 and rows A2, A3, A6, A7, A8, A11, A12, A14, A15, A19. Both were
      // allowlisted but absent from §8.3's list, so the documented verification
      // command did not run them. A reachability gate can only prove the packet
      // is HONEST about what it names — it cannot know the packet named the
      // wrong set. Keep this list and §8.3 in sync.
      'test/sync-attempt-telemetry.test.ts',
      'test/sync-operation-telemetry.test.ts',
      'test/sync-backpressure.test.ts',
      'test/sync-fetch-coalescing.test.ts',
      'test/sync-fetch-coalescing-durable.test.ts',
      'test/catchup-concurrency.test.ts',
      'test/changelog-requester.test.ts',
      'test/catchup-policy.test.ts',
    ],
  },
  {
    pkg: '@origintrail-official/dkg',
    dir: 'packages/cli',
    config: 'vitest.unit.config.ts',
    files: [
      'test/catchup-runner.test.ts',
      'test/catchup-runner-worker-impl.test.ts',
      'test/context-graph-subscribe-readiness.test.ts',
      'test/context-graph-catchup-readiness.test.ts',
      'test/catchup-runner-worker-lifecycle.test.ts',
      'test/daemon-catchup-telemetry-shutdown.test.ts',
    ],
  },
  {
    pkg: 'dkg-node-ui',
    dir: 'packages/node-ui',
    config: null,
    files: ['test/telemetry.test.ts'],
  },
];

const repoRoot = process.argv[2] ?? process.cwd();
const failures = [];

/** Normalize a resolver-reported path to the `test/…` form the packet uses. */
function toPacketPath(line) {
  const normalized = line.trim().replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('test/');
  return idx === -1 ? normalized : normalized.slice(idx);
}

for (const entry of PACKET) {
  const missing = entry.files.filter(
    (file) => !fs.existsSync(path.join(repoRoot, entry.dir, file)),
  );
  for (const file of missing) failures.push(`${entry.dir}/${file}: MISSING ON DISK`);

  // A file that does not exist cannot be resolved either; reporting it twice
  // would just bury the actionable line.
  const named = entry.files.filter((file) => !missing.includes(file));
  if (named.length === 0) continue;

  const args = ['--filter', entry.pkg, 'exec', 'vitest', 'list', '--filesOnly'];
  if (entry.config) args.push('--config', entry.config);
  args.push(...named);

  const run = spawnSync('pnpm', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  const resolved = new Set(
    (run.stdout ?? '')
      .split(/\r?\n/)
      .filter((line) => line.trim().endsWith('.test.ts'))
      .map(toPacketPath),
  );

  // `vitest list` exits 0 even when it resolves a strict subset — that is the
  // whole reason this gate exists — so the exit code is never the pass signal.
  // It only tells us whether the resolver itself failed to run.
  if (resolved.size === 0 && run.status !== 0) {
    failures.push(
      `${entry.dir}: vitest list failed (exit ${run.status})\n` +
        `      ${(run.stderr ?? '').trim().slice(0, 400)}`,
    );
    continue;
  }

  const configName = entry.config ?? 'vitest.config.ts';
  for (const file of named) {
    if (!resolved.has(file)) {
      failures.push(
        `${entry.dir}/${file}: EXISTS BUT UNREACHABLE — not matched by ` +
          `${configName}'s include. Vitest silently skips it and the packet still ` +
          `exits 0. Add it to that include list.`,
      );
    }
  }
  // The other direction: a resolved file nobody named means the packet is not
  // running what it claims to run, which a count-only check would miss.
  for (const file of resolved) {
    if (!named.includes(file)) {
      failures.push(
        `${entry.dir}/${file}: RESOLVED BUT NOT NAMED — the packet ran a suite it ` +
          `does not list. Reconcile PACKET here with §8.3.`,
      );
    }
  }
}

if (failures.length) {
  console.error('W1 packet gate FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const total = PACKET.reduce((sum, entry) => sum + entry.files.length, 0);
console.log(`packet ok — all ${total} named suites exist AND resolve under their pinned config`);
