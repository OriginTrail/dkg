#!/usr/bin/env node

/**
 * Bulk-update repository URLs across all package.json files to match
 * the values in project.json. Run this after renaming the GitHub repo
 * or changing the URL in project.json.
 *
 * Usage:
 *   node scripts/update-repo-refs.js            # dry-run (default)
 *   node scripts/update-repo-refs.js --apply     # write changes
 */

const fs = require('fs');
const path = require('path');

const dryRun = !process.argv.includes('--apply');
const root = path.resolve(__dirname, '..');
const proj = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf-8'));
const repoUrl = proj.githubUrl + '.git';
let updated = 0;

function update(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const pkg = JSON.parse(raw);
  if (!pkg.repository?.url || pkg.repository.url === repoUrl) return;
  const old = pkg.repository.url;
  pkg.repository.url = repoUrl;
  if (dryRun) {
    console.log(`  [dry-run] ${path.relative(root, filePath)}: ${old} → ${repoUrl}`);
  } else {
    fs.writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`  ${path.relative(root, filePath)}: ${old} → ${repoUrl}`);
  }
  updated++;
}

// Recursively find every tracked package.json below the repo root so
// the tool matches its own contract ("all package.json files") even as
// the monorepo grows new top-level folders (apps/, tools/, etc.).
// Skip build outputs, vendored deps, and version-control noise.
const SKIP = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.turbo',
  '.next',
  'coverage',
  '.pnpm-store',
  '.cache',
]);

function walk(dir) {
  const found = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return found; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(entry.name)) continue;
    // Skip hidden dirs (except well-known repo ones) to avoid editor/
    // tooling state like .vscode/, .idea/, etc.
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(full));
    } else if (entry.isFile() && entry.name === 'package.json') {
      found.push(full);
    }
  }
  return found;
}

for (const pkgJson of walk(root)) update(pkgJson);

if (updated === 0) {
  console.log('All repository URLs already match project.json — nothing to do.');
} else if (dryRun) {
  console.log(`\n${updated} file(s) would be updated. Run with --apply to write.`);
} else {
  console.log(`\n${updated} file(s) updated.`);
}
