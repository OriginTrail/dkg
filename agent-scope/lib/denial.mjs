// Builds structured denial payloads for every agent-scope enforcement layer.
// Each denial carries both a human-readable prose block AND a machine-readable
// JSON block delimited by the `agent-scope-menu` fence. Agents are instructed
// (via CLAUDE.md + .cursor/rules/agent-scope.mdc) to parse the JSON and surface
// the `options` array via AskQuestion — the plan-mode equivalent for denials.
//
// Zero IO, zero deps. Pure functions; unit-testable.

import { listTasks, loadTask, checkPath, PROTECTED_PATTERNS } from './scope.mjs';

export const DENIAL_FENCE_START = '<!-- agent-scope-menu:begin -->';
export const DENIAL_FENCE_END   = '<!-- agent-scope-menu:end -->';

// ---------------------------------------------------------------------------
// Suggestion heuristics
// ---------------------------------------------------------------------------

// Propose a single representative glob for a denied path. Conservative: covers
// the immediate parent directory's subtree. Callers can suggest tighter globs
// interactively if the user prefers.
export function suggestGlob(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  const clean = relPath.replace(/\/+$/, '');
  const slash = clean.lastIndexOf('/');
  if (slash < 0) return clean;
  const dir = clean.slice(0, slash);
  return `${dir}/**`;
}

// Propose a tighter glob targeting the exact basename stem (same directory,
// any extension). Useful when the agent is likely to touch sibling files.
export function suggestTightGlob(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  const clean = relPath.replace(/\/+$/, '');
  const slash = clean.lastIndexOf('/');
  const base = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = base.indexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  if (!stem) return null;
  const dir = slash >= 0 ? clean.slice(0, slash) : '';
  return dir ? `${dir}/${stem}*` : `${stem}*`;
}

// Find other task manifests whose scope already covers the denied path.
// Skips the currently-active task. Protected paths have no alternatives.
export function findAlternativeTasks(relPath, root, excludeTaskId = null) {
  if (!relPath || !root) return [];
  const out = [];
  let ids = [];
  try { ids = listTasks(root); } catch { return []; }
  for (const id of ids) {
    if (id === excludeTaskId) continue;
    let t;
    try { t = loadTask(root, id); } catch { continue; }
    let d;
    try { d = checkPath(t, relPath, root); } catch { continue; }
    if (d === 'allow' || d === 'exempt') {
      out.push({ id, description: t.description || '' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Option menus
// ---------------------------------------------------------------------------

// A free-text fallback. Included in every menu so the user can bypass the
// presets entirely. When picked, the agent asks the user to describe what to
// do next as a regular chat message.
const CUSTOM_OPTION = {
  id: 'custom_instruction',
  label: 'Let me type my own instruction',
  action: { kind: 'custom' },
};

// Menu for out-of-scope write denials (path is in the repo but not in scope).
export function buildOutOfScopeOptions({ deniedPath, activeTaskId, alternatives }) {
  const opts = [
    {
      id: 'add_file',
      label: `Add "${deniedPath}" to ${activeTaskId}'s manifest`,
      action: { kind: 'add_to_manifest', task: activeTaskId, patterns: [deniedPath] },
    },
    {
      id: 'add_glob',
      label: `Add "${suggestGlob(deniedPath)}" to ${activeTaskId}'s manifest`,
      action: { kind: 'add_to_manifest', task: activeTaskId, patterns: [suggestGlob(deniedPath)] },
    },
  ];
  if (Array.isArray(alternatives) && alternatives.length) {
    for (const alt of alternatives.slice(0, 3)) {
      opts.push({
        id: `switch_task_${alt.id}`,
        label: `Switch active task to "${alt.id}"` + (alt.description ? ` — ${alt.description}` : ''),
        action: { kind: 'switch_task', task: alt.id },
      });
    }
  }
  opts.push(
    { id: 'skip',   label: 'Skip this edit, keep working on in-scope files', action: { kind: 'skip' } },
    { id: 'cancel', label: 'Cancel this turn — the edit should not happen',  action: { kind: 'cancel' } },
    CUSTOM_OPTION,
  );
  return opts;
}

// Classify a protected path so the denial prose can explain WHY that specific
// file is guarded, not just that it is. Keeps the menu copy concrete.
export function classifyProtected(relPath) {
  if (!relPath || typeof relPath !== 'string') return { kind: 'unknown', role: 'protected file' };
  if (relPath.startsWith('.cursor/hooks/') || relPath === '.cursor/hooks.json') {
    return { kind: 'cursor-hook', role: 'a Cursor hook that enforces agent-scope in every session' };
  }
  if (relPath === '.cursor/rules/agent-scope.mdc') {
    return { kind: 'cursor-rule', role: 'the rule that tells the agent to surface denial menus via AskQuestion' };
  }
  if (relPath.startsWith('agent-scope/lib/')) {
    return { kind: 'scope-library', role: 'the shared enforcement library used by every hook' };
  }
  if (relPath.startsWith('agent-scope/bin/')) {
    return { kind: 'scope-cli', role: 'the `pnpm task` CLI — if modified, the whole task workflow can be subverted' };
  }
  if (relPath.startsWith('agent-scope/schema/')) {
    return { kind: 'scope-schema', role: 'the JSON schema that validates every task manifest' };
  }
  if (relPath.startsWith('agent-scope/tasks/')) {
    return { kind: 'task-manifest', role: 'a task manifest — editing it would silently expand or shrink what agents can write' };
  }
  if (relPath === 'agent-scope/active') {
    return { kind: 'active-pointer', role: 'the active-task pointer — editing it would let the agent pick its own scope' };
  }
  if (relPath === 'agent-scope/.bootstrap-token') {
    return { kind: 'bootstrap-token', role: 'the bootstrap token itself — writing it would self-grant full access' };
  }
  return { kind: 'unknown', role: 'a file on the hardcoded protected list' };
}

// Menu for protected-path denials — only the human can unlock.
export function buildProtectedOptions({ deniedPath }) {
  return [
    {
      id: 'bootstrap',
      label: `Yes — let the agent edit "${deniedPath}" (enable bootstrap, then re-lock after)`,
      action: {
        kind: 'bootstrap',
        instruction: 'In your own terminal run:\n    touch agent-scope/.bootstrap-token\nThen reply "go". When I\'m done, run:\n    rm agent-scope/.bootstrap-token\nto re-lock the system.',
      },
    },
    {
      id: 'cancel',
      label: 'No — do not edit this file; cancel the operation',
      action: { kind: 'cancel' },
    },
    {
      id: 'skip',
      label: 'No — skip this edit, but keep working on other things',
      action: { kind: 'skip' },
    },
    CUSTOM_OPTION,
  ];
}

// Menu for manifest load errors — the task file is broken.
export function buildLoadErrorOptions({ taskId, error }) {
  return [
    {
      id: 'fix_manifest',
      label: `Open and fix agent-scope/tasks/${taskId}.json`,
      action: { kind: 'fix_manifest', task: taskId, error },
    },
    {
      id: 'clear_task',
      label: 'Clear the active task for now (pnpm task clear)',
      action: { kind: 'clear_task' },
    },
    { id: 'cancel', label: 'Cancel this turn', action: { kind: 'cancel' } },
    CUSTOM_OPTION,
  ];
}

// Pick a sensible default for the highlighted option. Agents are instructed
// to respect this when surfacing the menu via AskQuestion, but it's only a
// recommendation — the user is always free to choose anything.
function recommendFor(reason, options) {
  const ids = new Set(options.map(o => o.id));
  if (reason === 'out-of-scope') {
    if (ids.has('add_glob')) return 'add_glob';
    if (ids.has('add_file')) return 'add_file';
  }
  if (reason === 'protected') {
    return 'cancel'; // safest default; user opts into bootstrap deliberately
  }
  if (reason === 'manifest-load-error') {
    if (ids.has('fix_manifest')) return 'fix_manifest';
  }
  return options[0]?.id || null;
}

// ---------------------------------------------------------------------------
// Full denial message builders (prose + structured block)
// ---------------------------------------------------------------------------

function wrapStructured(payload) {
  return [
    DENIAL_FENCE_START,
    JSON.stringify(payload, null, 2),
    DENIAL_FENCE_END,
  ].join('\n');
}

// Emit the human-readable prose and append the machine-readable JSON block.
// Agents are expected to find the fence and call AskQuestion with `options`.
function render(prose, structured) {
  return [
    prose.trim(),
    '',
    '⇣  Plan-mode menu (agent: surface these options via AskQuestion):',
    wrapStructured(structured),
  ].join('\n');
}

// Build a preToolUse denial message.
export function buildPreToolUseDenial({
  tool, deniedPath, decision, task, taskId, root,
}) {
  if (decision === 'protected') {
    const classification = classifyProtected(deniedPath);
    const options = buildProtectedOptions({ deniedPath });
    const structured = {
      version: 1,
      hook: 'preToolUse',
      reason: 'protected',
      tool,
      deniedPath,
      protectedKind: classification.kind,
      protectedRole: classification.role,
      activeTask: taskId || null,
      protectedPatterns: [...PROTECTED_PATTERNS],
      options,
      recommendedOptionId: recommendFor('protected', options),
      agentReasoning: null,
    };
    const prose = [
      `PROTECTED PATH — ${tool} on "${deniedPath}" was blocked by agent-scope.`,
      ``,
      `Why this file is guarded:`,
      `  ${deniedPath} is ${classification.role}.`,
      `  Letting an agent edit it would let the agent disable or reshape its own`,
      `  enforcement. That's why it's always denied until a human explicitly`,
      `  opts in — even when no task is active.`,
      ``,
      `What happens if the user says YES (enable bootstrap):`,
      `  The human runs \`touch agent-scope/.bootstrap-token\` in their own`,
      `  terminal. For as long as that file exists, ALL protection is disabled`,
      `  (both protected paths and task-scope checks). After the edit is done,`,
      `  they run \`rm agent-scope/.bootstrap-token\` to re-lock the system.`,
      ``,
      `What happens if the user says NO:`,
      `  The edit is cancelled (or skipped). No hidden retries — the other`,
      `  hooks would revert it anyway.`,
      ``,
      `Agent: surface the menu below via AskQuestion. Include a 1–2 sentence`,
      `explanation of WHY you wanted to touch this file (your reasoning) and`,
      `lead with the recommended option unless you have concrete grounds to`,
      `override it.`,
    ].join('\n');
    return { message: render(prose, structured), structured };
  }

  // out-of-scope (deny)
  const alternatives = findAlternativeTasks(deniedPath, root, taskId);
  const options = buildOutOfScopeOptions({ deniedPath, activeTaskId: taskId, alternatives });
  const positives  = ((task && task.allowed)    || []).filter(p => !p.startsWith('!'));
  const exemptions = ((task && task.exemptions) || []).filter(p => !p.startsWith('!'));
  const structured = {
    version: 1,
    hook: 'preToolUse',
    reason: 'out-of-scope',
    tool,
    deniedPath,
    activeTask: taskId || null,
    activeTaskDescription: (task && task.description) || null,
    allowed: positives,
    exemptions,
    suggestedGlob: suggestGlob(deniedPath),
    suggestedTightGlob: suggestTightGlob(deniedPath),
    alternativeTasks: alternatives,
    options,
    recommendedOptionId: recommendFor('out-of-scope', options),
    agentReasoning: null,
  };
  const prose = [
    `OUT OF TASK SCOPE — ${tool} blocked by agent-scope.`,
    `  Active task: ${taskId}${task && task.description ? ` — ${task.description}` : ''}`,
    `  Denied path: ${deniedPath}`,
    ``,
    `This task only permits writes matching:`,
    ...(positives.length ? positives.map(p => `    - ${p}`) : ['    (nothing — manifest has no positive allows)']),
    ...(exemptions.length ? ['', 'Plus always-allowed exemptions:', ...exemptions.map(p => `    - ${p}`)] : []),
    ``,
    `STOP. Do not retry via another tool or a different command form. Use the`,
    `plan-mode menu below to ask the user how to proceed.`,
  ].join('\n');
  return { message: render(prose, structured), structured };
}

// Build a manifest-load-error denial message.
export function buildLoadErrorDenial({ taskId, error }) {
  const options = buildLoadErrorOptions({ taskId, error });
  const structured = {
    version: 1,
    hook: 'preToolUse',
    reason: 'manifest-load-error',
    activeTask: taskId,
    error,
    options,
    recommendedOptionId: recommendFor('manifest-load-error', options),
    agentReasoning: null,
  };
  const prose = [
    `agent-scope: failed to load active task manifest "${taskId}".`,
    `  Error: ${error}`,
    ``,
    `Fix agent-scope/tasks/${taskId}.json or clear the active task.`,
  ].join('\n');
  return { message: render(prose, structured), structured };
}

// Build a beforeShellExecution denial message from a set of violations.
// A violation is { sub, cmd, path, decision }.
export function buildShellPrecheckDenial({
  command, violations, task, taskId, root,
}) {
  const anyProtected = violations.some(v => String(v.decision).startsWith('protected'));
  // Use the first out-of-scope path (if any) to seed the menu; if everything
  // is protected, show the protected menu. If mixed, protected wins because
  // the user needs bootstrap before we can address scope fixes.
  let reason, options, suggestedFix;
  const firstScopePath = violations.find(v => v.decision === 'deny')?.path || null;
  const firstProtPath  = violations.find(v => String(v.decision).startsWith('protected'))?.path || null;

  if (anyProtected) {
    reason = 'protected';
    options = buildProtectedOptions({ deniedPath: firstProtPath || '(protected target)' });
    suggestedFix = 'enable bootstrap — see options';
  } else if (firstScopePath) {
    reason = 'out-of-scope';
    const alternatives = findAlternativeTasks(firstScopePath, root, taskId);
    options = buildOutOfScopeOptions({
      deniedPath: firstScopePath, activeTaskId: taskId, alternatives,
    });
    suggestedFix = `add "${suggestGlob(firstScopePath)}" to ${taskId}'s manifest`;
  } else {
    reason = 'unknown';
    options = [
      { id: 'skip',   label: 'Skip this command',     action: { kind: 'skip' } },
      { id: 'cancel', label: 'Cancel this turn',      action: { kind: 'cancel' } },
      CUSTOM_OPTION,
    ];
    suggestedFix = null;
  }

  const structured = {
    version: 1,
    hook: 'beforeShellExecution',
    reason,
    command,
    activeTask: taskId || null,
    violations: violations.map(v => ({
      cmd: v.cmd, path: v.path, decision: v.decision,
    })),
    suggestedFix,
    options,
    recommendedOptionId: recommendFor(reason, options),
    agentReasoning: null,
  };

  const prose = [
    `Destructive shell command blocked by agent-scope pre-shell guard.`,
    `  Active task: ${task ? task.id : '(none — only system protection applies)'}`,
    ``,
    `Violations:`,
    ...violations.map(v => `    - ${v.cmd} ${v.path}  [${v.decision}]`),
    ``,
    `STOP. The post-exec backstop would revert tracked files and delete`,
    `untracked ones in denied paths anyway; use the menu below instead of`,
    `retrying with a different command form.`,
  ].join('\n');
  return { message: render(prose, structured), structured };
}

// Build an afterShellExecution context message. Unlike the other two this
// isn't a deny — the shell already ran. Files were reverted/deleted. Still
// emit a plan-mode menu so the agent surfaces the "what now?" question.
export function buildAfterShellContext({
  command, task, taskId, root,
  reverted, deleted, unreverted,
}) {
  reverted = Array.isArray(reverted) ? reverted : [];
  deleted  = Array.isArray(deleted)  ? deleted  : [];
  unreverted = Array.isArray(unreverted) ? unreverted : [];

  const touched = [...reverted, ...deleted];
  const firstProtected = touched.find(p => {
    for (const pat of PROTECTED_PATTERNS) {
      const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
      if (re.test(p)) return true;
    }
    return false;
  });

  let options, reason;
  if (firstProtected) {
    reason = 'protected';
    options = buildProtectedOptions({ deniedPath: firstProtected });
  } else if (touched.length && taskId) {
    reason = 'out-of-scope';
    const alternatives = findAlternativeTasks(touched[0], root, taskId);
    options = buildOutOfScopeOptions({
      deniedPath: touched[0], activeTaskId: taskId, alternatives,
    });
  } else {
    reason = 'unknown';
    options = [
      { id: 'acknowledge', label: 'Acknowledged — continue with other work', action: { kind: 'skip' } },
      { id: 'cancel',      label: 'Cancel this turn',                        action: { kind: 'cancel' } },
      CUSTOM_OPTION,
    ];
  }

  const structured = {
    version: 1,
    hook: 'afterShellExecution',
    reason,
    command,
    activeTask: taskId || null,
    reverted,
    deleted,
    unreverted: unreverted.map(u => ({ path: u.path, status: u.status, reason: u.reason })),
    options,
    recommendedOptionId: recommendFor(reason, options),
    agentReasoning: null,
  };

  const lines = [
    `agent-scope: shell command modified out-of-task or protected files` +
      (task ? ` (task: ${task.id}).` : ' (no active task — only protected paths enforced).'),
  ];
  if (reverted.length) {
    lines.push('', 'Reverted via `git checkout --`:');
    for (const p of reverted) lines.push(`  - ${p}`);
  }
  if (deleted.length) {
    lines.push('', 'Deleted (untracked, not allowed to persist):');
    for (const p of deleted) lines.push(`  - ${p}`);
  }
  if (unreverted.length) {
    lines.push('', 'Could NOT revert (please review manually):');
    for (const u of unreverted) lines.push(`  - ${u.path}  [${u.status}] ${u.reason}`);
  }

  return { message: render(lines.join('\n'), structured), structured };
}
