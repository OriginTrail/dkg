// Onboarding marker + clipboard helpers for `pnpm task start --smart`.
//
// The default `pnpm task start` is now a fully interactive CLI wizard that
// never involves the agent. This module powers the `--smart` mode, where
// the user pastes a task description in the CLI and the agent then reads
// that description, explores the repo, and proposes a scope.
//
// Flow:
//
//   1. `pnpm task start --smart` reads a multi-line description from the
//      user, then drops a one-shot marker file at
//      `agent-scope/.pending-onboarding`. The marker contains both the
//      trigger text AND the user's description, so the agent does not need
//      to ask the user "describe the task" again.
//   2. The user sends any message in any chat.
//   3. THREE parallel consumers pick up the marker — whichever runs first
//      wins, because consume is atomic (read-and-delete):
//
//        (a) `sessionStart` hook — fires on a brand new chat.
//        (b) `postToolUse` hook  — fires after any tool call in an existing
//            chat (Cursor + Claude Code).
//        (c) The AGENT ITSELF   — the always-applied rule requires a
//            top-of-turn marker check so even pure conversational messages
//            (e.g. "hi") consume the marker correctly.
//
//   4. The agent follows the "Smart onboarding protocol" (CLAUDE.md,
//      .cursor/rules/agent-scope.mdc, AGENTS.md, GEMINI.md).
//
// Zero runtime deps. Pure-ish (spawnSync for clipboard; filesystem for marker).

import { writeFileSync, readFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';

export const ONBOARDING_MARKER_REL = 'agent-scope/.pending-onboarding';
export const DESCRIPTION_OPEN  = '=== USER TASK DESCRIPTION (already provided — do NOT ask again) ===';
export const DESCRIPTION_CLOSE = '=== END DESCRIPTION ===';

// Build the marker / trigger payload. If `description` is provided, the
// agent is told the user has already described the task; otherwise the
// agent is told to ask for a description (used for tests + edge cases only
// — in practice the CLI refuses to drop a marker without a description).
//
// Keep the first line stable: hooks and rules key off the prefix
// `agent-scope: start task onboarding.`.
export function buildOnboardingTrigger({ description = '' } = {}) {
  const desc = typeof description === 'string' ? description.trim() : '';
  const hasDesc = desc.length > 0;

  const descBlock = hasDesc
    ? [
        '',
        DESCRIPTION_OPEN,
        desc,
        DESCRIPTION_CLOSE,
        '',
      ]
    : [];

  return [
    'agent-scope: start task onboarding.',
    '',
    hasDesc
      ? 'The user ran `pnpm task start --smart` and has already provided their task description below. DO NOT ask them to describe it again — use the description as your brief.'
      : 'The user ran `pnpm task start --smart` but did not include a description. Ask them to describe the task in detail before proceeding.',
    ...descBlock,
    'Smart onboarding protocol — follow EXACTLY (full text in CLAUDE.md,',
    '.cursor/rules/agent-scope.mdc, AGENTS.md, GEMINI.md):',
    '',
    '  1. Stop whatever you were about to do on this turn.',
    '  2. Delete `agent-scope/.pending-onboarding` if it still exists.',
    hasDesc
      ? '  3. Read the description above. Do not ask the user to describe it.'
      : '  3. Ask the user in plain chat to describe the task in detail; wait for reply.',
    '  4. Explore the codebase — Glob, Grep, Read, SemanticSearch, DKG —',
    '     to find the files the task will touch.',
    '  5. Draft a conservative set of allowed globs:',
    '       - inherit `base` (standard build-artefact exemptions)',
    '       - append `!**/secrets.*` and `!**/.env*` safety denies',
    '       - prefer whole-package globs (packages/<name>/**) over files',
    '         when in doubt — over-scoping is safe, under-scoping causes',
    '         constant denials mid-work.',
    '  6. Propose the scope via a SINGLE `AskQuestion` call with TWO questions:',
    '',
    '       Q1 (allow_multiple = true):',
    '         prompt: "Which packages should be writable for this task?"',
    '         options: one entry per candidate package, labelled',
    '                  "<pkg-path> — <N> files match description keywords"',
    '                  plus a sample of 2-3 relevant paths where helpful.',
    '         pre-check: the packages you already decided to include.',
    '',
    '       Q2 (single-select):',
    '         prompt: "Action?"',
    '         options:',
    '           - approve — "Create + activate this scope"',
    '           - show_json — "Show the full manifest JSON first"',
    '           - edit_globs — "Let me hand-edit the allowed/deny globs"',
    '           - widen — "Let me add another package/file"',
    '           - narrow — "Let me remove a package/file"',
    '           - cancel — "Abort, no task"',
    '           - custom_instruction — "Let me type my own instruction"',
    '',
    '  7. On `approve` (Q2) with the Q1 selection:',
    '     Print a fenced bash block with the EXACT `pnpm task create ...',
    '     --activate` command. Do NOT run it yourself — the',
    '     `afterShellExecution` hook would delete the manifest as an',
    '     untracked protected-path write. The user runs it.',
    '',
    '  8. On `show_json`: print the drafted manifest, then re-ask step 6.',
    '  9. On `edit_globs` / `widen` / `narrow`: ask one follow-up in chat,',
    '     update the draft, then re-ask step 6.',
    ' 10. On `cancel`: acknowledge, no task is set, continue unscoped.',
    ' 11. On `custom_instruction`: ask in plain chat, then do what the user',
    '     says.',
    '',
    'Your onboarding turn starts now. Skip any other pending work until the',
    'scope is approved or cancelled.',
  ].join('\n');
}

// Description-less trigger, kept as an export for backwards compatibility
// (existing hooks inject this text; existing tests assert its shape). New
// code should call `buildOnboardingTrigger({ description })`.
export const ONBOARDING_TRIGGER_TEXT = buildOnboardingTrigger();

// Extract the description back out of a marker payload. Returns the
// description string, or '' if the marker had no description block.
// Tolerant of whitespace and trailing noise.
export function extractDescription(payload) {
  if (typeof payload !== 'string' || !payload.length) return '';
  const open  = payload.indexOf(DESCRIPTION_OPEN);
  const close = payload.indexOf(DESCRIPTION_CLOSE);
  if (open < 0 || close < 0 || close < open) return '';
  const start = open + DESCRIPTION_OPEN.length;
  return payload.slice(start, close).trim();
}

// ---------------------------------------------------------------------------
// Marker file lifecycle
// ---------------------------------------------------------------------------

export function onboardingMarkerPath(root) {
  return resolve(root, ONBOARDING_MARKER_REL);
}

export function writeOnboardingMarker(root, payload = ONBOARDING_TRIGGER_TEXT) {
  const p = onboardingMarkerPath(root);
  writeFileSync(p, payload, 'utf8');
  return p;
}

export function hasOnboardingMarker(root) {
  try { return existsSync(onboardingMarkerPath(root)); } catch { return false; }
}

export function readOnboardingMarker(root) {
  try {
    const p = onboardingMarkerPath(root);
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8');
  } catch { return null; }
}

// Read-and-delete. Used by hooks so the trigger fires exactly once.
export function consumeOnboardingMarker(root) {
  const p = onboardingMarkerPath(root);
  try {
    if (!existsSync(p)) return null;
    const payload = readFileSync(p, 'utf8');
    try { unlinkSync(p); } catch { try { rmSync(p, { force: true }); } catch {} }
    return payload;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Cross-platform clipboard copy (best-effort)
// ---------------------------------------------------------------------------

// Try a chain of clipboard commands; first that succeeds wins. Returns
// { ok: true, method: 'pbcopy' } on success or { ok: false, reason } on
// failure. Always swallows errors — clipboard is a UX nicety, not a contract.
export function copyToClipboard(text) {
  const os = platform();
  const attempts = [];

  if (os === 'darwin') {
    attempts.push(['pbcopy', []]);
  } else if (os === 'win32') {
    attempts.push(['clip', []]);
  } else if (os === 'linux') {
    attempts.push(['wl-copy', []]);
    attempts.push(['xclip', ['-selection', 'clipboard']]);
    attempts.push(['xsel', ['--clipboard', '--input']]);
  }

  attempts.push(['pbcopy', []]);

  for (const [cmd, args] of attempts) {
    const res = spawnSync(cmd, args, {
      input: text,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 2000,
    });
    if (res.status === 0 && !res.error) {
      return { ok: true, method: cmd };
    }
  }
  return { ok: false, reason: 'no clipboard tool available on this system' };
}
