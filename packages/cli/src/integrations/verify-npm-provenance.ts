// Publish-time provenance + repository binding check for cli-kind installs.
//
// The bounty-registry workflow claims a "reviewed commit" for each entry, but
// `npm install --global <pkg>@<version>` pulls a tarball from the npm registry
// with no intrinsic link back to that commit. The binding that DOES exist lives
// in the tarball's publish-time provenance attestation (npm's sigstore OIDC
// bundle, produced by a CI build that signs in the git revision). So before
// running npm install we shell out to `npm view` and require:
//
//   1. the pinned version resolves to a real tarball,
//   2. that tarball has a provenance attestation attached,
//   3. it has a registry signature,
//   4. the package's declared repository.url matches the entry's `repo`.
//
// Any of those missing → we refuse to install. A user who is deliberately
// operating on an un-attested package (e.g. first-party dev tarball mid-PR)
// can escape via `--no-verify-provenance`.
//
// We don't parse / verify the sigstore bundle itself here — `npm audit
// signatures` does that, and `npm install --global` with npm ≥ 9 also exits
// non-zero when signature verification fails in certain configs. We only need
// to confirm the artifact claims to be attested and points at the right repo;
// npm does the cryptographic verification on install.

import { spawn } from 'node:child_process';

export interface ProvenanceCheckResult {
  ok: boolean;
  found: {
    versionResolvable: boolean;
    hasProvenance: boolean;
    hasRegistrySignature: boolean;
    repositoryUrl?: string;
  };
  expectedRepo: string;
  reasons: string[];
}

// Uses the system `npm` to query published metadata. We never touch on-disk
// state here — `npm view` is a read-only registry probe.
export async function verifyNpmProvenance(
  pkg: string,
  version: string,
  expectedRepo: string,
): Promise<ProvenanceCheckResult> {
  const meta = await npmView(pkg, version);
  const reasons: string[] = [];

  if (meta === null) {
    reasons.push(`npm view ${pkg}@${version} returned no metadata — package or version not found on the configured registry.`);
    return {
      ok: false,
      found: { versionResolvable: false, hasProvenance: false, hasRegistrySignature: false },
      expectedRepo,
      reasons,
    };
  }

  const dist = (meta.dist as Record<string, unknown> | undefined) ?? undefined;
  const hasRegistrySignature = !!(dist && Array.isArray(dist.signatures) && dist.signatures.length > 0);
  const hasProvenance = !!(
    dist && typeof dist.attestations === 'object' && dist.attestations !== null
  );
  const repoUrl = extractRepoUrl(meta);
  const normalizedPublished = normalizeRepoUrl(repoUrl);
  const normalizedExpected = normalizeRepoUrl(expectedRepo);
  const repoMatches =
    !!normalizedPublished && !!normalizedExpected && normalizedPublished === normalizedExpected;

  if (!hasProvenance) {
    reasons.push(`npm tarball for ${pkg}@${version} lacks a publish-time provenance attestation (dist.attestations).`);
  }
  if (!hasRegistrySignature) {
    reasons.push(`npm tarball for ${pkg}@${version} lacks a registry signature (dist.signatures).`);
  }
  if (!repoMatches) {
    reasons.push(
      `npm repository.url (${repoUrl ?? 'missing'}) does not match the registry entry's repo (${expectedRepo}). ` +
        `An attested build pointing at a different repo is not proof of provenance for this entry.`,
    );
  }

  return {
    ok: hasProvenance && hasRegistrySignature && repoMatches,
    found: {
      versionResolvable: true,
      hasProvenance,
      hasRegistrySignature,
      repositoryUrl: repoUrl,
    },
    expectedRepo,
    reasons,
  };
}

function extractRepoUrl(meta: Record<string, unknown>): string | undefined {
  const repo = meta.repository;
  if (typeof repo === 'string') return repo;
  if (repo && typeof repo === 'object') {
    const url = (repo as Record<string, unknown>).url;
    if (typeof url === 'string') return url;
  }
  return undefined;
}

// Collapse the many equivalent git URL shapes (git+https://, git://, trailing
// .git, trailing slashes, protocol prefixes) into a host+path key so a direct
// string compare is meaningful.
export function normalizeRepoUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let s = url.trim();
  s = s.replace(/^git\+/, '');
  s = s.replace(/^git:\/\//, 'https://');
  s = s.replace(/^ssh:\/\/git@/, 'https://');
  s = s.replace(/^git@([^:]+):/, 'https://$1/');
  s = s.replace(/\.git$/, '');
  try {
    const u = new URL(s);
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    return `${u.hostname.toLowerCase()}${path}`;
  } catch {
    return s.toLowerCase();
  }
}

async function npmView(pkg: string, version: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['view', `${pkg}@${version}`, '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0 || !out.trim()) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(out);
        if (Array.isArray(parsed)) {
          // Multiple versions matched — take the last one (latest that still
          // satisfies the pin). For an exact-version pin this is always size 1.
          resolve((parsed[parsed.length - 1] as Record<string, unknown>) ?? null);
        } else if (parsed && typeof parsed === 'object') {
          resolve(parsed as Record<string, unknown>);
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });
  });
}
