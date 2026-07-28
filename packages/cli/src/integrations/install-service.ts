// Installer for registry entries with `install.kind === "service"` and
// `runtime: "npm-global"`.
//
// A service is a long-running process rather than a one-shot command, but the
// npm-global mechanics are identical to `install.kind: "cli"` — same global
// install, same pinned version, same provenance gate. The difference is the
// post-install guidance: the operator needs to know how to keep it running and
// which env vars it requires, not "run --help to get started".
//
// `docker` and `binary` runtimes are NOT handled here; commands.ts keeps them
// on the explicit not-implemented path.

import { spawn } from 'node:child_process';
import type { InstallService, IntegrationEntry } from './schema.js';
import { verifyNpmProvenance, type ProvenanceCheckResult } from './verify-npm-provenance.js';

export type ProvenanceVerifier = (
  pkg: string,
  version: string,
  expectedRepo: string,
) => Promise<ProvenanceCheckResult>;

export type InstallRunner = (cmd: string, args: string[]) => Promise<number>;

export interface InstallServiceOptions {
  entry: IntegrationEntry;
  dryRun?: boolean;
  skipProvenance?: boolean;
  verifier?: ProvenanceVerifier;
  runner?: InstallRunner;
  logger?: (msg: string) => void;
}

export interface InstallServiceResult {
  command: string;
  args: string[];
  exitCode: number;
  binary: string;
  postInstructions: string[];
  provenance?: ProvenanceCheckResult;
}

type NpmGlobalService = InstallService & {
  runtime: 'npm-global';
  npmGlobal: NonNullable<InstallService['npmGlobal']>;
};

function assertNpmGlobalService(
  spec: IntegrationEntry['install'],
): asserts spec is NpmGlobalService {
  if (spec.kind !== 'service') {
    throw new Error(`install-service received non-service install spec (kind=${spec.kind})`);
  }
  if (spec.runtime !== 'npm-global') {
    throw new Error(
      `install-service only handles runtime "npm-global" (got "${spec.runtime}"). ` +
        `docker and binary runtimes are not yet automated.`,
    );
  }
  if (!spec.npmGlobal?.package || !spec.npmGlobal?.version) {
    throw new Error(
      `Registry entry declares runtime "npm-global" but no npmGlobal.package/version. ` +
        `Report this to the integration maintainer.`,
    );
  }
}

function runCommand(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function buildPostInstructions(entry: IntegrationEntry, binary: string): string[] {
  const lines: string[] = [];
  const spec = entry.install as InstallService;
  lines.push(`This integration is a long-running service. Start it with:`);
  lines.push(`  ${binary}`);
  const env = spec.envRequired ?? [];
  if (env.length > 0) {
    lines.push('');
    lines.push('It requires these environment variables:');
    for (const name of env) lines.push(`  ${name}`);
  }
  if (spec.portsOpened?.length) {
    lines.push('');
    lines.push(`It listens on: ${spec.portsOpened.join(', ')}`);
  }
  lines.push('');
  lines.push(
    `Keep it running under your own process manager (systemd, pm2, docker, a terminal multiplexer) — ` +
      `the DKG CLI does not supervise integrations.`,
  );
  lines.push(`Setup details: ${entry.repo}`);
  return lines;
}

export async function installService(
  options: InstallServiceOptions,
): Promise<InstallServiceResult> {
  const {
    entry,
    dryRun = false,
    skipProvenance = false,
    verifier = verifyNpmProvenance,
    runner = runCommand,
    logger = console.log,
  } = options;
  assertNpmGlobalService(entry.install);
  const { package: pkg, version, binary } = entry.install.npmGlobal;

  const command = 'npm';
  const args = ['install', '--global', `${pkg}@${version}`];

  // Same provenance gate as installCli: verify BEFORE touching the user's
  // global npm, skipped in dry-run and under --no-verify-provenance.
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

  logger(`Installing service ${pkg}@${version} globally via npm...`);
  logger(`  ${command} ${args.join(' ')}`);

  const postInstructions = buildPostInstructions(entry, binary);

  if (dryRun) {
    return { command, args, exitCode: 0, binary, postInstructions, provenance };
  }

  const exitCode = await runner(command, args);
  if (exitCode !== 0) {
    throw new Error(`npm install failed with exit code ${exitCode}. See output above for details.`);
  }

  return { command, args, exitCode, binary, postInstructions, provenance };
}
