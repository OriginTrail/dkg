#!/usr/bin/env node
/**
 * CLI entry point for the DKG OpenClaw adapter setup.
 *
 * Usage:
 *   npx @origintrail-official/dkg-adapter-openclaw setup
 *   dkg-openclaw setup
 *   dkg-openclaw setup --workspace /path/to/workspace --name my-agent
 */

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { runSetup } from './setup.js';

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const program = new Command('dkg-openclaw')
  .description('DKG OpenClaw adapter management')
  .version(getVersion());

program
  .command('setup')
  .description('Set up DKG node + OpenClaw adapter (non-interactive, idempotent)')
  .option('--workspace <dir>', 'Override OpenClaw workspace directory')
  .option('--name <name>', 'Override agent name')
  .option('--port <port>', 'Override daemon API port (default: 9200)')
  .option('--no-fund', 'Skip wallet funding via faucet')
  .option('--no-verify', 'Skip post-setup verification')
  .option('--no-start', 'Skip daemon start (configure only)')
  .option('--dry-run', 'Preview changes without writing anything')
  .action(async (opts) => {
    try {
      await runSetup(opts);
    } catch (err: any) {
      console.error(`\n[setup] ERROR: ${err.message}\n`);
      process.exit(1);
    }
  });

// Default to 'setup' when no subcommand is given
if (process.argv.length <= 2) {
  process.argv.push('setup');
}

program.parse();
