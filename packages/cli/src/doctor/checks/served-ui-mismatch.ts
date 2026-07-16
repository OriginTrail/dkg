/**
 * §4.7.5 Check: served-UI / source mismatch.
 *
 * Detects "the browser is showing an old UI" — a real pain point
 * reported during local DKG / Hermes / OpenClaw work where a service
 * worker or PWA cache shows a UI version that doesn't match the
 * active code.
 *
 * Heuristic:
 *   - Fetch `http://127.0.0.1:<apiPort>/ui/`. Extract a version
 *     fingerprint from `<meta name="version" content="…">` if
 *     present, OR the first hashed asset URL in a `<script src="…">`
 *     / `<link href="…">` tag (Vite-style filename hashes are the
 *     fingerprint for an immutable bundle).
 *   - Read the installed UI package's `package.json#version` from
 *     the appropriate location:
 *       - Edge: `<npmGlobalDkg>/node_modules/@origintrail-official/dkg-node-ui/package.json`
 *       - Core: `<active-slot>/node_modules/@origintrail-official/dkg-node-ui/package.json`
 *   - Mismatch → warning with the hard-refresh / clear-service-worker
 *     advisory.
 *
 * Skipped (with `info` reason) when the daemon is unreachable or the
 * UI route returns non-200.
 */
import { join } from 'node:path';
import type { DoctorDeps, Finding, StateSummary } from '../types.js';

async function readUiPackageVersion(deps: DoctorDeps, state: StateSummary): Promise<{ version: string | null; sourcePath: string | null }> {
  let basePath: string | null = null;
  if (state.daemon.nodeRole === 'core' && state.paths.activeSlot) {
    basePath = join(deps.dkgHome, 'releases', state.paths.activeSlot);
  } else if (state.paths.npmGlobalDkg) {
    basePath = state.paths.npmGlobalDkg;
  }
  if (!basePath) return { version: null, sourcePath: null };

  // Try `<base>/node_modules/@origintrail-official/dkg-node-ui/package.json`
  // first (npm layout), then `<base>/packages/node-ui/package.json` (git
  // layout — applies to monorepo contributor runs that take this code path
  // by mistake; informational only).
  const candidates = [
    join(basePath, 'node_modules', '@origintrail-official', 'dkg-node-ui', 'package.json'),
    join(basePath, 'packages', 'node-ui', 'package.json'),
  ];

  for (const candidate of candidates) {
    if (!deps.exists(candidate)) continue;
    const raw = await deps.readFile(candidate);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const v = (parsed as { version?: unknown }).version;
      if (typeof v === 'string' && v.length > 0) {
        return { version: v, sourcePath: candidate };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return { version: null, sourcePath: null };
}

function extractServedVersion(html: string): { kind: 'meta' | 'asset-hash' | null; value: string | null } {
  // Prefer <meta name="version" content="…"> — explicit and authoritative.
  const metaMatch = html.match(/<meta[^>]*name=["']version["'][^>]*content=["']([^"']+)["']/i);
  if (metaMatch) return { kind: 'meta', value: metaMatch[1] };

  // Fallback: first hashed asset URL in <script src="…"> or <link href="…">.
  // Vite produces `foo-DEADBEEF.js`; Webpack produces `foo.deadbeef.js`. Both
  // count as fingerprints — we just need a stable per-build string.
  const scriptMatch = html.match(/<script[^>]*src=["']([^"']+\.js)["']/i);
  if (scriptMatch) {
    const filenameMatch = scriptMatch[1].match(/([\w.\-_]+\.js)$/);
    if (filenameMatch && /[A-Fa-f0-9]{6,}/.test(filenameMatch[1])) {
      return { kind: 'asset-hash', value: filenameMatch[1] };
    }
  }
  return { kind: null, value: null };
}

export async function runServedUiMismatchCheck(
  deps: DoctorDeps,
  state: StateSummary,
): Promise<Finding[]> {
  const findings: Finding[] = [];

  if (!state.daemon.version) {
    findings.push({
      check: 'served-ui-mismatch',
      severity: 'info',
      message: 'Served-UI check skipped: daemon unreachable',
      advisory: "Start the daemon ('dkg start') and re-run 'dkg doctor' to enable this check.",
    });
    return findings;
  }

  const uiUrl = `http://127.0.0.1:${deps.apiPort}/ui/`;
  const html = await deps.fetchText(uiUrl);
  if (!html) {
    findings.push({
      check: 'served-ui-mismatch',
      severity: 'info',
      message: 'Served-UI check skipped: /ui/ returned no HTML',
      advisory: 'The daemon is up but the node UI is not serving the expected HTML index. May be intentional (UI disabled) or a config issue.',
    });
    return findings;
  }

  const served = extractServedVersion(html);
  const installed = await readUiPackageVersion(deps, state);

  if (served.value === null) {
    findings.push({
      check: 'served-ui-mismatch',
      severity: 'info',
      message: 'Served-UI check skipped: no version fingerprint found in served HTML',
      advisory: 'The UI does not expose <meta name="version"> nor a hashed asset URL. Consider adding one to make this check meaningful.',
    });
    return findings;
  }

  if (installed.version === null) {
    findings.push({
      check: 'served-ui-mismatch',
      severity: 'info',
      message: 'Served-UI check skipped: cannot locate installed UI package.json',
      details: {
        servedFingerprint: served.value,
        servedKind: served.kind,
      },
    });
    return findings;
  }

  // If served-version is a meta tag, compare against installed version
  // string directly. If it's an asset-hash, just record it for the
  // operator — there's no clean way to map hash→version without
  // shipping a hash index, which is out of scope for this RFC. The
  // asset-hash branch is informational only.
  if (served.kind === 'meta') {
    if (served.value !== installed.version) {
      findings.push({
        check: 'served-ui-mismatch',
        severity: 'warning',
        message: `Served UI version (${served.value}) does not match installed (${installed.version})`,
        advisory: "Likely a stale browser / PWA / service-worker cache. Hard-refresh (Cmd+Shift+R) or clear the service worker. Also confirm the daemon was restarted after the UI package was updated.",
        details: {
          servedVersion: served.value,
          installedVersion: installed.version,
          installedSource: installed.sourcePath,
        },
      });
    }
  } else {
    findings.push({
      check: 'served-ui-mismatch',
      severity: 'info',
      message: `Served UI fingerprint: ${served.value} (installed UI version: ${installed.version})`,
      advisory: 'Asset-hash-only fingerprints cannot be cross-referenced against package versions. If the UI looks stale, hard-refresh (Cmd+Shift+R) and clear service workers.',
      details: {
        servedFingerprint: served.value,
        installedVersion: installed.version,
        installedSource: installed.sourcePath,
      },
    });
  }

  return findings;
}
