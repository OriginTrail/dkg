// Registry client: talks to the public DKG integration registry
// (https://github.com/OriginTrail/dkg-integrations) over HTTPS.
//
// List goes via the GitHub Contents API; individual entries go via raw.githubusercontent.com.
// Both can be overridden via DKG_REGISTRY_INDEX_URL / DKG_REGISTRY_RAW_BASE for offline
// tests and staging registries. If GITHUB_TOKEN is set we pass it so unauthenticated
// rate limits (60 req/hr) don't hit contributor shells behind shared NATs — but only
// when the target host is GitHub-owned. A user pointing DKG_REGISTRY_RAW_BASE at a
// staging server must opt in explicitly via DKG_REGISTRY_TOKEN; otherwise a developer's
// ambient GITHUB_TOKEN would leak to a non-GitHub endpoint.

import { IntegrationEntry, isIntegrationEntry } from './schema.js';

const DEFAULT_INDEX_URL =
  'https://api.github.com/repos/OriginTrail/dkg-integrations/contents/integrations?ref=main';
const DEFAULT_RAW_BASE =
  'https://raw.githubusercontent.com/OriginTrail/dkg-integrations/main/integrations';

export interface RegistryConfig {
  indexUrl: string;
  rawBase: string;
  githubToken?: string;
  customRegistryToken?: string;
}

export function resolveRegistryConfig(env: NodeJS.ProcessEnv = process.env): RegistryConfig {
  return {
    indexUrl: env.DKG_REGISTRY_INDEX_URL ?? DEFAULT_INDEX_URL,
    rawBase: env.DKG_REGISTRY_RAW_BASE ?? DEFAULT_RAW_BASE,
    githubToken: env.GITHUB_TOKEN || env.GH_TOKEN,
    customRegistryToken: env.DKG_REGISTRY_TOKEN,
  };
}

export function isGithubHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      h === 'api.github.com' ||
      h === 'raw.githubusercontent.com' ||
      h === 'github.com' ||
      h.endsWith('.github.com')
    );
  } catch {
    return false;
  }
}

function headers(cfg: RegistryConfig, targetUrl: string, accept: string): HeadersInit {
  const h: Record<string, string> = {
    Accept: accept,
    'User-Agent': 'dkg-cli-integrations/1',
  };
  if (isGithubHost(targetUrl)) {
    if (cfg.githubToken) h.Authorization = `Bearer ${cfg.githubToken}`;
  } else if (cfg.customRegistryToken) {
    h.Authorization = `Bearer ${cfg.customRegistryToken}`;
  }
  return h;
}

// Lists every *.json entry in the registry except the TEMPLATE.json scaffold.
// Returns just the slugs; callers fetch full entries on demand.
export async function listSlugs(cfg: RegistryConfig): Promise<string[]> {
  const res = await fetch(cfg.indexUrl, { headers: headers(cfg, cfg.indexUrl, 'application/vnd.github+json') });
  if (!res.ok) {
    throw new Error(
      `Failed to list registry entries: ${res.status} ${res.statusText}. ` +
        `Check that the registry is reachable (${cfg.indexUrl}) and, if rate-limited, set GITHUB_TOKEN.`,
    );
  }
  const body = (await res.json()) as Array<{ name: string; type?: string }>;
  if (!Array.isArray(body)) {
    throw new Error(`Registry index did not return an array. Got: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body
    .filter((f) => f.type !== 'dir' && f.name.endsWith('.json') && f.name !== 'TEMPLATE.json')
    .map((f) => f.name.replace(/\.json$/, ''))
    .sort();
}

export async function fetchEntry(slug: string, cfg: RegistryConfig): Promise<IntegrationEntry> {
  // Slug constraints mirror the registry schema; guard against directory-traversal sneaking in.
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug)) {
    throw new Error(`Invalid slug "${slug}". Expected lowercase, digits, and hyphens only.`);
  }
  const url = `${cfg.rawBase}/${slug}.json`;
  const res = await fetch(url, { headers: headers(cfg, url, 'application/json') });
  if (res.status === 404) {
    throw new Error(`Integration "${slug}" not found in the registry (${url}).`);
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch ${slug}: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  if (!isIntegrationEntry(body)) {
    throw new Error(
      `Registry entry for "${slug}" does not match the expected shape. ` +
        `The CLI may be out of date; check your dkg-integrations schema version.`,
    );
  }
  // Guard against a registry file being a copy/rename artifact from another entry:
  // `dkg integration install foo` must never return an entry that declares a different
  // slug (and therefore a different npm package / install surface).
  if (body.slug !== slug) {
    throw new Error(
      `Registry entry at "${slug}.json" declares slug "${body.slug}". ` +
        `Refusing to install: filename and declared slug must match.`,
    );
  }
  return body;
}

export interface FetchAllResult {
  entries: IntegrationEntry[];
  failures: Array<{ slug: string; error: string }>;
}

// Best-effort bulk fetch. A malformed or temporarily-unreachable entry must
// not take down the entire `dkg integration list` — a single bad community
// submission shouldn't hide the verified/featured entries users actually
// care about. We collect per-entry failures and return them alongside the
// good entries; the caller decides how to surface them.
export async function fetchAllEntries(cfg: RegistryConfig): Promise<FetchAllResult> {
  const slugs = await listSlugs(cfg);
  const entries: IntegrationEntry[] = [];
  const failures: Array<{ slug: string; error: string }> = [];
  await Promise.all(
    slugs.map(async (s) => {
      try {
        entries.push(await fetchEntry(s, cfg));
      } catch (err) {
        failures.push({ slug: s, error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );
  entries.sort((a, b) => a.slug.localeCompare(b.slug));
  failures.sort((a, b) => a.slug.localeCompare(b.slug));
  return { entries, failures };
}
