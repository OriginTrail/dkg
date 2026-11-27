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
import { resolveNpmGlobalService, type InstallService, type IntegrationEntry } from './schema.js';
import type { ProvenanceCheckResult } from './verify-npm-provenance.js';

export interface InstallServiceOptions {
  entry: IntegrationEntry;
  dryRun?: boolean;
  skipProvenance?: boolean;
  verifier?: ProvenanceVerifier;
  runner?: InstallRunner;
  logger?: (msg: string) => void;
  /**
   * The node the operator selected with `--api-url`. Rendered into the
   * DKG_API_URL guidance: `installMcp` already honours this flag, so a service
   * printing the hardcoded default would send an operator who passed
   * `--api-url` to the wrong node while the same flag worked for mcp entries.
   */
  apiUrl?: string;
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
  if (resolveNpmGlobalService(spec) === null) {
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

function buildPostInstructions(
  entry: IntegrationEntry,
  binary: string,
  apiUrl: string | undefined,
): string[] {
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
        // Echo the node the operator actually selected. Printing the default
        // when they passed --api-url points the service at the wrong node.
        lines.push(
          apiUrl
            ? `  ${name}    — ${apiUrl}`
            : `  ${name}    — default http://127.0.0.1:9200`,
        );
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
  const { entry, dryRun, skipProvenance, verifier, runner = runCommand, logger, apiUrl } = options;
  assertNpmGlobalService(entry.install);
  // Use the RESOLVED values, not the raw payload: the resolver trims, and
  // reading around it would send `"@acme/svc "` to npm with the space intact,
  // making the trim decorative at the one place it has to hold. The assertion
  // above guarantees this is non-null.
  const { package: pkg, version } = resolveNpmGlobalService(entry.install)!;
  const binary = resolveBinary({ ...entry.install.npmGlobal, package: pkg });

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
    postInstructions: buildPostInstructions(entry, binary, apiUrl),
  };
}
