import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
import type { RoutePlugin } from './plugin-api.js';

/**
 * Loader's own `createRequire` anchor. Used as a fallback when no
 * stable plugin root is supplied (back-compat for callers that
 * predate Bundle B1e — e.g. unit tests).
 */
const require_ = createRequire(import.meta.url);

/**
 * Ensure `<dkgHome>/plugins/package.json` exists so the stable
 * plugin install root has a valid `createRequire` anchor. Per
 * OT-RFC-41 §4.6.1 / Bundle B1e this is the long-term resolution
 * root for bare-name `routePlugins`; it survives Core slot swaps
 * AND Edge npm reinstalls.
 *
 * Idempotent. Failures are non-fatal — the loader falls back to
 * the daemon-local `import.meta.url` anchor below if the stable
 * root is unavailable for any reason.
 *
 * Returns the absolute path to the materialised `package.json`,
 * or `null` if the write failed.
 */
export function ensureStablePluginRoot(dkgHome: string): string | null {
  try {
    const pluginsDir = join(dkgHome, 'plugins');
    if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true });
    const pkgPath = join(pluginsDir, 'package.json');
    if (!existsSync(pkgPath)) {
      writeFileSync(
        pkgPath,
        JSON.stringify(
          {
            name: 'dkg-plugin-root',
            private: true,
            description:
              'Stable bare-name resolution root for DKG route plugins. ' +
              "Run `npm install --prefix ~/.dkg/plugins <plugin>` to install. " +
              'See OT-RFC-41 §4.6.1.',
          },
          null,
          2,
        ) + '\n',
      );
    }
    return pkgPath;
  } catch {
    return null;
  }
}

/**
 * Build a stable-root require resolver. Per OT-RFC-41 §4.6.1, this
 * is the PRIMARY anchor for bare-name `routePlugins` so the resolver
 * stays at a stable filesystem location across Core slot swaps and
 * Edge npm reinstalls.
 *
 * Returns `null` if `~/.dkg/plugins/package.json` is absent and could
 * not be materialised (extremely rare — typically a read-only home
 * directory). Callers fall back to the daemon-local anchor in that
 * case.
 */
function buildStableRootRequire(dkgHome: string): NodeJS.Require | null {
  const pkgPath = ensureStablePluginRoot(dkgHome);
  if (!pkgPath) return null;
  try {
    return createRequire(pathToFileURL(pkgPath).href);
  } catch {
    return null;
  }
}

// Only retry CJS when ESM failed because no `import` condition matched; everything else (SyntaxError,
// missing transitive `ERR_MODULE_NOT_FOUND`, ...) bubbles up so authors see the broken build.
const RESOLVER_FAILURE_CODES = new Set([
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
]);
const RESOLVER_FAILURE_MESSAGE_PATTERNS = [
  /No known conditions for/i,
  /No "exports" main defined/i,
  /Failed to resolve entry for package/i,
];
function isResolverFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && RESOLVER_FAILURE_CODES.has(code)) return true;
  const message = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== 'string') return false;
  return RESOLVER_FAILURE_MESSAGE_PATTERNS.some((p) => p.test(message));
}

async function importSpec(
  spec: string,
  stableRootRequire: NodeJS.Require | null,
): Promise<unknown> {
  if (isAbsolute(spec)) {
    return import(pathToFileURL(spec).href);
  }
  // Reject relative specs — Node resolves them relative to this loader source
  // (packages/cli/dist/daemon/), not to ~/.dkg/config.json. See ADR 0001.
  // Separator-agnostic so Windows-style `.\foo`, `..\foo` are also caught.
  if (/^\.{1,2}[\\/]/.test(spec)) {
    throw new Error(
      `relative paths are not supported in routePlugins; use an absolute filesystem path or a resolvable package name (got "${spec}")`,
    );
  }
  // Bare specifier (OT-RFC-41 §4.6.1 / Bundle B1e):
  //   1. Resolve from ~/.dkg/plugins (stable root) if available.
  //      This survives Core slot swaps AND Edge npm reinstalls —
  //      both of which can change the daemon-local node_modules
  //      under it.
  //   2. Fall back to ESM `import(spec)` (daemon-local node_modules,
  //      then ambient global). Preserves back-compat for plugins
  //      installed via the legacy `npm install -g` flow.
  //   3. On ESM resolver-shape failure, retry via the loader-local
  //      `createRequire` (final fallback for CJS-only packages).
  if (stableRootRequire) {
    let resolved: string | undefined;
    try {
      resolved = stableRootRequire.resolve(spec);
    } catch {
      // Stable root either does not have the plugin installed yet
      // or hit a resolver-shape edge case. Fall through to ESM
      // import — the loader-level try/catch surfaces the failure
      // with a clear spec name if both anchors miss.
    }
    if (resolved) {
      // Once the stable root resolves the plugin, load/evaluation errors
      // are authoritative and must not fall through to an older daemon-local
      // or global install of the same package.
      return await import(pathToFileURL(resolved).href);
    }
  }
  try {
    return await import(spec);
  } catch (esmErr) {
    if (!isResolverFailure(esmErr)) throw esmErr;
    let resolved: string;
    try {
      resolved = require_.resolve(spec);
    } catch {
      throw esmErr;
    }
    // CJS resolve succeeded — any error from loading the resolved file is a real
    // evaluation failure (SyntaxError, missing transitive) and must bubble up, not be rewritten as esmErr.
    return await import(pathToFileURL(resolved).href);
  }
}

function isRoutePlugin(value: unknown): value is RoutePlugin {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && v.name.length > 0 && typeof v.handle === 'function';
}

function pickCandidate(mod: unknown): unknown {
  if (mod && typeof mod === 'object') {
    const m = mod as Record<string, unknown>;
    if (isRoutePlugin(m.plugin)) return m.plugin;
    if (isRoutePlugin(m.default)) return m.default;
    if (m.default !== undefined) return m.default;
    if (m.plugin !== undefined) return m.plugin;
  }
  return mod;
}

export interface LoadRoutePluginsOptions {
  /**
   * Path to the DKG state home (typically `~/.dkg`). When provided,
   * bare-name plugin specs resolve from `<dkgHome>/plugins` first
   * — the stable resolution root per OT-RFC-41 §4.6.1 / Bundle B1e.
   * When omitted, bare-name specs resolve from the loader-local
   * `import.meta.url` (back-compat for pre-Bundle-B callers).
   */
  dkgHome?: string;
}

export async function loadRoutePlugins(
  // `unknown` — caller passes raw JSON; we validate inside, fail-soft to [].
  specs: unknown,
  log: Logger,
  opts: LoadRoutePluginsOptions = {},
): Promise<RoutePlugin[]> {
  const out: RoutePlugin[] = [];
  const ctx = createOperationContext('system');

  if (specs === undefined || specs === null) return out;
  if (!Array.isArray(specs)) {
    log.warn(
      ctx,
      `route-plugins-invalid-config: expected an array of plugin spec strings, got ${typeof specs}; ignoring`,
    );
    return out;
  }

  const stableRootRequire = opts.dkgHome ? buildStableRootRequire(opts.dkgHome) : null;

  for (const rawSpec of specs as readonly unknown[]) {
    if (typeof rawSpec !== 'string' || rawSpec.length === 0) {
      log.warn(
        ctx,
        `route-plugins-invalid-spec: ignoring non-string entry: ${safeStringify(rawSpec)}`,
      );
      continue;
    }
    const spec = rawSpec;
    try {
      const mod = await importSpec(spec, stableRootRequire);
      const candidate = pickCandidate(mod);
      if (!isRoutePlugin(candidate)) {
        log.warn(ctx, `route-plugin-load-failed: ${spec}: invalid shape`);
        continue;
      }
      out.push(candidate);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(ctx, `route-plugin-load-failed: ${spec}: ${msg}`);
    }
  }
  return out;
}

/** Spec count for `route-plugins-loaded` telemetry; non-arrays report 0 so malformed config isn't leaked. */
export function countConfiguredPluginSpecs(raw: unknown): number {
  return Array.isArray(raw) ? raw.length : 0;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
