import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CLI_NPM_PACKAGE, dkgDir } from '../config.js';
import {
  compareSemver,
  fetchNpmDistTags,
  resolveNpmVersionTarget,
  type NpmDistTagsLoader,
  type NpmRegistryFailure,
  type NpmVersionNoTargetReason,
} from './npm-registry.js';

export type NpmVersionResult =
  | { version: string; error?: false }
  | { version: null; error: true }
  | { version: null; error: false };

/** Valid update-check states; payloads are required only where meaningful. */
export type NpmVersionStatus =
  | { status: 'available'; version: string }
  | { status: 'no-target'; channel: string }
  | { status: 'up-to-date' }
  | { status: 'error' };

type ReportedNpmVersionResolution =
  | { status: 'resolved'; version: string }
  | { status: 'no-target'; channel: string | null }
  | { status: 'error' };

type NpmVersionCheckDeps = {
  loadDistTags?: NpmDistTagsLoader;
  readCurrentVersion?: () => Promise<string>;
};

type PackageFileReader = (path: URL, encoding: BufferEncoding) => string | Buffer;

export function getCurrentCliVersion(
  readPackageFile: PackageFileReader = readFileSync,
): string {
  try {
    const pkg = JSON.parse(
      String(readPackageFile(new URL('../../package.json', import.meta.url), 'utf-8')),
    );
    return String(pkg.version ?? '').trim();
  } catch {
    return '';
  }
}

async function readDefaultCurrentVersion(): Promise<string> {
  try {
    return (await readFile(join(dkgDir(), '.current-version'), 'utf-8')).trim();
  } catch {
    return getCurrentCliVersion();
  }
}

function logNpmRegistryFailure(
  log: (message: string) => void,
  failure: NpmRegistryFailure,
): void {
  if (failure.kind === 'http-error') {
    log(`Auto-update (npm): registry returned ${failure.status} for ${CLI_NPM_PACKAGE}`);
    return;
  }
  if (failure.kind === 'invalid-response') {
    log(`Auto-update (npm): registry returned malformed dist-tags for ${CLI_NPM_PACKAGE}`);
    return;
  }
  log(`Auto-update (npm): registry check failed (${failure.message})`);
}

function logNpmNoTarget(
  log: (message: string) => void,
  reason: NpmVersionNoTargetReason,
): void {
  switch (reason.kind) {
    case 'no-valid-candidates':
      return;
    case 'missing-channel':
      log(`Auto-update (npm): channel "${reason.channel}" has no published version, skipping`);
      return;
    case 'invalid-channel-version':
      log(`Auto-update (npm): channel "${reason.channel}" → "${reason.version}" is not a valid semver, skipping`);
      return;
    case 'prerelease-channel':
      log(`Auto-update (npm): channel "${reason.channel}" points at a pre-release and allowPrerelease=false, skipping`);
      return;
    case 'unacceptable-latest':
      log('Auto-update (npm): latest dist-tag is absent, invalid, or a pre-release while allowPrerelease=false, skipping');
      return;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** One owner for registry-resolution interpretation and operator-facing logging. */
async function resolveAndReportNpmVersion(
  log: (message: string) => void,
  allowPrerelease: boolean,
  channel: string | undefined,
  loadDistTags: NpmDistTagsLoader,
): Promise<ReportedNpmVersionResolution> {
  const result = await resolveNpmVersionTarget(allowPrerelease, channel, loadDistTags);
  if (result.status === 'resolved') return result;
  if (result.status === 'error') {
    logNpmRegistryFailure(log, result.failure);
    return { status: 'error' };
  }
  logNpmNoTarget(log, result.reason);
  return { status: 'no-target', channel: channel ?? null };
}

/** Compatibility facade for callers that still consume the historical result shape. */
export async function resolveLatestNpmVersion(
  log: (message: string) => void,
  allowPrerelease = true,
  channel?: string,
  loadDistTags: NpmDistTagsLoader = fetchNpmDistTags,
): Promise<NpmVersionResult> {
  const result = await resolveAndReportNpmVersion(
    log,
    allowPrerelease,
    channel,
    loadDistTags,
  );
  if (result.status === 'resolved') return { version: result.version };
  return result.status === 'error'
    ? { version: null, error: true }
    : { version: null, error: false };
}

export async function checkForNpmVersionUpdate(
  log: (message: string) => void,
  allowPrerelease = true,
  channel?: string,
  deps: NpmVersionCheckDeps = {},
): Promise<NpmVersionStatus> {
  const currentVersion = await (deps.readCurrentVersion ?? readDefaultCurrentVersion)();
  if (!currentVersion) {
    log('Auto-update (npm): unable to determine current version');
    return { status: 'error' };
  }

  const result = await resolveAndReportNpmVersion(
    log,
    allowPrerelease,
    channel,
    deps.loadDistTags ?? fetchNpmDistTags,
  );
  if (result.status === 'error') return { status: 'error' };
  if (result.status === 'no-target') {
    return result.channel === null
      ? { status: 'up-to-date' }
      : { status: 'no-target', channel: result.channel };
  }

  if (result.version === currentVersion || compareSemver(result.version, currentVersion) <= 0) {
    return { status: 'up-to-date' };
  }
  return { status: 'available', version: result.version };
}

export function deriveUpdateCheckState(
  npmStatus: NpmVersionStatus,
): { upToDate: boolean; channelTargetMissing: boolean; latestVersion: string } | null {
  switch (npmStatus.status) {
    case 'error':
      return null;
    case 'no-target':
      return { upToDate: true, channelTargetMissing: true, latestVersion: '' };
    case 'up-to-date':
      return { upToDate: true, channelTargetMissing: false, latestVersion: '' };
    case 'available':
      return {
        upToDate: false,
        channelTargetMissing: false,
        latestVersion: npmStatus.version,
      };
    default: {
      const exhaustive: never = npmStatus;
      return exhaustive;
    }
  }
}
