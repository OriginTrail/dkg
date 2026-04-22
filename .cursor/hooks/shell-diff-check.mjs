#!/usr/bin/env node
// Cursor afterShellExecution hook. Reverts file changes that are either
// out-of-task-scope OR touch a hardcoded-protected system file.
//
// Untracked files:
//   - in a protected path → DELETED (can't let agent establish persistent state
//     via `node -e` / `python -c` bypass of pre-shell)
//   - out-of-task-scope, not protected → DELETED (matches default-deny intent)
//   - in-scope or exempt → left alone

import { readFileSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const scopeUrl  = pathToFileURL(resolve(__dirname, '../../agent-scope/lib/scope.mjs')).href;
const logUrl    = pathToFileURL(resolve(__dirname, '../../agent-scope/lib/log.mjs')).href;
const denialUrl = pathToFileURL(resolve(__dirname, '../../agent-scope/lib/denial.mjs')).href;
const parseUrl  = pathToFileURL(resolve(__dirname, '../../agent-scope/lib/shell-parse.mjs')).href;
const {
  resolveRepoRoot, resolveActiveTaskId, loadTask, checkPath, checkNodeVersion,
} = await import(scopeUrl);
const { logDenial } = await import(logUrl);
const { buildAfterShellContext } = await import(denialUrl);
const { extractTaskCreateId, approvedTaskCreateWrites } = await import(parseUrl);

try { checkNodeVersion(); } catch (e) {
  process.stderr.write(e.message + '\n');
  process.stdout.write('{}');
  process.exit(0);
}

function emit(obj) { process.stdout.write(JSON.stringify(obj)); process.exit(0); }
function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function gitPorcelain(root) {
  try {
    return execSync('git status --porcelain', {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { return null; }
}

function parsePorcelain(out) {
  const results = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const status = line.slice(0, 2);
    const rest = line.slice(3);
    const arrow = rest.indexOf(' -> ');
    const path = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    results.push({ status, path: path.replace(/^"|"$/g, '') });
  }
  return results;
}

async function main() {
  const raw = readStdin();
  let shellPayload = {};
  try { shellPayload = raw ? JSON.parse(raw) : {}; } catch { shellPayload = {}; }
  const command = shellPayload.command || shellPayload.shell_command || '';
  const sessionId = shellPayload.session_id || null;

  const root = resolveRepoRoot();
  const { id: taskId } = resolveActiveTaskId(root);

  let task = null;
  if (taskId) { try { task = loadTask(root, taskId); } catch { return emit({}); } }

  const porcelain = gitPorcelain(root);
  if (porcelain === null) return emit({});

  // Approved-task-create allowlist: if the command that just ran was
  // `pnpm task create <id>` (or the canonical node equivalent), we allow
  // the two specific files that command legitimately writes —
  //   agent-scope/tasks/<id>.json
  //   agent-scope/active
  // Every other protected-path write still gets reverted/deleted.
  const approvedId = extractTaskCreateId(command);
  const approvedWrites = approvedTaskCreateWrites(approvedId);
  const approved = [];

  const entries = parsePorcelain(porcelain);
  const outOfScope = entries.filter(({ path }) => {
    if (!path) return false;
    const d = checkPath(task, path, root);
    if (d !== 'deny' && d !== 'protected') return false;
    if (approvedWrites.has(path)) { approved.push(path); return false; }
    return true;
  });

  if (approved.length) {
    for (const p of approved) {
      logDenial(root, {
        event: 'afterShell.approved-create',
        tool: 'Shell',
        path: p,
        task: approvedId,
        command,
        sessionId,
      });
    }
  }

  if (outOfScope.length === 0) return emit({});

  const reverted = [];
  const deleted = [];
  const unreverted = [];
  for (const { status, path } of outOfScope) {
    if (status.startsWith('??')) {
      // Untracked new file in a denied location → delete it.
      // This prevents agents from bypassing pre-shell (e.g. via `node -e`) to
      // establish persistent state in protected paths. Directories are handled
      // by recursive removal.
      try {
        const abs = resolve(root, path);
        if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
        deleted.push(path);
      } catch (e) {
        unreverted.push({ status, path, reason: (e?.message || 'unknown').split('\n')[0] });
      }
      continue;
    }
    try {
      execSync(`git checkout -- ${JSON.stringify(path)}`, {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      });
      reverted.push(path);
    } catch (e) {
      unreverted.push({ status, path, reason: (e?.message || 'unknown').split('\n')[0] });
    }
  }

  for (const p of reverted) {
    logDenial(root, { event: 'afterShell.revert', tool: 'Shell', path: p, task: taskId, command, sessionId });
  }
  for (const p of deleted) {
    logDenial(root, { event: 'afterShell.delete', tool: 'Shell', path: p, task: taskId, command, sessionId });
  }
  for (const u of unreverted) {
    logDenial(root, { event: 'afterShell.unreverted', tool: 'Shell', path: u.path, task: taskId, command, sessionId });
  }

  const { message } = buildAfterShellContext({
    command, task, taskId, root,
    reverted, deleted, unreverted,
  });
  emit({ additional_context: message });
}

main().catch(err => {
  process.stderr.write(`shell-diff-check error: ${err?.message || err}\n`);
  emit({});
});
