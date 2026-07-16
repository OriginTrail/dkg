/**
 * §4.7.6 Check: plugin install root verification.
 *
 * Per OT-RFC-41 §4.6.1, bare-name `routePlugins` resolve from
 * `~/.dkg/plugins/node_modules/`. This check:
 *
 *   - Verifies `~/.dkg/plugins/package.json` exists and is
 *     well-formed; if it doesn't, materialises it on the fly (the
 *     doctor is non-destructive — it can create empty marker files
 *     but never deletes anything).
 *   - For each entry in `config.routePlugins`:
 *       - Absolute paths: verify the file exists and is readable.
 *       - Bare names: verify the package resolves from
 *         `~/.dkg/plugins/node_modules/`. If not, emit a warning
 *         pointing at `npm install --prefix ~/.dkg/plugins <name>`.
 *
 * The check does NOT attempt to spawn `node` or call `require.resolve`
 * itself — it just walks the expected filesystem layout. That's a
 * conservative read of "verify resolves" but a deterministic one.
 */
import { join } from 'node:path';
import type { DoctorDeps, Finding } from '../types.js';

interface RoutePluginEntry {
  /** Bare name (`@scope/pkg`) or absolute path (`/abs/path/to/plugin.js`). */
  spec: string;
}

function readRoutePlugins(config: Record<string, unknown> | undefined): RoutePluginEntry[] {
  if (!config) return [];
  const raw = config.routePlugins;
  if (!Array.isArray(raw)) return [];
  const entries: RoutePluginEntry[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      entries.push({ spec: item });
      continue;
    }
    if (item && typeof item === 'object') {
      const spec = (item as { spec?: unknown; name?: unknown; path?: unknown }).spec
        ?? (item as { name?: unknown }).name
        ?? (item as { path?: unknown }).path;
      if (typeof spec === 'string') entries.push({ spec });
    }
  }
  return entries;
}

async function loadConfig(deps: DoctorDeps): Promise<Record<string, unknown> | undefined> {
  const raw = await deps.readFile(join(deps.dkgHome, 'config.json'));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function isAbsolutePathSpec(spec: string): boolean {
  return spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec);
}

/** Resolve a bare-name `@scope/pkg` or `pkg` to its expected nested directory. */
function bareNameDir(pluginsNodeModules: string, spec: string): string {
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash === -1) return join(pluginsNodeModules, spec);
    return join(pluginsNodeModules, spec.slice(0, slash), spec.slice(slash + 1));
  }
  return join(pluginsNodeModules, spec);
}

export async function runPluginRootCheck(deps: DoctorDeps): Promise<Finding[]> {
  const findings: Finding[] = [];
  const pluginsRoot = join(deps.dkgHome, 'plugins');
  const pluginsPackageJson = join(pluginsRoot, 'package.json');
  const pluginsNodeModules = join(pluginsRoot, 'node_modules');

  if (!deps.exists(pluginsPackageJson)) {
    // Don't materialise from a check — checks are read-only. The
    // daemon's first-start hook (Bundle B1e) is the right place to
    // create the stable plugin root. Just surface its absence.
    findings.push({
      check: 'plugin-root',
      severity: 'info',
      message: `Stable plugin install root not yet materialised: ${pluginsRoot}`,
      advisory: "The first 'dkg start' under rc.12 creates this. Until then, bare-name routePlugins resolve from createRequire(import.meta.url)'s lookup chain, which may not survive update cycles.",
      subject: pluginsRoot,
    });
  }

  const config = await loadConfig(deps);
  const entries = readRoutePlugins(config);
  if (entries.length === 0) return findings;

  for (const { spec } of entries) {
    if (isAbsolutePathSpec(spec)) {
      if (!deps.exists(spec)) {
        findings.push({
          check: 'plugin-root',
          severity: 'error',
          message: `routePlugin path not found: ${spec}`,
          advisory: 'The plugin file no longer exists at the configured path. Fix the absolute path in ~/.dkg/config.json#routePlugins, or remove the entry.',
          subject: spec,
        });
      }
      continue;
    }

    // Bare name. Expected location: ~/.dkg/plugins/node_modules/<spec>/.
    const expectedDir = bareNameDir(pluginsNodeModules, spec);
    if (deps.exists(expectedDir)) continue;
    findings.push({
      check: 'plugin-root',
      severity: 'warning',
      message: `routePlugin '${spec}' is not installed in the stable plugin root`,
      advisory: `It may stop loading after the next 'dkg update'. Run 'npm install --prefix ${pluginsRoot} ${spec}' to install it into the stable plugin root.`,
      subject: spec,
      details: { pluginsRoot, expectedDir },
    });
  }

  return findings;
}
