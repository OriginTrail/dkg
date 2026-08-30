import {
  compare as compareCanonicalSemver,
  prerelease as canonicalPrerelease,
  valid as validCanonicalSemver,
} from 'semver';

import { CLI_NPM_PACKAGE } from '../config.js';
import { _autoUpdateIo } from '../daemon/manifest.js';

export type NpmVersionResult =
  | { version: string; error?: false }
  | { version: null; error: true }
  | { version: null; error: false };

export type NpmDistTagsResult =
  | { tags: Record<string, string>; error?: false }
  | { tags: null; error: true };

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
  | { status: 'registry-error'; reason: string };

/** Canonical npm-registry boundary shared by automatic and explicit updates. */
export async function fetchNpmDistTags(
  log: (message: string) => void,
): Promise<NpmDistTagsResult> {
  const { fetch } = _autoUpdateIo;
  const url = `https://registry.npmjs.org/${CLI_NPM_PACKAGE}`;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      log(`Auto-update (npm): registry returned ${response.status} for ${CLI_NPM_PACKAGE}`);
      return { tags: null, error: true };
    }
    const tags = decodeNpmDistTags(await response.json());
    return tags ? { tags } : { tags: null, error: true };
  } catch (err: any) {
    log(`Auto-update (npm): registry check failed (${err?.message ?? String(err)})`);
    return { tags: null, error: true };
  }
}

export async function resolveNpmDistTag(
  tag: string,
  log: (message: string) => void,
  deps: { fetchNpmDistTags?: typeof fetchNpmDistTags } = {},
): Promise<NpmVersionResult> {
  const result = await (deps.fetchNpmDistTags ?? fetchNpmDistTags)(log);
  if (result.error) return { version: null, error: true };
  const version = Object.hasOwn(result.tags, tag) ? result.tags[tag] : null;
  return typeof version === 'string' && isValidSemver(version)
    ? { version }
    : { version: null, error: false };
}

/**
 * Classify an explicit update target. Dist-tags resolve to one concrete version;
 * ranges, aliases, unknown tags, and registry failures fail closed.
 */
export async function resolveExplicitNpmUpdateTarget(
  target: string,
  allowPrerelease: boolean,
  log: (message: string) => void,
  deps: { resolveNpmDistTag?: typeof resolveNpmDistTag } = {},
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

  const resolved = await (deps.resolveNpmDistTag ?? resolveNpmDistTag)(normalizedTarget, log);
  if (resolved.error) {
    return {
      status: 'registry-error',
      reason: `could not resolve dist-tag "${normalizedTarget}" against the npm registry — retry or pass an explicit version`,
    };
  }
  if (!resolved.version || !isValidSemver(resolved.version)) {
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
export async function resolveLatestNpmVersion(
  log: (message: string) => void,
  allowPrerelease = true,
  channel?: string,
): Promise<NpmVersionResult> {
  const result = await fetchNpmDistTags(log);
  if (result.error) return { version: null, error: true };
  const tags = result.tags;

  try {
    if (channel) {
      const pinned = tags[channel] ?? null;
      if (!pinned) {
        log(`Auto-update (npm): channel "${channel}" has no published version, skipping`);
        return { version: null, error: false };
      }
      if (!isValidSemver(pinned)) {
        log(`Auto-update (npm): channel "${channel}" → "${pinned}" is not a valid semver, skipping`);
        return { version: null, error: false };
      }
      if (!allowPrerelease && isPrerelease(pinned)) {
        log(`Auto-update (npm): channel "${channel}" points at a pre-release and allowPrerelease=false, skipping`);
        return { version: null, error: false };
      }
      return { version: pinned };
    }

    const stable = tags.latest ?? null;
    if (!allowPrerelease) {
      if (stable && isValidSemver(stable) && !isPrerelease(stable)) return { version: stable };
      log('Auto-update (npm): latest dist-tag is a pre-release and allowPrerelease=false, skipping');
      return { version: null, error: false };
    }

    const candidates = ([stable, tags.dev, tags.beta, tags.next].filter(
      Boolean,
    ) as string[]).filter(isValidSemver);
    if (candidates.length === 0) return { version: null, error: false };
    candidates.sort((a, b) => compareSemver(b, a));
    return { version: candidates[0] };
  } catch {
    return { version: null, error: true };
  }
}

export function compareSemver(a: string, b: string): number {
  const validA = validCanonicalSemver(a.trim());
  const validB = validCanonicalSemver(b.trim());
  if (validA === null || validB === null) return Number.NaN;
  return compareCanonicalSemver(validA, validB);
}
