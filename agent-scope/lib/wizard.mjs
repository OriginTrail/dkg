// Pure helpers for the interactive `pnpm task start` wizard.
//
// Everything in this module is deterministic and side-effect-free once given
// a repo root, so every branch is unit-testable without a TTY. The actual
// interactive prompting lives in prompter.mjs; the CLI orchestration lives in
// bin/task.mjs. This file is the part you'd want to reuse if someone wanted
// to build (say) a VS Code command-palette version.

import {
  existsSync, readFileSync, readdirSync, statSync,
} from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Package discovery
// ---------------------------------------------------------------------------
//
// Order of precedence:
//   1. pnpm-workspace.yaml (`packages:` list of globs/paths)
//   2. package.json `workspaces` (array or object.packages array)
//   3. fallback: scan `packages/*`
//
// We do a permissive line-based YAML parse so we don't pull in a dependency.
// The file format we care about is narrow and stable:
//
//     packages:
//       - "packages/*"
//       - "demo"
//
// Anything fancier (nested keys, flow style) will just fall through to the
// workspaces / packages fallbacks.

function parseWorkspaceYaml(text) {
  const lines = text.split(/\r?\n/);
  let inPkgs = false;
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '');
    if (/^packages\s*:\s*$/.test(line)) { inPkgs = true; continue; }
    if (inPkgs && /^\S/.test(line)) break;
    if (!inPkgs) continue;
    const m = /^\s*-\s*["']?([^"'\s]+?)["']?\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function parsePackageJsonWorkspaces(text) {
  try {
    const obj = JSON.parse(text);
    const ws = obj && obj.workspaces;
    if (Array.isArray(ws)) return ws.filter(s => typeof s === 'string');
    if (ws && Array.isArray(ws.packages)) return ws.packages.filter(s => typeof s === 'string');
    return [];
  } catch { return []; }
}

function expandGlobEntry(root, entry) {
  // Only supports trailing `/*` (flat) and literal paths — enough for every
  // real monorepo layout I've seen. If you need deeper expansion you should
  // not be using the wizard anyway, just hand-author the manifest.
  if (entry.endsWith('/*')) {
    const base = entry.slice(0, -2);
    const abs = resolve(root, base);
    if (!existsSync(abs)) return [];
    let names;
    try { names = readdirSync(abs); } catch { return []; }
    return names
      .filter(n => !n.startsWith('.'))
      .map(n => join(base, n))
      .filter(p => {
        const full = resolve(root, p);
        try { return statSync(full).isDirectory(); } catch { return false; }
      });
  }
  return [entry];
}

function readPackageName(root, pkgDir) {
  const pj = resolve(root, pkgDir, 'package.json');
  if (!existsSync(pj)) return null;
  try {
    const obj = JSON.parse(readFileSync(pj, 'utf8'));
    if (obj && typeof obj.name === 'string' && obj.name.trim()) return obj.name.trim();
  } catch { /* fall through */ }
  return null;
}

function shortName(pkgDir, fullName) {
  if (fullName && fullName.includes('/')) {
    const tail = fullName.split('/').pop();
    if (tail) return tail;
  }
  const parts = pkgDir.split('/');
  return parts[parts.length - 1] || pkgDir;
}

export function discoverPackages(root) {
  const entries = [];

  const wsYaml = resolve(root, 'pnpm-workspace.yaml');
  if (existsSync(wsYaml)) {
    try { entries.push(...parseWorkspaceYaml(readFileSync(wsYaml, 'utf8'))); }
    catch { /* ignore */ }
  }
  if (!entries.length) {
    const pj = resolve(root, 'package.json');
    if (existsSync(pj)) {
      try { entries.push(...parsePackageJsonWorkspaces(readFileSync(pj, 'utf8'))); }
      catch { /* ignore */ }
    }
  }
  if (!entries.length) entries.push('packages/*');

  const dirs = new Set();
  for (const e of entries) {
    for (const p of expandGlobEntry(root, e)) {
      const pj = resolve(root, p, 'package.json');
      if (existsSync(pj)) dirs.add(p.split(sep).join('/'));
    }
  }

  const pkgs = [];
  for (const pkgDir of [...dirs].sort()) {
    const pjName = readPackageName(root, pkgDir);
    const displayName = shortName(pkgDir, pjName);
    pkgs.push({
      path: pkgDir,
      name: displayName,
      fullName: pjName || null,
    });
  }
  return pkgs;
}

// ---------------------------------------------------------------------------
// Task-id derivation
// ---------------------------------------------------------------------------

const ID_MAX = 48;

export function deriveTaskId(description, { existingIds = [] } = {}) {
  const base = (description || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_MAX)
    .replace(/^-+|-+$/g, '');

  const fallback = () => {
    const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    return `task-${stamp}`;
  };

  let id = base;
  if (!id || !/^[a-z0-9]/.test(id)) id = fallback();

  if (!existingIds.includes(id)) return id;
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const trimmed = id.slice(0, ID_MAX - suffix.length) + suffix;
    if (!existingIds.includes(trimmed)) return trimmed;
  }
  return fallback();
}

// ---------------------------------------------------------------------------
// Keyword-based suggestion
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','to','of','in','on','at','for','from','with',
  'by','as','is','are','was','were','be','been','being','do','does','did','can',
  'could','should','would','will','shall','may','might','must','this','that',
  'these','those','it','its','into','onto','over','under','about','through',
  'some','any','all','no','not','we','you','i','me','my','our','their','there',
  'here','up','down','out','if','then','than','so','very','just','also','too',
  'work','task','feature','feat','fix','bug','refactor','improve','add','remove',
  'rework','update','change','changes','new','old',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

function scorePackage(descTokens, descLower, pkg) {
  const nameLower = pkg.name.toLowerCase();
  const pathLower = pkg.path.toLowerCase();
  const fullLower = (pkg.fullName || '').toLowerCase();

  let score = 0;
  if (descLower.includes(nameLower) && nameLower.length >= 3) score += 4;
  if (descLower.includes(pathLower)) score += 3;
  if (fullLower && descLower.includes(fullLower)) score += 3;

  const nameTokens = new Set([
    ...nameLower.split(/[-_/]+/).filter(Boolean),
    ...fullLower.split(/[-_/@]+/).filter(Boolean),
  ]);

  for (const t of descTokens) {
    if (nameTokens.has(t)) score += 2;
    else if (t.length >= 4 && (nameLower.includes(t) || pathLower.includes(t))) score += 1;
  }
  return score;
}

export function suggestPackagesFromDescription(description, packages, { max } = {}) {
  if (!Array.isArray(packages) || packages.length === 0) return [];
  const descLower = (description || '').toLowerCase();
  const descTokens = tokenize(description);
  if (descTokens.length === 0) return [];

  const scored = packages
    .map(p => ({ pkg: p, score: scorePackage(descTokens, descLower, p) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const cap = Math.max(1, Math.min(max ?? Math.ceil(packages.length / 2), scored.length));
  return scored.slice(0, cap).map(s => s.pkg);
}

// ---------------------------------------------------------------------------
// Glob drafting + manifest composition
// ---------------------------------------------------------------------------

const DEFAULT_DENY = ['!**/secrets.*', '!**/.env*'];
const DEFAULT_BUILD_EXEMPTIONS = ['**/dist/**', '**/*.tsbuildinfo', 'pnpm-lock.yaml'];

export function draftGlobs(selectedPackages, opts = {}) {
  const {
    includeBuildArtifacts = true,
    extraAllowed = [],
    extraDeny = [],
  } = opts;

  const allowed = [];
  const seenAllowed = new Set();
  const push = (p) => {
    if (typeof p !== 'string') return;
    const trimmed = p.trim();
    if (!trimmed || seenAllowed.has(trimmed)) return;
    seenAllowed.add(trimmed);
    allowed.push(trimmed);
  };

  for (const pkg of selectedPackages || []) {
    const path = typeof pkg === 'string' ? pkg : pkg.path;
    if (!path) continue;
    push(`${path.replace(/\/+$/, '')}/**`);
  }
  for (const p of extraAllowed) push(p);
  for (const p of extraDeny) {
    const withBang = p.startsWith('!') ? p : `!${p}`;
    push(withBang);
  }
  for (const d of DEFAULT_DENY) push(d);

  const exemptions = includeBuildArtifacts ? [...DEFAULT_BUILD_EXEMPTIONS] : [];

  return { allowed, exemptions };
}

export function buildManifest({
  id,
  description,
  selectedPackages,
  extraAllowed = [],
  extraDeny = [],
  includeBuildArtifacts = true,
  inheritBase = true,
  existingIds = [],
  now = () => new Date().toISOString(),
}) {
  const finalId = id && /^[a-z0-9][a-z0-9-_.]{0,63}$/.test(id)
    ? id
    : deriveTaskId(description, { existingIds });

  const { allowed, exemptions } = draftGlobs(selectedPackages, {
    includeBuildArtifacts,
    extraAllowed,
    extraDeny,
  });

  const manifest = {
    id: finalId,
    description: description ? description.trim() : undefined,
    created: now(),
    inherits: inheritBase ? ['base'] : undefined,
    allowed: allowed.length ? allowed : undefined,
    exemptions: exemptions.length ? exemptions : undefined,
  };
  return Object.fromEntries(Object.entries(manifest).filter(([, v]) => v !== undefined));
}
