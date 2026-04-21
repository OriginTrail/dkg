// Shared scope-check library. Zero runtime dependencies; must work from
// Cursor hooks, git hooks, CLI, and CI. Node 20+.
//
// Bootstrap modes (disables hardcoded protection):
//   1. env: AGENT_SCOPE_BOOTSTRAP=1
//   2. file: agent-scope/.bootstrap-token exists
// Token file is itself protected — only the human can create/remove it from
// outside the agent sandbox. Intentional convention: git-visible.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, sep, dirname, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Node version check
// ---------------------------------------------------------------------------

const MIN_NODE_MAJOR = 20;

export function checkNodeVersion(minMajor = MIN_NODE_MAJOR) {
  const m = /^v(\d+)\./.exec(process.version);
  const major = m ? parseInt(m[1], 10) : 0;
  if (major < minMajor) {
    throw new Error(
      `agent-scope requires Node ${minMajor}+ but found ${process.version}. ` +
      `Update Node (nvm install 22) and retry.`
    );
  }
}

// ---------------------------------------------------------------------------
// Protected paths
// ---------------------------------------------------------------------------

export const PROTECTED_PATTERNS = [
  '.cursor/hooks/**',
  '.cursor/hooks.json',
  '.cursor/rules/agent-scope.mdc',
  'agent-scope/lib/**',
  'agent-scope/bin/**',
  'agent-scope/schema/**',
  'agent-scope/tasks/**',
  'agent-scope/active',
  'agent-scope/.bootstrap-token',
];

function bootstrapActive(root) {
  if (process.env.AGENT_SCOPE_BOOTSTRAP === '1') return true;
  try {
    const p = resolve(root || resolveRepoRoot(), 'agent-scope/.bootstrap-token');
    return existsSync(p);
  } catch { return false; }
}

export function isBootstrapActive(root) { return bootstrapActive(root); }

export function checkProtected(relPath, root) {
  if (!relPath || typeof relPath !== 'string') return 'deny';
  if (bootstrapActive(root)) return 'allow';
  for (const pattern of PROTECTED_PATTERNS) {
    if (globToRegex(pattern).test(relPath)) return 'deny';
  }
  return 'allow';
}

// Returns true if `relPath` is a directory that CONTAINS any protected path
// (i.e. a destructive recursive op against it would wipe protected files).
// Used by the pre-shell hook for `rm -rf <dir>`, `find <dir> -delete`, etc.
export function coversProtected(relPath, root) {
  if (!relPath || typeof relPath !== 'string') return false;
  if (bootstrapActive(root)) return false;
  const norm = relPath.replace(/\/+$/, '');
  if (!norm) return false;
  const prefix = norm + '/';
  for (const pattern of PROTECTED_PATTERNS) {
    const literal = pattern
      .replace(/\/\*\*\/?$/, '/')
      .replace(/\/\*$/, '/')
      .replace(/\*+/g, '');
    if (!literal) continue;
    if (literal === norm || literal === prefix) return true;
    if (literal.startsWith(prefix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Glob
// ---------------------------------------------------------------------------

function globToRegex(glob) {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (glob[i] === '/') i++;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if ('.+^$(){}|[]\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

function matchAnyPositive(patterns, relPath) {
  if (!Array.isArray(patterns)) return null;
  for (const p of patterns) {
    if (typeof p !== 'string' || p.startsWith('!')) continue;
    if (globToRegex(p).test(relPath)) return p;
  }
  return null;
}

function matchAnyNegation(patterns, relPath) {
  if (!Array.isArray(patterns)) return null;
  for (const p of patterns) {
    if (typeof p !== 'string' || !p.startsWith('!')) continue;
    if (globToRegex(p.slice(1)).test(relPath)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Path + repo root
// ---------------------------------------------------------------------------

export function resolveRepoRoot(startDir) {
  if (process.env.AGENT_SCOPE_ROOT) return process.env.AGENT_SCOPE_ROOT;
  let dir = startDir || process.cwd();
  for (let i = 0; i < 64; i++) {
    if (existsSync(resolve(dir, 'agent-scope'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir || process.cwd();
}

export function normalizeToRepoPath(root, p) {
  if (!p) return '';
  const abs = isAbsolute(p) ? p : resolve(root, p);
  let rel = relative(root, abs);
  if (sep !== '/') rel = rel.split(sep).join('/');
  return rel;
}

// ---------------------------------------------------------------------------
// Active task resolution
// ---------------------------------------------------------------------------

function readFileOrNull(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function safeGit(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

const BRANCH_TASK_RE = /^(?:task|agent-scope)\/([a-z0-9][a-z0-9-_.]{0,63})(?:\/|$)/;

export function detectTaskFromBranch(root) {
  const branch = safeGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') return null;
  const m = BRANCH_TASK_RE.exec(branch);
  return m ? m[1] : null;
}

export function detectTaskFromGitConfig(root) {
  const v = safeGit(root, ['config', '--get', 'agent-scope.task']);
  return v || null;
}

export function resolveActiveTaskId(root, opts = {}) {
  const fromEnv = process.env.AGENT_SCOPE_TASK;
  if (fromEnv && fromEnv.trim()) return { id: fromEnv.trim(), source: 'env' };

  const activeFile = resolve(root, 'agent-scope/active');
  const fromFile = readFileOrNull(activeFile);
  if (fromFile && fromFile.trim()) return { id: fromFile.trim(), source: 'file' };

  if (!opts.noBranch) {
    const fromBranch = detectTaskFromBranch(root);
    if (fromBranch) return { id: fromBranch, source: 'branch' };
  }

  if (!opts.noGitConfig) {
    const fromCfg = detectTaskFromGitConfig(root);
    if (fromCfg) return { id: fromCfg, source: 'git-config' };
  }

  return { id: null, source: 'none' };
}

export function getActiveTaskId(root) {
  return resolveActiveTaskId(root).id;
}

// ---------------------------------------------------------------------------
// Manifest loading + validation + inheritance
// ---------------------------------------------------------------------------

export function listTasks(root) {
  const dir = resolve(root, 'agent-scope/tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .sort();
}

const ALLOWED_KEYS = ['id','description','owner','created','allowed','exemptions','notes','dkg','inherits'];

export function validateManifest(obj, expectedId) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push('manifest must be a JSON object');
    return errors;
  }
  if (typeof obj.id !== 'string' || !/^[a-z0-9][a-z0-9-_.]{0,63}$/.test(obj.id)) {
    errors.push('id must be a string matching /^[a-z0-9][a-z0-9-_.]{0,63}$/');
  }
  if (expectedId && obj.id && obj.id !== expectedId) {
    errors.push(`id '${obj.id}' does not match filename '${expectedId}'`);
  }
  const hasInherits = Array.isArray(obj.inherits) && obj.inherits.length > 0;
  const hasAllowed = Array.isArray(obj.allowed);
  const hasExemptions = Array.isArray(obj.exemptions) && obj.exemptions.length > 0;
  if (!hasAllowed && !hasInherits && !hasExemptions) {
    errors.push('at least one of allowed / inherits / exemptions must be provided');
  }
  if (obj.allowed !== undefined) {
    if (!Array.isArray(obj.allowed)) errors.push('allowed must be an array');
    else obj.allowed.forEach((p, i) => {
      if (typeof p !== 'string' || !p.length) errors.push(`allowed[${i}] must be a non-empty string`);
    });
  }
  if (obj.exemptions !== undefined) {
    if (!Array.isArray(obj.exemptions)) errors.push('exemptions must be an array');
    else obj.exemptions.forEach((p, i) => {
      if (typeof p !== 'string' || !p.length) errors.push(`exemptions[${i}] must be a non-empty string`);
    });
  }
  if (obj.inherits !== undefined) {
    if (!Array.isArray(obj.inherits)) errors.push('inherits must be an array of task ids');
    else obj.inherits.forEach((id, i) => {
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-_.]{0,63}$/.test(id)) {
        errors.push(`inherits[${i}] must match /^[a-z0-9][a-z0-9-_.]{0,63}$/`);
      }
    });
  }
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_KEYS.includes(k)) errors.push(`unknown property: ${k}`);
  }
  return errors;
}

function loadAndResolve(root, id, seen = new Set(), chain = []) {
  if (seen.has(id)) {
    throw new Error(`inheritance cycle detected: ${[...chain, id].join(' -> ')}`);
  }
  seen.add(id);

  const manifestPath = resolve(root, 'agent-scope/tasks', `${id}.json`);
  if (!existsSync(manifestPath)) {
    throw new Error(`Task manifest not found: ${manifestPath}` + (chain.length ? ` (inherited from ${chain.join(' -> ')})` : ''));
  }
  const raw = readFileSync(manifestPath, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`Task manifest is not valid JSON: ${manifestPath}: ${e.message}`); }

  const errors = validateManifest(parsed, id);
  if (errors.length) {
    throw new Error(`Invalid task manifest ${manifestPath}:\n  - ${errors.join('\n  - ')}`);
  }
  parsed.allowed = parsed.allowed || [];
  parsed.exemptions = parsed.exemptions || [];

  const merged = { allowed: [], exemptions: [] };
  for (const parentId of parsed.inherits || []) {
    const parent = loadAndResolve(root, parentId, new Set(seen), [...chain, id]);
    merged.allowed.push(...parent.allowed);
    merged.exemptions.push(...parent.exemptions);
  }
  merged.allowed.push(...parsed.allowed);
  merged.exemptions.push(...parsed.exemptions);

  return {
    ...parsed,
    allowed: dedupe(merged.allowed),
    exemptions: dedupe(merged.exemptions),
    __path: manifestPath,
    __inheritedFrom: parsed.inherits || [],
  };
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
  return out;
}

export function loadTask(root, id) {
  if (!id) return null;
  return loadAndResolve(root, id);
}

// ---------------------------------------------------------------------------
// Core decision
// ---------------------------------------------------------------------------

export function checkPath(task, relPath, root) {
  if (typeof relPath !== 'string' || relPath.length === 0) return 'deny';
  if (relPath.includes('..')) return 'deny';

  if (checkProtected(relPath, root) === 'deny') return 'protected';

  if (!task) return 'allow';

  if (matchAnyNegation(task.allowed, relPath)) return 'deny';
  if (matchAnyNegation(task.exemptions, relPath)) return 'deny';
  if (matchAnyPositive(task.exemptions, relPath)) return 'exempt';
  if (matchAnyPositive(task.allowed, relPath)) return 'allow';
  return 'deny';
}

export function explainDeny(task, relPath, decision) {
  if (decision === 'protected') {
    return [
      `PROTECTED PATH — write blocked by system policy.`,
      `Path: ${relPath}`,
      ``,
      `This path is part of the agent-scope enforcement system. Modifying it`,
      `would weaken the very mechanism that keeps agent work in-scope, so`,
      `writes are blocked regardless of the active task.`,
      ``,
      `If this change is legitimate (e.g. you're improving agent-scope itself),`,
      `ask the user to enable bootstrap mode (touch agent-scope/.bootstrap-token`,
      `in their own terminal, or set AGENT_SCOPE_BOOTSTRAP=1 in their env).`,
      ``,
      `Protected patterns:`,
      ...PROTECTED_PATTERNS.map(p => `  - ${p}`),
    ].join('\n');
  }
  if (!task) return '';

  const positives = (task.allowed || []).filter(p => !p.startsWith('!'));
  const negatives = (task.allowed || []).filter(p => p.startsWith('!'))
    .concat((task.exemptions || []).filter(p => p.startsWith('!')));
  const exemptions = (task.exemptions || []).filter(p => !p.startsWith('!'));

  const lines = [
    `OUT OF TASK SCOPE.`,
    `Active task: ${task.id} — ${task.description || ''}`,
    `Denied path: ${relPath}`,
    ``,
    `This task only permits writes to paths matching:`,
    ...(positives.length ? positives.map(p => `  - ${p}`) : ['  (nothing)']),
  ];
  if (exemptions.length) {
    lines.push('', 'Exempted patterns (always allowed):', ...exemptions.map(p => `  - ${p}`));
  }
  if (negatives.length) {
    lines.push('', 'Explicit deny patterns:', ...negatives.map(p => `  - ${p}`));
  }
  lines.push(
    '',
    `If this change is needed for the current task, STOP and ask the user for`,
    `explicit approval. The user can approve by adding the path (or a covering`,
    `glob) to agent-scope/tasks/${task.id}.json under 'allowed' or 'exemptions',`,
    `or by switching tasks.`
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

export function checkPathFromAnywhere(p, opts = {}) {
  const root = opts.root || resolveRepoRoot();
  const { id } = opts.taskId ? { id: opts.taskId } : resolveActiveTaskId(root);
  const task = id ? loadTask(root, id) : null;
  const rel = normalizeToRepoPath(root, p);
  return { root, taskId: id, task, relPath: rel, decision: checkPath(task, rel, root) };
}

export const __scopeLibFile = fileURLToPath(import.meta.url);
