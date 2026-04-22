// Builds structured denial payloads for every agent-scope enforcement layer.
// Each denial carries a short human-readable summary AND a machine-readable
// JSON block delimited by the `agent-scope-menu` fence.
//
// Agents are instructed (via CLAUDE.md + .cursor/rules/agent-scope.mdc +
// AGENTS.md) to:
//   1. Quote `humanSummary` in their AskQuestion prompt (keep it short and
//      natural — like a chat message to a coworker).
//   2. Offer only the two entries in `simpleOptions` — the LLM-recommended
//      action plus a free-text fallback. Never surface the full `options`
//      list to the user; it exists for audit / back-compat / tests.
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

// Shorter version used in the two-option `simpleOptions` surface — this is
// the label the user sees in the plan-mode AskQuestion, so it should read
// like a chat button, not a legal clause.
const CUSTOM_OPTION_SIMPLE = {
  id: 'custom_instruction',
  label: 'Something else — tell me what',
  action: { kind: 'custom' },
};

// Short, natural-language label for the recommended action. The full
// `options` array keeps its verbose labels (back-compat + audit), but the
// plan-mode AskQuestion uses these casual ones so the prompt reads like a
// human wrote it. Falls back to the verbose label if the id is unknown.
function simpleLabelFor(optionId, { deniedPath, activeTaskId, altTaskId } = {}) {
  if (optionId === 'add_file')   return 'Add this file to the task and try again';
  if (optionId === 'add_glob')   return 'Add this folder to the task and try again';
  if (optionId === 'bootstrap')  return 'Yes, unlock it so I can do this edit';
  if (optionId === 'cancel')     return 'Skip it';
  if (optionId === 'skip')       return 'Skip and keep working on other things';
  if (optionId === 'fix_manifest') return 'Open the task file so I can fix it';
  if (optionId === 'clear_task') return 'Clear the active task for now';
  if (optionId === 'acknowledge') return 'OK, keep going';
  if (optionId && optionId.startsWith('switch_task_') && altTaskId) {
    return `Switch to task "${altTaskId}" and try again`;
  }
  return null;
}

// Build the two-option `simpleOptions` array for plan-mode AskQuestion.
// It always contains exactly two entries: the recommended option (with a
// short human label) and a free-text fallback.
function buildSimpleOptions(fullOptions, recommendedId) {
  const rec = fullOptions.find(o => o.id === recommendedId) || fullOptions[0];
  if (!rec) return [CUSTOM_OPTION_SIMPLE];
  const altTaskId = rec.id.startsWith('switch_task_') ? rec.id.slice('switch_task_'.length) : null;
  const label = simpleLabelFor(rec.id, { altTaskId }) || rec.label;
  return [
    { id: rec.id, label, action: rec.action },
    CUSTOM_OPTION_SIMPLE,
  ];
}

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

// Emit a short human-readable summary and append the machine-readable JSON
// block. Agents are instructed to quote `humanSummary` verbatim in their
// AskQuestion prompt and offer only the two `simpleOptions` — never the
// full `options` list.
function render(summary, structured) {
  return [
    `agent-scope: ${summary}`,
    '',
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
    const recommendedOptionId = recommendFor('protected', options);
    const humanSummary =
      `I'd like to edit \`${deniedPath}\`, but it's ${classification.role}. ` +
      `It's locked on purpose so an agent can't silently reshape its own guardrails — ` +
      `unlocking needs your OK.`;
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
      humanSummary,
      options,
      simpleOptions: buildSimpleOptions(options, recommendedOptionId),
      recommendedOptionId,
      agentReasoning: null,
    };
    return { message: render(humanSummary, structured), structured };
  }

  // out-of-scope (deny)
  const alternatives = findAlternativeTasks(deniedPath, root, taskId);
  const options = buildOutOfScopeOptions({ deniedPath, activeTaskId: taskId, alternatives });
  const recommendedOptionId = recommendFor('out-of-scope', options);
  const positives  = ((task && task.allowed)    || []).filter(p => !p.startsWith('!'));
  const exemptions = ((task && task.exemptions) || []).filter(p => !p.startsWith('!'));
  const humanSummary =
    `I'd like to edit \`${deniedPath}\`, but the active task ` +
    `${taskId ? `\`${taskId}\`` : '(none)'}` +
    `${task && task.description ? ` — ${task.description}` : ''}` +
    ` doesn't cover that file.`;
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
    humanSummary,
    options,
    simpleOptions: buildSimpleOptions(options, recommendedOptionId),
    recommendedOptionId,
    agentReasoning: null,
  };
  return { message: render(humanSummary, structured), structured };
}

// Build a manifest-load-error denial message.
export function buildLoadErrorDenial({ taskId, error }) {
  const options = buildLoadErrorOptions({ taskId, error });
  const recommendedOptionId = recommendFor('manifest-load-error', options);
  const humanSummary =
    `The active task manifest \`${taskId}\` won't load — ${error}. ` +
    `I can't apply any scope check until it's fixed or cleared.`;
  const structured = {
    version: 1,
    hook: 'preToolUse',
    reason: 'manifest-load-error',
    activeTask: taskId,
    error,
    humanSummary,
    options,
    simpleOptions: buildSimpleOptions(options, recommendedOptionId),
    recommendedOptionId,
    agentReasoning: null,
  };
  return { message: render(humanSummary, structured), structured };
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

  const recommendedOptionId = recommendFor(reason, options);
  const firstPath = firstProtPath || firstScopePath || '(target)';
  const firstCmd = violations[0]?.cmd || 'command';
  const humanSummary =
    reason === 'protected'
      ? `The shell command I was about to run (\`${firstCmd}\` on \`${firstPath}\`) ` +
        `would touch a protected system file. Blocked before it ran.`
      : reason === 'out-of-scope'
      ? `The shell command I was about to run (\`${firstCmd}\` on \`${firstPath}\`) ` +
        `would write outside the active task \`${taskId || '(none)'}\`. Blocked before it ran.`
      : `That shell command was blocked before it ran.`;

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
    humanSummary,
    options,
    simpleOptions: buildSimpleOptions(options, recommendedOptionId),
    recommendedOptionId,
    agentReasoning: null,
  };

  return { message: render(humanSummary, structured), structured };
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

  const recommendedOptionId = recommendFor(reason, options);
  const touchedCount = reverted.length + deleted.length;
  const humanSummary = (() => {
    if (touchedCount === 0) {
      return `A shell command ran and finished cleanly — nothing needed to be reverted.`;
    }
    const bits = [];
    if (reverted.length) bits.push(`reverted ${reverted.length} file${reverted.length === 1 ? '' : 's'}`);
    if (deleted.length)  bits.push(`deleted ${deleted.length} new file${deleted.length === 1 ? '' : 's'}`);
    const fix = bits.join(' and ');
    if (reason === 'protected') {
      return `A shell command touched a protected system file, so I ${fix} to put things back.`;
    }
    if (reason === 'out-of-scope') {
      return `A shell command touched files outside the active task \`${taskId}\`, so I ${fix} to put things back.`;
    }
    return `A shell command touched files it shouldn't have, so I ${fix}.`;
  })();

  const structured = {
    version: 1,
    hook: 'afterShellExecution',
    reason,
    command,
    activeTask: taskId || null,
    reverted,
    deleted,
    unreverted: unreverted.map(u => ({ path: u.path, status: u.status, reason: u.reason })),
    humanSummary,
    options,
    simpleOptions: buildSimpleOptions(options, recommendedOptionId),
    recommendedOptionId,
    agentReasoning: null,
  };

  // Prose stays minimal: the humanSummary + paths the agent may want to
  // reference. No banners, no STOP, no agent-directed meta copy.
  const lines = [humanSummary];
  if (reverted.length) {
    lines.push('', 'Reverted:');
    for (const p of reverted) lines.push(`  - ${p}`);
  }
  if (deleted.length) {
    lines.push('', 'Deleted:');
    for (const p of deleted) lines.push(`  - ${p}`);
  }
  if (unreverted.length) {
    lines.push('', 'Could not revert (please review):');
    for (const u of unreverted) lines.push(`  - ${u.path}  [${u.status}] ${u.reason}`);
  }

  return { message: render(lines.join('\n'), structured), structured };
}
