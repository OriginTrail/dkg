/**
 * `dkg store` — operator commands for the DKG-provisioned triple store.
 *
 * Currently one subcommand: `dkg store harden`, the operator entry point
 * for the legacy-container migration in daemon/blazegraph-harden.ts
 * (2026-07-18 mainnet wedge incident). Deliberately a manual command —
 * the daemon never auto-migrates its own store at boot.
 */
import { Command, InvalidArgumentError } from 'commander';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import {
  loadConfig,
  saveConfig,
  dkgDir,
  readPid,
  isProcessRunning,
} from '../config.js';
import {
  deriveBlazegraphContainerName,
  parseBlazegraphNamespaceEndpoint,
} from '../daemon/blazegraph-docker.js';
import {
  executeHardenMigration,
  type HardenStep,
} from '../daemon/blazegraph-harden.js';

/**
 * Strict `--port` parser: decimal 1–65535 only. Runs at commander parse
 * time, so an invalid port fails the command up-front — BEFORE any
 * migration step (or even the config load) executes. `parseInt` alone
 * would accept `9999abc` → 9999 and hand `--port banana` → NaN to the
 * migration mid-flight. Exported for unit tests.
 */
export function parseHardenPortOption(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidArgumentError(
      `--port must be a plain decimal integer between 1 and 65535 (got "${value}").`,
    );
  }
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError(
      `--port must be between 1 and 65535 (got ${trimmed}).`,
    );
  }
  return port;
}


function printPlan(steps: HardenStep[]): void {
  console.log('\nMigration plan:');
  for (const [i, step] of steps.entries()) {
    console.log(`  ${i + 1}. [${step.id}] ${step.description}`);
    if (step.dockerArgs) console.log(`       docker ${step.dockerArgs.join(' ')}`);
  }
  console.log('');
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<boolean>((resolve) => {
      rl.question(question, (answer) => resolve(/^y(es)?$/i.test(answer.trim())));
    });
  } finally {
    rl.close();
  }
}

export function registerStoreCommand(program: Command): void {
  const store = program
    .command('store')
    .description('Manage the DKG-provisioned triple store');

  store
    .command('harden')
    .description(
      'Migrate a legacy DKG-provisioned Blazegraph container to the hardened shape ' +
      '(journal volume, JVM heap policy, OOME auto-restart, healthcheck, log rotation)',
    )
    .option('--dry-run', 'Print the migration plan without executing it')
    .option('--yes', 'Skip the confirmation prompt (required when the daemon is running)')
    .option('--container <name>', 'Override the container name (default: derived from store URL)')
    .option('--port <port>', 'Override the host port for the hardened container (1-65535)', parseHardenPortOption)
    .option('--migration-dir <dir>', 'Where to export the journal during migration (default: <dkg home>/blazegraph-harden)')
    .action(async (opts: {
      dryRun?: boolean;
      yes?: boolean;
      container?: string;
      port?: number;
      migrationDir?: string;
    }) => {
      const config = await loadConfig();
      const storeConfig = config.store;
      if (
        storeConfig?.backend !== 'blazegraph' ||
        storeConfig.options?.managedByDkg !== true
      ) {
        console.error(
          'dkg store harden applies only to the DKG-provisioned Blazegraph container ' +
          '(store.backend === "blazegraph" with options.managedByDkg === true).\n' +
          `The config loaded from ${dkgDir()} does not look like one ` +
          `(backend: ${JSON.stringify(storeConfig?.backend ?? null)}).\n` +
          '\n' +
          'If this IS a managed fleet node: DKG_HOME is typically set only inside the ' +
          'systemd unit (e.g. Environment=DKG_HOME=/home/adminuser/dkg-v10), so an ' +
          'interactive shell silently reads the wrong config. Export it first and re-run:\n' +
          '  export DKG_HOME=/home/adminuser/dkg-v10   # match the path in your systemd unit\n' +
          '  dkg store harden\n' +
          '\n' +
          'For a manually installed Blazegraph, apply the same hardening yourself: ' +
          'journal on a volume, -Xmx + -XX:+ExitOnOutOfMemoryError, a HEALTHCHECK, ' +
          'and log rotation.',
        );
        process.exit(1);
      }

      const containerName = opts.container
        ?? deriveBlazegraphContainerName(storeConfig.options);
      if (!containerName) {
        console.error(
          'Could not derive the container name from store.options (no containerName, ' +
          'and the URL does not look like a Blazegraph namespace endpoint). ' +
          'Pass --container <name>.',
        );
        process.exit(1);
      }
      const namespace = parseBlazegraphNamespaceEndpoint(storeConfig.options?.url)?.namespace ?? null;
      if (!namespace) {
        console.error(
          'Could not extract the Blazegraph namespace from store.options.url — ' +
          'expected …/bigdata/namespace/<ns>/sparql.',
        );
        process.exit(1);
      }

      const migrationDir = opts.migrationDir ?? join(dkgDir(), 'blazegraph-harden');
      const log = (m: string) => console.log(m);

      // A running daemon will see its store vanish mid-swap. Its retries
      // tolerate the outage (and the harden lock written by the executor
      // suspends the runtime monitor's docker restarts so it can never
      // fight the migration), but a stopped daemon makes the swap strictly
      // safer — warn loudly and require the explicit --yes opt-in.
      const pid = existsSync(join(dkgDir(), 'daemon.pid')) ? await readPid() : null;
      const daemonRunning = pid != null && isProcessRunning(pid);
      if (daemonRunning && !opts.dryRun) {
        console.log(
          '\nWARNING: the DKG daemon is running (pid ' + pid + '). During the swap it ' +
          'will see the store go away; its retries tolerate this, but stopping it ' +
          'first (`dkg stop`) is safer.\n',
        );
        if (!opts.yes) {
          console.error('Refusing to continue against a running daemon without --yes.');
          process.exit(1);
        }
      }

      if (opts.dryRun) {
        const result = await executeHardenMigration({
          containerName,
          namespace,
          migrationDir,
          dkgHome: dkgDir(),
          hostPort: opts.port,
          dryRun: true,
          log,
        });
        console.log(`Container: ${containerName} (port ${result.hostPort}, heap ${result.heapMb} MB)`);
        printPlan(result.steps ?? []);
        return;
      }

      // Show the plan before asking; the executor re-derives state itself.
      {
        const preview = await executeHardenMigration({
          containerName,
          namespace,
          migrationDir,
          dkgHome: dkgDir(),
          hostPort: opts.port,
          dryRun: true,
          log,
        });
        console.log(`Container: ${containerName} (port ${preview.hostPort}, heap ${preview.heapMb} MB)`);
        printPlan(preview.steps ?? []);
      }
      if (!opts.yes) {
        const ok = await confirm('Proceed with the migration? [y/N] ');
        if (!ok) {
          console.log('Aborted — nothing was changed.');
          return;
        }
      }

      // dkgHome: the harden lock (<dkgHome>/.store-harden.lock) must land in
      // the SAME config dir the daemon's runtime store monitor watches —
      // both sides resolve it via dkgDir().
      const result = await executeHardenMigration({
        containerName,
        namespace,
        migrationDir,
        dkgHome: dkgDir(),
        hostPort: opts.port,
        log,
      });

      // Persist the container name so the runtime monitor / boot recovery /
      // future harden runs stop depending on URL parsing. Additive field —
      // validate-store-config treats options as an open record.
      storeConfig.options = { ...storeConfig.options, containerName: result.containerName };
      await saveConfig(config);

      console.log('');
      if (result.outcome === 'already-hardened') {
        console.log(`"${result.containerName}" was already hardened — nothing changed.`);
      } else {
        console.log(`Hardened "${result.containerName}" successfully.`);
        console.log(`  Journal: ${result.journalBytes} bytes migrated to volume ${result.containerName}-data`);
        console.log(`  Export copy kept at: ${result.exportPath}`);
      }
      if (result.backupContainerName) {
        console.log(
          `  Backup container "${result.backupContainerName}" is preserved (restart disabled).\n` +
          `  After a confidence window (recommended: a week of clean RandomSampling proofs),\n` +
          `  remove it manually with: docker rm ${result.backupContainerName}`,
        );
      }
    });
}
