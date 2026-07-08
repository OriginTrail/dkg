#!/usr/bin/env node
// Copy the repo-root runtime config assets that `@origintrail-official/dkg`
// (packages/cli) ships in its published tarball: the per-network overlays
// (`network/*.json`) and `project.json`.
//
// These files live at the repo root but must be present INSIDE packages/cli at
// pack time because `packages/cli/package.json#files` lists "network" and
// "project.json" — and npm silently omits `files` entries that don't exist on
// disk when the tarball is built.
//
// Historically this copy was a side effect of the `build` script. That made it
// cache-unsafe: `turbo.json` declares the build task's outputs as `dist/**`
// only, so on a turbo cache hit `dist/` was restored but the copy never re-ran,
// and the published tarball shipped without `network/` + `project.json`
// (regression in 10.0.4 — npm-installed nodes then fell back to built-in
// defaults with no network overlay). Running this from `prepack` as well makes
// materialization unconditional at pack time, independent of the build cache.
//
// Paths are resolved from `rootDir` (default: this script's own location), so
// it is correct regardless of the current working directory (prepack runs with
// cwd = packages/cli; a manual run may use the repo root).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT_DIR = path.resolve(path.dirname(SCRIPT_PATH), '..');

/**
 * Materialize packages/cli's runtime-config assets from the repo root.
 *
 * The target `network/` directory is MIRRORED, not appended to: it is removed
 * and recreated so a root overlay that was later deleted cannot linger in
 * `packages/cli/network` and leak into the tarball (files: ["network"] ships
 * the whole directory). Throws on any missing/empty source so a broken tree
 * fails loudly instead of packing a partial asset set.
 */
export function copyCliRuntimeAssets({ rootDir = DEFAULT_ROOT_DIR } = {}) {
  const cliDir = path.join(rootDir, 'packages', 'cli');
  const sourceNetworkDir = path.join(rootDir, 'network');
  const targetNetworkDir = path.join(cliDir, 'network');
  const sourceProjectJson = path.join(rootDir, 'project.json');
  const targetProjectJson = path.join(cliDir, 'project.json');

  if (!fs.existsSync(sourceNetworkDir) || !fs.statSync(sourceNetworkDir).isDirectory()) {
    throw new Error(`copy-cli-runtime-assets: repo-root network/ directory not found at ${sourceNetworkDir}`);
  }
  const networkJsonFiles = fs
    .readdirSync(sourceNetworkDir)
    .filter((file) => file.endsWith('.json'))
    .sort();
  if (networkJsonFiles.length === 0) {
    throw new Error(`copy-cli-runtime-assets: no network/*.json overlays found in ${sourceNetworkDir}`);
  }
  if (!fs.existsSync(sourceProjectJson)) {
    throw new Error(`copy-cli-runtime-assets: repo-root project.json not found at ${sourceProjectJson}`);
  }

  // Mirror the generated directory: clear it so removed overlays don't persist.
  fs.rmSync(targetNetworkDir, { recursive: true, force: true });
  fs.mkdirSync(targetNetworkDir, { recursive: true });
  for (const file of networkJsonFiles) {
    fs.copyFileSync(path.join(sourceNetworkDir, file), path.join(targetNetworkDir, file));
  }
  fs.copyFileSync(sourceProjectJson, targetProjectJson);

  return { rootDir, cliDir, networkJsonFiles };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (invokedDirectly) {
  try {
    const { rootDir, cliDir, networkJsonFiles } = copyCliRuntimeAssets();
    const relTarget = path.relative(rootDir, cliDir) || '.';
    // Log to stderr, not stdout: this runs as `prepack`, and `npm pack --json`
    // emits its machine-readable report on stdout — anything we print there
    // would corrupt it for the `release:verify-pack` preflight that parses it.
    console.error(
      `copy-cli-runtime-assets: copied ${networkJsonFiles.length} network overlay(s) + project.json into ${relTarget}/`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
