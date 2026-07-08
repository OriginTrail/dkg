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
// Paths are resolved from this script's own location, so it is correct
// regardless of the current working directory (prepack runs with cwd =
// packages/cli; a manual run may use the repo root).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const CLI_DIR = path.join(ROOT_DIR, 'packages', 'cli');

const sourceNetworkDir = path.join(ROOT_DIR, 'network');
const targetNetworkDir = path.join(CLI_DIR, 'network');
const sourceProjectJson = path.join(ROOT_DIR, 'project.json');
const targetProjectJson = path.join(CLI_DIR, 'project.json');

function fail(message) {
  console.error(`copy-cli-runtime-assets: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(sourceNetworkDir) || !fs.statSync(sourceNetworkDir).isDirectory()) {
  fail(`repo-root network/ directory not found at ${sourceNetworkDir}`);
}

const networkJsonFiles = fs
  .readdirSync(sourceNetworkDir)
  .filter((file) => file.endsWith('.json'));

if (networkJsonFiles.length === 0) {
  fail(`no network/*.json overlays found in ${sourceNetworkDir}`);
}

if (!fs.existsSync(sourceProjectJson)) {
  fail(`repo-root project.json not found at ${sourceProjectJson}`);
}

fs.mkdirSync(targetNetworkDir, { recursive: true });
for (const file of networkJsonFiles) {
  fs.copyFileSync(path.join(sourceNetworkDir, file), path.join(targetNetworkDir, file));
}
fs.copyFileSync(sourceProjectJson, targetProjectJson);

const relTarget = path.relative(ROOT_DIR, CLI_DIR) || '.';
// Log to stderr, not stdout: this runs as `prepack`, and `npm pack --json`
// emits its machine-readable report on stdout — anything we print there would
// corrupt it for the `release:verify-pack` preflight that parses that JSON.
console.error(
  `copy-cli-runtime-assets: copied ${networkJsonFiles.length} network overlay(s) + project.json into ${relTarget}/`,
);
