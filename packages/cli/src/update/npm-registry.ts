import {
  compare as compareCanonicalSemver,
  prerelease as canonicalPrerelease,
  valid as validCanonicalSemver,
} from 'semver';

import { CLI_NPM_PACKAGE } from '../config.js';

export type NpmRegistryFailure =
  | { kind: 'http-error'; status: number }
  | { kind: 'invalid-response' }
  | { kind: 'transport-error'; message: string };

export type NpmRegistryFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export type NpmRegistryDeps = { fetch?: NpmRegistryFetch };

export type NpmVersionResolution =
  | { status: 'resolved'; version: string }
  | { status: 'no-target'; reason: NpmVersionNoTargetReason }
  | { status: 'error'; failure: NpmRegistryFailure };

export type NpmDistTagResult =
  | { status: 'resolved'; version: string }
  | { status: 'not-found' }
  | { status: 'error'; failure: NpmRegistryFailure };

export type NpmVersionNoTargetReason =
  | { kind: 'missing-channel'; channel: string }
  | { kind: 'invalid-channel-version'; channel: string; version: string }
  | { kind: 'prerelease-channel'; channel: string; version: string }
  | { kind: 'unacceptable-latest'; version: string | null }
  | { kind: 'no-valid-candidates' };

export type NpmDistTagsResult =
  | { status: 'ok'; tags: Record<string, string> }
  | { status: 'error'; failure: NpmRegistryFailure };

export function decodeNpmDistTags(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const distTags = (value as Record<string, unknown>)['dist-tags'];
  if (!distTags || typeof distTags !== 'object' || Array.isArray(distTags)) return null;
  return Object.fromEntries(
    Object.entries(distTags).filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string'),
  );
}

export function isValidSemver(value: string): boolean {
  const candidate = value.trim();
  return !candidate.startsWith('v') && validCanonicalSemver(candidate) !== null;
}

export function isPrerelease(value: string): boolean {
  return canonicalPrerelease(value.trim()) !== null;
}

export type ExplicitNpmUpdateTargetDecision =
  | { status: 'allowed'; version: string }
  | { status: 'rejected'; reason: string }
  | { status: 'registry-error'; reason: string; failure: NpmRegistryFailure };

/** Canonical npm-registry boundary shared by automatic and explicit updates. */
export async function fetchNpmDistTags(
  deps: NpmRegistryDeps = {},
): Promise<NpmDistTagsResult> {
  const url = `https://registry.npmjs.org/${CLI_NPM_PACKAGE}`;
  try {
    const response = await (deps.fetch ?? globalThis.fetch)(url, {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return { status: 'error', failure: { kind: 'http-error', status: response.status } };
    }
    const tags = decodeNpmDistTags(await response.json());
    return tags
      ? { status: 'ok', tags }
      : { status: 'error', failure: { kind: 'invalid-response' } };
  } catch (err: any) {
    return {
      status: 'error',
      failure: { kind: 'transport-error', message: err?.message ?? String(err) },
    };
  }
}

export async function resolveNpmDistTag(
  tag: string,
  deps: NpmRegistryDeps & {
    fetchNpmDistTags?: () => Promise<NpmDistTagsResult>;
  } = {},
): Promise<NpmDistTagResult> {
  const result = await (deps.fetchNpmDistTags ?? (() => fetchNpmDistTags(deps)))();
  if (result.status === 'error') {
    return { status: 'error', failure: result.failure };
  }
  const version = Object.hasOwn(result.tags, tag) ? result.tags[tag] : null;
  return typeof version === 'string' && isValidSemver(version)
    ? { status: 'resolved', version }
    : { status: 'not-found' };
}

/**
 * Classify an explicit update target. Dist-tags resolve to one concrete version;
 * ranges, aliases, unknown tags, and registry failures fail closed.
 */
export async function resolveExplicitNpmUpdateTarget(
  target: string,
  allowPrerelease: boolean,
  deps: NpmRegistryDeps & {
    resolveNpmDistTag?: typeof resolveNpmDistTag;
  } = {},
): Promise<ExplicitNpmUpdateTargetDecision> {
  const normalizedTarget = target.trim().replace(/^v/, '');
  const exactVersion = validCanonicalSemver(normalizedTarget);
  if (exactVersion !== null) {
    if (!allowPrerelease && canonicalPrerelease(normalizedTarget) !== null) {
      return {
        status: 'rejected',
        reason: `target "${normalizedTarget}" is a pre-release and this node has allowPrerelease=false — re-run with --allow-prerelease to override`,
      };
    }
    return { status: 'allowed', version: normalizedTarget };
  }

  const resolved = deps.resolveNpmDistTag
    ? await deps.resolveNpmDistTag(normalizedTarget)
    : await resolveNpmDistTag(normalizedTarget, deps);
  if (resolved.status === 'error') {
    return {
      status: 'registry-error',
      reason: `could not resolve dist-tag "${normalizedTarget}" against the npm registry — retry or pass an explicit version`,
      failure: resolved.failure,
    };
  }
  if (resolved.status === 'not-found') {
    return {
      status: 'rejected',
      reason: `target "${normalizedTarget}" is not an exact semantic version or a published npm dist-tag`,
    };
  }
  if (!allowPrerelease && isPrerelease(resolved.version)) {
    return {
      status: 'rejected',
      reason: `dist-tag "${normalizedTarget}" resolves to pre-release "${resolved.version}" and this node has allowPrerelease=false — re-run with --allow-prerelease to override`,
    };
  }
  return { status: 'allowed', version: resolved.version };
}

/** Select the version followed by automatic polling or an explicit channel pin. */
export async function resolveNpmVersionTarget(
  allowPrerelease = true,
  channel?: string,
  deps: NpmRegistryDeps & {
    fetchNpmDistTags?: () => Promise<NpmDistTagsResult>;
  } = {},
): Promise<NpmVersionResolution> {
  const result = await (deps.fetchNpmDistTags ?? (() => fetchNpmDistTags(deps)))();
  if (result.status === 'error') {
    return { status: 'error', failure: result.failure };
  }
  const tags = result.tags;

  if (channel) {
    const pinned = Object.hasOwn(tags, channel) ? tags[channel] : null;
    if (typeof pinned !== 'string') {
      return { status: 'no-target', reason: { kind: 'missing-channel', channel } };
    }
    if (!isValidSemver(pinned)) {
      return {
        status: 'no-target',
        reason: { kind: 'invalid-channel-version', channel, version: pinned },
      };
    }
    if (!allowPrerelease && isPrerelease(pinned)) {
      return {
        status: 'no-target',
        reason: { kind: 'prerelease-channel', channel, version: pinned },
      };
    }
    return { status: 'resolved', version: pinned };
  }

  const stable = tags.latest ?? null;
  if (!allowPrerelease) {
    if (stable && isValidSemver(stable) && !isPrerelease(stable)) {
      return { status: 'resolved', version: stable };
    }
    return {
      status: 'no-target',
      reason: { kind: 'unacceptable-latest', version: stable },
    };
  }

  const candidates = ([stable, tags.dev, tags.beta, tags.next].filter(
    Boolean,
  ) as string[]).filter(isValidSemver);
  if (candidates.length === 0) {
    return { status: 'no-target', reason: { kind: 'no-valid-candidates' } };
  }
  candidates.sort((a, b) => compareSemver(b, a));
  return { status: 'resolved', version: candidates[0] };
}

export function compareSemver(a: string, b: string): number {
  const validA = validCanonicalSemver(a.trim());
  const validB = validCanonicalSemver(b.trim());
  if (validA === null || validB === null) return Number.NaN;
  return compareCanonicalSemver(validA, validB);
}
