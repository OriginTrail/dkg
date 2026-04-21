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
import { registerSetupCommand } from './setup-command.js';

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

registerSetupCommand(program);

// Default to 'setup' when no subcommand is given
if (process.argv.length <= 2) {
  process.argv.push('setup');
}

program.parse();
