// Installer for registry entries with `install.kind === "service"` and
// `runtime: "npm-global"`.
//
// A service is a long-running process rather than a one-shot command, but the
// npm-global mechanics are identical to `install.kind: "cli"`, so both share
// installNpmGlobalPackage(). What differs is the post-install guidance: the
// operator needs to know how to keep it running and which env vars it requires,
// not "run --help to get started".
//
// `docker` and `binary` runtimes are NOT handled here; commands.ts keeps them
// on the explicit not-implemented path.

import { join } from 'node:path';
import { dkgDir } from '../config.js';
import {
  installNpmGlobalPackage,
  runCommand,
  type InstallRunner,
  type ProvenanceVerifier,
} from './install-npm-global.js';
import type { InstallService, IntegrationEntry } from './schema.js';
import type { ProvenanceCheckResult } from './verify-npm-provenance.js';

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
  // The schema requires package + version; `binary` is optional and defaults to
  // the package name (see resolveBinary). Checked by TYPE, not truthiness: a
  // non-string `package` is truthy and would reach the npm spec as
  // `[object Object]@1.0.0` instead of being rejected as malformed.
  if (
    typeof spec.npmGlobal?.package !== 'string' ||
    typeof spec.npmGlobal.version !== 'string' ||
    !spec.npmGlobal.package.trim() ||
    !spec.npmGlobal.version.trim()
  ) {
    throw new Error(
      `Registry entry declares runtime "npm-global" but no npmGlobal.package/version. ` +
        `Report this to the integration maintainer.`,
    );
  }
}

/**
 * The command an operator runs to start the service. `npmGlobal.binary` is
 * OPTIONAL in the registry schema — it is only present "if different from the
 * package name" — so fall back to the package name rather than printing
 * "Start it with: undefined".
 *
 * For a SCOPED package the package name is not a runnable command: installing
 * `@acme/svc` globally puts `svc` on PATH, not `@acme/svc`. Falling back to the
 * full specifier would print a start command that cannot work, which is the
 * same class of bad guidance as the `undefined` this fallback was added to fix.
 * npm's own convention is the unscoped segment, so that is what we print.
 */
function resolveBinary(npmGlobal: NpmGlobalService['npmGlobal']): string {
  const explicit = npmGlobal.binary?.trim();
  if (explicit) return explicit;
  const pkg = npmGlobal.package;
  return pkg.startsWith('@') && pkg.includes('/') ? pkg.slice(pkg.indexOf('/') + 1) : pkg;
}

function buildPostInstructions(entry: IntegrationEntry, binary: string): string[] {
  const spec = entry.install as InstallService;
  const lines: string[] = [];
  lines.push(`This integration is a long-running service. Start it with:`);
  lines.push(`  ${binary}`);

  const env = spec.envRequired ?? [];
  if (env.length > 0) {
    lines.push('');
    lines.push('Required environment:');
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

  if (spec.portsOpened?.length) {
    lines.push('');
    lines.push(`It listens on: ${spec.portsOpened.join(', ')}`);
  }

  if (spec.usageHint) {
    lines.push('');
    lines.push('Usage:');
    for (const line of spec.usageHint.split('\n')) lines.push(`  ${line}`);
  }

  lines.push('');
  lines.push(
    `Keep it running under your own process manager (systemd, pm2, docker, a terminal ` +
      `multiplexer) — the DKG CLI does not supervise integrations.`,
  );
  lines.push(`Setup details: ${entry.repo}`);
  return lines;
}

export async function installService(
  options: InstallServiceOptions,
): Promise<InstallServiceResult> {
  const { entry, dryRun, skipProvenance, verifier, runner = runCommand, logger } = options;
  assertNpmGlobalService(entry.install);
  const { package: pkg, version } = entry.install.npmGlobal;
  const binary = resolveBinary(entry.install.npmGlobal);

  const result = await installNpmGlobalPackage({
    entry,
    pkg,
    version,
    dryRun,
    skipProvenance,
    verifier,
    runner,
    logger,
    label: 'service',
  });

  return {
    ...result,
    binary,
    postInstructions: buildPostInstructions(entry, binary),
  };
}
