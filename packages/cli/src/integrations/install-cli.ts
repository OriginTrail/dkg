// Installer for registry entries with `install.kind === "cli"`.
//
// These are one-shot binaries the user invokes directly after install (e.g.
// dkg-hello-world). We install them globally via the local npm, pinned to the
// exact version declared in the entry. We deliberately do NOT use npx — the
// entry promises a binary and a pinned version; npm -g gives contributors a
// stable PATH entry and idempotent re-installs.

import { join } from 'node:path';
import { dkgDir } from '../config.js';
import {
  installNpmGlobalPackage,
  runCommand,
  type InstallRunner,
  type ProvenanceVerifier,
} from './install-npm-global.js';
import type { InstallCli, IntegrationEntry } from './schema.js';
import type { ProvenanceCheckResult } from './verify-npm-provenance.js';

// Re-exported for existing importers; the definitions now live alongside the
// shared npm-global installer that both `cli` and `service` kinds use.
export type { InstallRunner, ProvenanceVerifier };

export interface InstallCliOptions {
  entry: IntegrationEntry;
  dryRun?: boolean;
  skipProvenance?: boolean;
  verifier?: ProvenanceVerifier;
  runner?: InstallRunner;
  logger?: (msg: string) => void;
}

export interface InstallCliResult {
  command: string;
  args: string[];
  exitCode: number;
  binary: string;
  postInstructions: string[];
  provenance?: ProvenanceCheckResult;
}

function assertCli(spec: IntegrationEntry['install']): asserts spec is InstallCli {
  if (spec.kind !== 'cli') {
    throw new Error(`install-cli received non-cli install spec (kind=${spec.kind})`);
  }
}

export async function installCli(options: InstallCliOptions): Promise<InstallCliResult> {
  const { entry, dryRun, skipProvenance, verifier, runner = runCommand, logger } = options;
  assertCli(entry.install);
  const { package: pkg, version, binary } = entry.install;

  const result = await installNpmGlobalPackage({
    entry,
    pkg,
    version,
    dryRun,
    skipProvenance,
    verifier,
    runner,
    logger,
  });

  return {
    ...result,
    binary,
    postInstructions: buildPostInstructions(entry),
  };
}

// Post-install instructions include env vars the integration requires and the
// usageHint block from the registry entry. We do NOT silently write any env
// files; the user's shell is their own territory.
function buildPostInstructions(entry: IntegrationEntry): string[] {
  if (entry.install.kind !== 'cli') return [];
  const lines: string[] = [];
  const env = entry.install.envRequired ?? [];

  if (env.length > 0) {
    lines.push(`Required environment:`);
    for (const name of env) {
      if (name === 'DKG_AUTH_TOKEN') {
        lines.push(`  ${name}  — pull from \`dkg auth show\` or ${join(dkgDir(), 'auth.token')}`);
      } else if (name === 'DKG_API_URL') {
        lines.push(`  ${name}    — default http://127.0.0.1:9200`);
      } else {
        lines.push(`  ${name}`);
      }
    }
  }

  if (entry.install.usageHint) {
    lines.push('');
    lines.push('Usage:');
    for (const line of entry.install.usageHint.split('\n')) {
      lines.push(`  ${line}`);
    }
  }

  return lines;
}

