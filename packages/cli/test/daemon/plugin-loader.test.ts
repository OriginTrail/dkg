import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@origintrail-official/dkg-core';
import {
  loadRoutePlugins,
  countConfiguredPluginSpecs,
} from '../../src/daemon/plugin-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureAbs = resolve(
  __dirname,
  '../../test-fixtures/sample-route-plugin/dist/index.js',
);

function makeLogger() {
  const log = new Logger('test');
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
  return { log, warn };
}

function writeTempEsm(filename: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-plugin-loader-'));
  const abs = join(dir, filename);
  writeFileSync(abs, source);
  return abs;
}

describe('countConfiguredPluginSpecs', () => {
  // Regression for codex PR review #593 (round 9): the startup log line
  // `route-plugins-loaded loaded=X configured=Y` was reading `Y` straight
  // from `config.routePlugins?.length`. For a malformed config (string,
  // object, ...) that produced misleading telemetry — e.g. an operator
  // typo `"routePlugins": "@foo/bar"` would log `configured=8` (string
  // length) rather than 0 (the count the loader actually validates). The
  // count must match the validation path: array → length, anything else → 0.

  it('returns the array length when given a proper array of specs', () => {
    expect(countConfiguredPluginSpecs(['@x/y', '/abs/path/plugin.js'])).toBe(2);
  });

  it('returns 0 for an empty array', () => {
    expect(countConfiguredPluginSpecs([])).toBe(0);
  });

  it('returns 0 for a string (operator forgot the brackets)', () => {
    expect(countConfiguredPluginSpecs('@my-fork/plugin')).toBe(0);
  });

  it('returns 0 for a plain object', () => {
    expect(countConfiguredPluginSpecs({ '0': '@my-fork/plugin' })).toBe(0);
  });

  it('returns 0 for null / undefined', () => {
    expect(countConfiguredPluginSpecs(null)).toBe(0);
    expect(countConfiguredPluginSpecs(undefined)).toBe(0);
  });

  it('returns 0 for a number', () => {
    expect(countConfiguredPluginSpecs(42)).toBe(0);
  });
});

describe('loadRoutePlugins', () => {
  it('returns empty array for empty input without warnings', async () => {
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins([], log);
    expect(plugins).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('loads a single plugin from an absolute-path spec (default export)', async () => {
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins([fixtureAbs], log);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('sample-fixture-echo');
    expect(typeof plugins[0].handle).toBe('function');
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips and warns on a non-existent package name', async () => {
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins(['definitely-not-a-real-pkg-xyz'], log);
    expect(plugins).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const arg = String(warn.mock.calls[0][1]);
    expect(arg).toContain('route-plugin-load-failed');
    expect(arg).toContain('definitely-not-a-real-pkg-xyz');
  });

  it('skips and warns when the module shape is missing handle', async () => {
    const tempAbs = writeTempEsm(
      'no-handle.mjs',
      'export default { name: "no-handle" };',
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([tempAbs], log);
      expect(plugins).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][1])).toContain('route-plugin-load-failed');
    } finally {
      rmSync(dirname(tempAbs), { recursive: true, force: true });
    }
  });

  it('accepts a CommonJS module that exposes the plugin as a named `plugin` export', async () => {
    const tempAbs = writeTempEsm(
      'cjs-named.cjs',
      "module.exports.plugin = { name: 'cjs-named-plugin', handle() {} };",
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([tempAbs], log);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('cjs-named-plugin');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(dirname(tempAbs), { recursive: true, force: true });
    }
  });

  it('loads an ESM-only package referenced by bare name (exports.import only)', async () => {
    // Packages with `exports: { import: ... }` only: `require.resolve` would throw `ERR_PACKAGE_PATH_NOT_EXPORTED`;
    // `await import(spec)` honours the `import` condition. Fixture installed under cli/node_modules for bare-name lookup.
    const pkgName = `@dkg-test/esm-only-fixture-${process.pid}-${Date.now()}`;
    const cliNodeModules = resolve(__dirname, '../../node_modules');
    const installDir = join(cliNodeModules, ...pkgName.split('/'));
    const parentDir = dirname(installDir);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      join(installDir, 'package.json'),
      JSON.stringify({
        name: pkgName,
        version: '0.0.0',
        type: 'module',
        exports: { '.': { import: './index.mjs' } },
      }),
    );
    writeFileSync(
      join(installDir, 'index.mjs'),
      "export default { name: 'esm-only-fixture-plugin', handle() {} };\n",
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([pkgName], log);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('esm-only-fixture-plugin');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('loads a CJS-only package referenced by bare name (exports.require only)', async () => {
    // Inverse case: `exports: { require: ... }` only. ESM import refuses; loader must fall back to CJS resolve.
    const pkgName = `@dkg-test/cjs-only-fixture-${process.pid}-${Date.now()}`;
    const cliNodeModules = resolve(__dirname, '../../node_modules');
    const installDir = join(cliNodeModules, ...pkgName.split('/'));
    const parentDir = dirname(installDir);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      join(installDir, 'package.json'),
      JSON.stringify({
        name: pkgName,
        version: '0.0.0',
        // No `"type": "module"` — defaults to CommonJS.
        exports: { '.': { require: './index.cjs' } },
      }),
    );
    writeFileSync(
      join(installDir, 'index.cjs'),
      "module.exports = { name: 'cjs-only-fixture-plugin', handle() {} };\n",
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([pkgName], log);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('cjs-only-fixture-plugin');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('returns [] and warns once when routePlugins is a non-array string value', async () => {
    // Typo case: operator writes a bare string instead of an array. Reject with one warn, don't iterate characters.
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins(
      // Intentionally wrong shape — bypass the typed signature in the test.
      '@my-fork/dkg-routes' as unknown as readonly string[],
      log,
    );
    expect(plugins).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][1]);
    expect(msg).toContain('route-plugins-invalid-config');
    expect(msg).toContain('string');
  });

  it('returns [] and warns once when routePlugins is a plain object', async () => {
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins(
      { foo: '@my-fork/dkg-routes' } as unknown as readonly string[],
      log,
    );
    expect(plugins).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][1]);
    expect(msg).toContain('route-plugins-invalid-config');
  });

  it('returns [] silently when routePlugins is undefined or null', async () => {
    const { log: log1, warn: warn1 } = makeLogger();
    const plugins1 = await loadRoutePlugins(
      undefined as unknown as readonly string[],
      log1,
    );
    expect(plugins1).toEqual([]);
    expect(warn1).not.toHaveBeenCalled();

    const { log: log2, warn: warn2 } = makeLogger();
    const plugins2 = await loadRoutePlugins(
      null as unknown as readonly string[],
      log2,
    );
    expect(plugins2).toEqual([]);
    expect(warn2).not.toHaveBeenCalled();
  });

  it('filters non-string entries from a partially-malformed array, warning per bad entry', async () => {
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins(
      [fixtureAbs, 42, null, '', { not: 'a string' }] as unknown as readonly string[],
      log,
    );
    // Only the valid absolute path should resolve to a plugin.
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('sample-fixture-echo');
    // One warn per non-string entry: 42, null, '' (empty), object → 4 warns.
    expect(warn).toHaveBeenCalledTimes(4);
    for (const [, msg] of warn.mock.calls) {
      expect(String(msg)).toContain('route-plugins-invalid-spec');
    }
  });

  it('rejects a relative-path spec (./foo) instead of resolving it from the loader source dir', async () => {
    // Node would resolve ./foo against the loader source, not ~/.dkg — risks silent import of daemon internals. Reject explicitly.
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins(['./not-a-real-plugin.js'], log);
    expect(plugins).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][1]);
    expect(msg).toContain('route-plugin-load-failed');
    expect(msg.toLowerCase()).toContain('relative');
  });

  it('rejects a parent-relative path spec (../foo)', async () => {
    // `../config.js` resolves to the real daemon config module up one dir from the loader — must be rejected.
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins(['../config.js'], log);
    expect(plugins).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][1]);
    expect(msg.toLowerCase()).toContain('relative');
  });

  it('rejects Windows-style relative path specs (.\\foo, ..\\foo)', async () => {
    // Windows operators write backslash paths in config.json. The original POSIX-only check let
    // these slip through as bare specifiers, producing a confusing "module not found" instead of
    // the documented "relative paths not supported" rejection.
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins(['.\\plugin.js', '..\\config.js'], log);
    expect(plugins).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) {
      expect(String(call[1]).toLowerCase()).toContain('relative');
    }
  });

  it('keeps the valid plugin and warns on the broken one in a mixed list', async () => {
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins(
      [fixtureAbs, 'definitely-not-a-real-pkg-xyz'],
      log,
    );
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('sample-fixture-echo');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not silently fall back to CJS when the ESM entry has a syntax error', async () => {
    // Dual-publish with a broken ESM `import` entry: must surface the SyntaxError,
    // not silently load the CJS twin and hide the broken publish.
    const pkgName = `@dkg-test/broken-esm-fixture-${process.pid}-${Date.now()}`;
    const cliNodeModules = resolve(__dirname, '../../node_modules');
    const installDir = join(cliNodeModules, ...pkgName.split('/'));
    const parentDir = dirname(installDir);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      join(installDir, 'package.json'),
      JSON.stringify({
        name: pkgName,
        version: '0.0.0',
        type: 'module',
        exports: { '.': { import: './index.mjs', require: './index.cjs' } },
      }),
    );
    // Broken ESM: stray `{{` causes a SyntaxError during parse.
    writeFileSync(
      join(installDir, 'index.mjs'),
      "export default { name: 'broken-esm-plugin', handle() {{} };\n",
    );
    // Valid CJS — would silently rescue the load before the fix.
    writeFileSync(
      join(installDir, 'index.cjs'),
      "module.exports = { name: 'broken-esm-plugin', handle() {} };\n",
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([pkgName], log);
      expect(plugins).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0][1]);
      expect(msg).toContain('route-plugin-load-failed');
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('does not silently fall back to CJS when the ESM entry is missing an internal import', async () => {
    // `ERR_MODULE_NOT_FOUND` is ambiguous: (a) plugin spec not installed, (b) ESM's own transitive import missing.
    // Case (b) must surface as `route-plugin-load-failed`, not get silently rescued by the CJS twin.
    const pkgName = `@dkg-test/missing-import-fixture-${process.pid}-${Date.now()}`;
    const cliNodeModules = resolve(__dirname, '../../node_modules');
    const installDir = join(cliNodeModules, ...pkgName.split('/'));
    const parentDir = dirname(installDir);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      join(installDir, 'package.json'),
      JSON.stringify({
        name: pkgName,
        version: '0.0.0',
        type: 'module',
        exports: { '.': { import: './index.mjs', require: './index.cjs' } },
      }),
    );
    // ESM entry imports a sibling file that does not exist on disk.
    // Node raises `ERR_MODULE_NOT_FOUND` when loading this module.
    writeFileSync(
      join(installDir, 'index.mjs'),
      "import helper from './missing-helper.mjs';\nexport default { name: 'missing-import-plugin', handle: helper };\n",
    );
    // Valid CJS — would silently rescue the load before the fix.
    writeFileSync(
      join(installDir, 'index.cjs'),
      "module.exports = { name: 'missing-import-plugin', handle() {} };\n",
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([pkgName], log);
      expect(plugins).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0][1]);
      expect(msg).toContain('route-plugin-load-failed');
      // Phrasing differs Node vs Vite; the missing filename is the cross-env anchor.
      expect(msg).toContain('missing-helper');
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('rejects a plugin whose name is an empty string (length>0 guard)', async () => {
    // Defends against a regression that drops the `name.length > 0`
    // check in isRoutePlugin. An empty-named plugin would otherwise
    // pass the typeof-string check and be silently accepted, then
    // shadow other plugins in the routing table by name collision.
    const tempAbs = writeTempEsm(
      'empty-name.mjs',
      'export default { name: "", handle() {} };',
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([tempAbs], log);
      expect(plugins).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][1])).toContain('route-plugin-load-failed');
    } finally {
      rmSync(dirname(tempAbs), { recursive: true, force: true });
    }
  });

  it('rejects a plugin whose handle is not a function', async () => {
    // Defends against a regression that loosens the handle-type check
    // (e.g. accepts an object or a string). Calling such a "plugin"
    // would crash the daemon at request time; load-time rejection is
    // the design contract.
    const tempAbs = writeTempEsm(
      'bad-handle.mjs',
      'export default { name: "bad-handle", handle: "i am a string" };',
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([tempAbs], log);
      expect(plugins).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][1])).toContain('route-plugin-load-failed');
    } finally {
      rmSync(dirname(tempAbs), { recursive: true, force: true });
    }
  });

  it('prefers `plugin` over `default` when both are present and valid (pickCandidate priority lock)', async () => {
    // Locks the priority order in pickCandidate. A regression that
    // swapped these would silently route requests to the wrong
    // plugin, which is virtually impossible to catch in production
    // (both responses look correct; only the wrong telemetry name
    // ever differs).
    const tempAbs = writeTempEsm(
      'both-exports.mjs',
      [
        'export const plugin = { name: "from-plugin-export", handle() {} };',
        'export default { name: "from-default-export", handle() {} };',
      ].join('\n'),
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([tempAbs], log);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('from-plugin-export');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(dirname(tempAbs), { recursive: true, force: true });
    }
  });

  it('preserves spec order in the returned plugin list (no reordering, no shuffling)', async () => {
    // Routing precedence in the daemon is order-of-load. Operators
    // express precedence by configuring `routePlugins` in a specific
    // order. A regression that reordered (e.g. via Promise.all
    // returning out-of-order) would silently swap precedence.
    const a = writeTempEsm(
      'order-a.mjs',
      'export default { name: "alpha-plugin", handle() {} };',
    );
    const b = writeTempEsm(
      'order-b.mjs',
      'export default { name: "beta-plugin", handle() {} };',
    );
    try {
      const { log } = makeLogger();
      const plugins1 = await loadRoutePlugins([a, b], log);
      const plugins2 = await loadRoutePlugins([b, a], log);
      expect(plugins1.map((p) => p.name)).toEqual(['alpha-plugin', 'beta-plugin']);
      expect(plugins2.map((p) => p.name)).toEqual(['beta-plugin', 'alpha-plugin']);
    } finally {
      rmSync(dirname(a), { recursive: true, force: true });
      rmSync(dirname(b), { recursive: true, force: true });
    }
  });

  it('rejects a plugin whose name field is missing entirely (typeof undefined fails the string check)', async () => {
    const tempAbs = writeTempEsm(
      'no-name.mjs',
      'export default { handle() {} };',
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([tempAbs], log);
      expect(plugins).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][1])).toContain('route-plugin-load-failed');
    } finally {
      rmSync(dirname(tempAbs), { recursive: true, force: true });
    }
  });

  it('surfaces the real CJS error when the CJS fallback resolves but its entry is broken', async () => {
    // CJS-only package whose `require.resolve` succeeds but the resolved file has a syntax error.
    // Current code rethrows the unrelated ESM resolver error; the fix must let the SyntaxError bubble.
    const pkgName = `@dkg-test/broken-cjs-fixture-${process.pid}-${Date.now()}`;
    const cliNodeModules = resolve(__dirname, '../../node_modules');
    const installDir = join(cliNodeModules, ...pkgName.split('/'));
    const parentDir = dirname(installDir);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      join(installDir, 'package.json'),
      JSON.stringify({
        name: pkgName,
        version: '0.0.0',
        exports: { '.': { require: './index.cjs' } },
      }),
    );
    // Broken CJS: unterminated string — V8 raises a SyntaxError during parse.
    writeFileSync(
      join(installDir, 'index.cjs'),
      "module.exports = { name: 'broken-cjs-plugin', message: 'unterminated string };\n",
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([pkgName], log);
      expect(plugins).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0][1]);
      expect(msg).toContain('route-plugin-load-failed');
      // The diagnostic must be the CJS SyntaxError, NOT the ESM "no exports condition" message.
      expect(msg).not.toMatch(/No known conditions|No "exports" main defined|Failed to resolve entry/i);
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });
});
