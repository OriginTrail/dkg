import { Command } from 'commander';

import { applyStoreFlagsToConfig } from '../store-wizard.js';

export function registerOpenclawCommand(program: Command): void {
// ─── dkg openclaw ───────────────────────────────────────────────────

const openclawCmd = program
  .command('openclaw')
  .description('OpenClaw adapter management');

openclawCmd
  .command('setup')
  .description('Set up DKG node + OpenClaw adapter (non-interactive, idempotent)')
  .option('--workspace <dir>', 'Override OpenClaw workspace directory')
  .option('--name <name>', 'Override agent name')
  .option('--port <port>', 'Override daemon API port (default: 9200)')
  .option('--no-verify', 'Skip post-setup verification')
  .option('--no-start', 'Skip daemon start (configure only)')
  .option('--dry-run', 'Preview changes without writing anything')
  .option('--no-fund', 'Skip wallet funding via testnet faucet')
  .option('--fund', 'Fund wallets via testnet faucet (default)')
  .option(
    '--network <name>',
    'Network to set up on (mainnet-gnosis | mainnet-base | testnet). Default for a fresh node: mainnet-gnosis.',
  )
  .option(
    '--store <backend>',
    'Triple-store backend (oxigraph | blazegraph | sparql-http). Validates the URL via an ASK probe and persists the store block after setup completes.',
  )
  .option(
    '--store-url <url>',
    'SPARQL endpoint URL — required when --store is blazegraph or sparql-http.',
  )
  .action(async (opts, command) => {
    // Dynamic import + process.exit plumbing stay here; the actual `runSetup`
    // call lives in `openclawSetupAction` so it can be unit-tested without
    // spawning the built CLI.
    let runSetup: typeof import('@origintrail-official/dkg-adapter-openclaw').runSetup;
    try {
      ({ runSetup } = await import('@origintrail-official/dkg-adapter-openclaw'));
    } catch (err: any) {
      console.error('\n[dkg openclaw setup] OpenClaw adapter is not available.');
      console.error(`  Reason: ${err?.message ?? err}`);
      console.error('  • In a monorepo dev checkout: run `pnpm build` at the repo root to build all workspaces.');
      console.error('  • With a global install: reinstall with `npm install -g @origintrail-official/dkg`.\n');
      process.exit(1);
    }

    const { openclawSetupAction } = await import('../openclaw-setup.js');
    try {
      await openclawSetupAction(opts, command, { runSetup });
      // Persist --store / --store-url after the action's ensureDkgNodeConfig
      // has run; otherwise the config file may not exist yet on a fresh
      // install. Validation hits the same boot-time probe used by the
      // daemon, so an invalid URL fails here, not on the next dkg start.
      await applyStoreFlagsToConfig({
        storeFlag: opts.store,
        storeUrlFlag: opts.storeUrl,
      });
    } catch (err: any) {
      console.error(`\n[setup] ERROR: ${err?.message ?? err}\n`);
      process.exit(1);
    }
  });

}
