// Installer for registry entries with `install.kind === "cli"`.
//
// These are one-shot binaries the user invokes directly after install (e.g.
// dkg-hello-world). We install them globally via the local npm, pinned to the
// exact version declared in the entry. We deliberately do NOT use npx — the
// entry promises a binary and a pinned version; npm -g gives contributors a
// stable PATH entry and idempotent re-installs.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { dkgDir } from '../config.js';
import type { InstallCli, IntegrationEntry } from './schema.js';
import { verifyNpmProvenance, type ProvenanceCheckResult } from './verify-npm-provenance.js';

export type ProvenanceVerifier = (
  pkg: string,
  version: string,
  expectedRepo: string,
) => Promise<ProvenanceCheckResult>;

// Injectable so tests can exercise the install flow without spawning npm.
export type InstallRunner = (cmd: string, args: string[]) => Promise<number>;

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
  const {
    entry,
    dryRun = false,
    skipProvenance = false,
    verifier = verifyNpmProvenance,
    runner = runCommand,
    logger = console.log,
  } = options;
  assertCli(entry.install);
  const { package: pkg, version, binary } = entry.install;

  const command = 'npm';
  const args = ['install', '--global', `${pkg}@${version}`];

  // Provenance gate: verify BEFORE we touch the user's global npm. We skip
  // this in dry-run (no side effects to guard) and when the caller passes
  // --no-verify-provenance (e.g. installing a pre-release dev tarball with
  // no attestation yet, or an air-gapped registry that doesn't sign).
  let provenance: ProvenanceCheckResult | undefined;
  if (!dryRun && !skipProvenance) {
    logger(`Verifying publish-time provenance for ${pkg}@${version}...`);
    provenance = await verifier(pkg, version, entry.repo);
    if (!provenance.ok) {
      logger('');
      logger('  Provenance check FAILED:');
      for (const r of provenance.reasons) logger(`    - ${r}`);
      logger('');
      throw new Error(
        `Refusing to install ${pkg}@${version}: the tarball on npm is not ` +
          `cryptographically bound to ${entry.repo}. Re-run with --no-verify-provenance ` +
          `to install anyway.`,
      );
    }
    logger(`  ok — tarball is attested and points at ${entry.repo}.`);
    logger('');
  }

  logger(`Installing ${pkg}@${version} globally via npm...`);
  logger(`  ${command} ${args.join(' ')}`);

  if (dryRun) {
    return {
      command,
      args,
      exitCode: 0,
      binary,
      postInstructions: buildPostInstructions(entry),
      provenance,
    };
  }

  const exitCode = await runner(command, args);
  if (exitCode !== 0) {
    throw new Error(`npm install failed with exit code ${exitCode}. See output above for details.`);
  }

  return {
    command,
    args,
    exitCode,
    binary,
    postInstructions: buildPostInstructions(entry),
    provenance,
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

function runCommand(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
