// Shared machinery for the two install kinds that put a package on the user's
// global npm prefix: `install.kind: "cli"` and `install.kind: "service"` with
// `runtime: "npm-global"`.
//
// The mechanics are identical — same pinned global install, same publish-time
// provenance gate, same dry-run semantics — and only the post-install guidance
// differs (a one-shot command vs a daemon to keep running). Keeping the policy
// here means a change to how integrations reach the global prefix (an npm flag,
// the provenance message, the failure mode) is made once instead of being kept
// in sync by memory across two near-identical files.

import { spawn } from 'node:child_process';
import type { IntegrationEntry } from './schema.js';
import { verifyNpmProvenance, type ProvenanceCheckResult } from './verify-npm-provenance.js';

export type ProvenanceVerifier = (
  pkg: string,
  version: string,
  expectedRepo: string,
) => Promise<ProvenanceCheckResult>;

/** Injectable so tests exercise the flow without spawning npm. */
export type InstallRunner = (cmd: string, args: string[]) => Promise<number>;

export interface NpmGlobalInstallOptions {
  entry: IntegrationEntry;
  pkg: string;
  version: string;
  dryRun?: boolean;
  skipProvenance?: boolean;
  verifier?: ProvenanceVerifier;
  runner?: InstallRunner;
  logger?: (msg: string) => void;
  /** Prefix for the "Installing …" line, e.g. 'service'. */
  label?: string;
}

export interface NpmGlobalInstallResult {
  command: string;
  args: string[];
  exitCode: number;
  provenance?: ProvenanceCheckResult;
}

export function runCommand(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Install one pinned package onto the global npm prefix, gated on publish-time
 * provenance. Returns without running npm when `dryRun` is set.
 */
export async function installNpmGlobalPackage(
  options: NpmGlobalInstallOptions,
): Promise<NpmGlobalInstallResult> {
  const {
    entry,
    pkg,
    version,
    dryRun = false,
    skipProvenance = false,
    verifier = verifyNpmProvenance,
    runner = runCommand,
    logger = console.log,
    label,
  } = options;

  const command = 'npm';
  const args = ['install', '--global', `${pkg}@${version}`];

  // Provenance gate: verify BEFORE we touch the user's global npm. Skipped in
  // dry-run (no side effects to guard) and under --no-verify-provenance (e.g. a
  // pre-release dev tarball with no attestation yet, or an air-gapped registry).
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

  logger(`Installing ${label ? `${label} ` : ''}${pkg}@${version} globally via npm...`);
  logger(`  ${command} ${args.join(' ')}`);

  if (dryRun) {
    return { command, args, exitCode: 0, provenance };
  }

  const exitCode = await runner(command, args);
  if (exitCode !== 0) {
    throw new Error(`npm install failed with exit code ${exitCode}. See output above for details.`);
  }

  return { command, args, exitCode, provenance };
}
