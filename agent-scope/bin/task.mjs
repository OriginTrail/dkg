#!/usr/bin/env node
// Active-task management CLI.

import {
  readFileSync, writeFileSync, unlinkSync, existsSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import {
  resolveRepoRoot, resolveActiveTaskId, loadTask, checkPath,
  normalizeToRepoPath, listTasks, validateManifest, checkNodeVersion,
  isBootstrapActive,
} from '../lib/scope.mjs';
import {
  ONBOARDING_TRIGGER_TEXT,
  buildOnboardingTrigger,
  writeOnboardingMarker,
  copyToClipboard,
} from '../lib/onboarding.mjs';
import { detectAgents, statusGlyph, summary } from '../lib/check-agent.mjs';
import {
  discoverPackages,
  deriveTaskId,
  suggestPackagesFromDescription,
  buildManifest,
} from '../lib/wizard.mjs';
import { createPrompter } from '../lib/prompter.mjs';
import { spawnSync } from 'node:child_process';

try { checkNodeVersion(); }
catch (e) { console.error(e.message); process.exit(3); }

const root = resolveRepoRoot();
const tasksDir = resolve(root, 'agent-scope/tasks');
const activeFile = resolve(root, 'agent-scope/active');
const logsFile = resolve(root, 'agent-scope/logs/denials.jsonl');
const bootstrapToken = resolve(root, 'agent-scope/.bootstrap-token');

function bail(msg, code = 1) { console.error(`error: ${msg}`); process.exit(code); }

function bootstrapWarning() {
  if (isBootstrapActive(root)) {
    console.log('');
    console.log('!! BOOTSTRAP MODE ACTIVE — hardcoded path protection is DISABLED.');
    console.log(`!! Remove when done:  rm ${bootstrapToken}`);
    console.log('');
  }
}

// ---------------------------------------------------------------------------

function list() {
  const ids = listTasks(root);
  if (!ids.length) { console.log('(no task manifests found)'); return; }
  const { id: activeId } = resolveActiveTaskId(root);
  for (const id of ids) {
    let desc = '';
    try { desc = loadTask(root, id).description || ''; }
    catch { desc = '(invalid manifest — run: task validate ' + id + ')'; }
    const marker = id === activeId ? '* ' : '  ';
    console.log(`${marker}${id.padEnd(28)} ${desc}`);
  }
  bootstrapWarning();
}

function show() {
  const { id, source } = resolveActiveTaskId(root);
  if (!id) {
    console.log('No active task. Writes are unrestricted (except for protected paths).');
    console.log(`Set one with:  node agent-scope/bin/task.mjs set <id>`);
    bootstrapWarning();
    return;
  }
  const task = loadTask(root, id);
  console.log(`Active task:  ${task.id}`);
  console.log(`Description:  ${task.description || '(none)'}`);
  console.log(`Owner:        ${task.owner || '(unassigned)'}`);
  console.log(`Resolved via: ${source}`);
  console.log(`Manifest:     ${task.__path}`);
  if (task.__inheritedFrom && task.__inheritedFrom.length) {
    console.log(`Inherits:     ${task.__inheritedFrom.join(', ')}`);
  }
  console.log('');
  console.log('Allowed patterns:');
  for (const p of task.allowed || []) console.log(`  ${p.startsWith('!') ? '[deny] ' : '       '}${p}`);
  if (task.exemptions && task.exemptions.length) {
    console.log('Exemptions:');
    for (const p of task.exemptions) console.log(`  ${p.startsWith('!') ? '[deny] ' : '       '}${p}`);
  }
  if (task.notes) {
    console.log('');
    console.log('Notes:');
    console.log(`  ${task.notes.replace(/\n/g, '\n  ')}`);
  }
  bootstrapWarning();
}

function set(id) {
  if (!id) bail('usage: task set <id>');
  loadTask(root, id);
  writeFileSync(activeFile, `${id}\n`, 'utf8');
  console.log(`Active task set: ${id}`);
}

function clear() {
  if (existsSync(activeFile)) unlinkSync(activeFile);
  console.log('Active task cleared. Writes are unrestricted (except for protected paths).');
}

function check(p) {
  if (!p) bail('usage: task check <path>');
  const { id } = resolveActiveTaskId(root);
  const task = id ? loadTask(root, id) : null;
  const rel = normalizeToRepoPath(root, p);
  const decision = checkPath(task, rel, root);
  console.log(`${decision.padEnd(9)} ${rel}${id ? `  [task: ${id}]` : ''}`);
  if (decision === 'deny' || decision === 'protected') process.exit(1);
}

async function init(id) {
  if (!id) bail('usage: task init <id>');
  if (!/^[a-z0-9][a-z0-9-_.]{0,63}$/.test(id)) {
    bail(`invalid id: ${id} (must match /^[a-z0-9][a-z0-9-_.]{0,63}$/)`);
  }
  const manifestPath = resolve(tasksDir, `${id}.json`);
  if (existsSync(manifestPath)) bail(`manifest already exists: ${manifestPath}`);

  const rl = createInterface({ input, output, terminal: false });
  const buffered = [];
  const waiters = [];
  let closed = false;
  rl.on('line', line => {
    if (waiters.length) waiters.shift()(line);
    else buffered.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()('');
  });
  const ask = (q) => new Promise(resolve => {
    output.write(q);
    if (buffered.length) return resolve(buffered.shift());
    if (closed) return resolve('');
    waiters.push(resolve);
  });

  try {
    const description = (await ask('Description (one line): ')).trim();
    const owner = (await ask('Owner (free-form, blank ok): ')).trim();
    const inheritsStr = (await ask('Inherit from (comma-separated task ids, blank for [base]): ')).trim();
    const inherits = inheritsStr
      ? inheritsStr.split(',').map(s => s.trim()).filter(Boolean)
      : (listTasks(root).includes('base') ? ['base'] : []);
    output.write('\n');
    output.write('Enter allowed glob patterns, one per line. Blank line to finish.\n');
    output.write('Tip: prefix a pattern with ! to explicitly deny (e.g. !**/secrets.*)\n');
    const allowed = [];
    for (;;) {
      const line = (await ask('allowed> ')).trim();
      if (!line) break;
      allowed.push(line);
    }
    if (allowed.length === 0 && inherits.length === 0) {
      rl.close();
      bail('at least one allowed pattern is required (unless you inherit from another task)');
    }

    output.write('\n');
    output.write('Enter additional exemption patterns. Blank to finish.\n');
    const exemptions = [];
    for (;;) {
      const line = (await ask('exempt > ')).trim();
      if (!line) break;
      exemptions.push(line);
    }
    const notes = (await ask('Notes (blank ok): ')).trim();

    const manifest = {
      id,
      description: description || undefined,
      owner: owner || undefined,
      created: new Date().toISOString(),
      inherits: inherits.length ? inherits : undefined,
      allowed: allowed.length ? allowed : undefined,
      exemptions: exemptions.length ? exemptions : undefined,
      notes: notes || undefined,
    };
    const cleaned = Object.fromEntries(Object.entries(manifest).filter(([,v]) => v !== undefined));
    const errs = validateManifest(cleaned, id);
    if (errs.length) { rl.close(); bail(`invalid manifest:\n  - ${errs.join('\n  - ')}`); }

    writeFileSync(manifestPath, JSON.stringify(cleaned, null, 2) + '\n', 'utf8');
    console.log('');
    console.log(`Created ${manifestPath}`);
    console.log(`Activate with:  node agent-scope/bin/task.mjs set ${id}`);
  } finally { rl.close(); }
}

// ---------------------------------------------------------------------------
// Task onboarding
// ---------------------------------------------------------------------------
//
// Two independent ways to start a task:
//
//   (1) `pnpm task start` — default. Interactive CLI wizard that asks a few
//       questions (description, packages, extras), drafts a manifest,
//       previews it, and saves + activates it. No agent round-trip; works
//       identically in every agent and with no agent at all. Deterministic
//       keyword match.
//
//   (2) `pnpm task start --smart` — agent-guided mode. The CLI prompts
//       once for a multi-line task description, then drops a marker that
//       embeds that description + the Smart onboarding protocol. The next
//       message the user sends in any chat makes the agent read the
//       description, explore the repo, and propose a scope via a rich
//       AskQuestion (two questions: multi-select packages + action). The
//       agent prints a `pnpm task create ...` command for the user to run.
//
// If stdin is not a TTY we refuse — both modes need interactive input.
// For CI / scripts use `pnpm task create <id> --description ... --allowed
// ... --activate` directly.
// ---------------------------------------------------------------------------

async function start(argv = []) {
  const { id: activeId } = resolveActiveTaskId(root);
  if (activeId) {
    console.log(`A task is already active: ${activeId}`);
    console.log(`Run \`pnpm task clear\` first if you want to start a new one.`);
    console.log(`Run \`pnpm task show\` to see its scope.`);
    bootstrapWarning();
    return;
  }

  // Accept both --smart (canonical) and --chat (old name we're migrating
  // away from). If someone still has `--chat` in muscle memory, warn and
  // continue — don't make the rename a paper cut.
  const smartMode = argv.includes('--smart') || argv.includes('-s');
  const legacyChat = argv.includes('--chat') || argv.includes('-c');
  const forceInteractive = argv.includes('--interactive') || argv.includes('-i');
  const ttyOk = Boolean(process.stdin.isTTY) || forceInteractive;

  if (legacyChat) {
    console.error('warning: --chat was renamed to --smart; proceeding as --smart.');
  }

  if (!ttyOk) {
    console.error('error: `pnpm task start` requires an interactive terminal.');
    console.error('');
    console.error('For non-interactive / CI use, call `pnpm task create` directly:');
    console.error('  pnpm task create <id> --description "..." \\');
    console.error('    --allowed "packages/foo/**" --inherits base --activate');
    process.exit(2);
  }

  if (smartMode || legacyChat) return startSmart();
  await startInteractive();
}

async function startSmart() {
  console.log('agent-scope: smart task scoping');
  console.log('  (the agent will read your description, explore the repo, and propose a scope)');
  console.log('  (tip: `pnpm task start` without --smart runs the deterministic wizard instead)');
  console.log('');

  const prompter = createPrompter();
  let description = '';
  try {
    console.log('Describe the task — what to build or fix, which packages / behaviours');
    console.log('/ tests, and any files you already know about.');
    console.log('Press Enter to submit. (Multi-line pastes are captured in full.)');
    console.log('');
    description = await prompter.askPasteableDescription('> ');
  } finally {
    prompter.close();
  }

  const trimmed = description.trim();
  if (!trimmed || trimmed.length < 10) {
    bail('description is too short — smart mode needs at least a sentence of context');
  }

  const trigger = buildOnboardingTrigger({ description: trimmed });
  const markerPath = writeOnboardingMarker(root, trigger);
  const clip = copyToClipboard(trigger);

  console.log('');
  console.log(`agent-scope: captured ${trimmed.split(/\s+/).length} words.`);
  console.log('');
  console.log('Next step — exchange ONE short message with your agent:');
  console.log('');
  console.log('  1. Go to your Cursor / Claude Code / Codex / Gemini chat.');
  console.log('     Any chat works — new or existing.');
  console.log('  2. Send any message ("go", "hi", whatever).');
  console.log('  3. The agent reads your description, explores the repo, and');
  console.log('     proposes a scope via a plan-mode AskQuestion. One click to');
  console.log('     approve (or edit) the scope.');
  console.log('  4. Paste the generated `pnpm task create` command back here.');
  console.log('');
  if (clip.ok) {
    console.log(`(Trigger also copied to clipboard via ${clip.method} — pasting works too.)`);
  } else {
    console.log(`(Clipboard copy unavailable: ${clip.reason}. Paste is optional —`);
    console.log(` any message will trigger onboarding because of the marker file.)`);
  }
  console.log('');
  console.log(`Marker file: ${markerPath}`);
  console.log('(Auto-deleted the moment the agent reads it; one-shot.)');
  console.log('');
  console.log('Change your mind? `rm agent-scope/.pending-onboarding` and run');
  console.log('`pnpm task start` for the deterministic wizard instead.');
  bootstrapWarning();
}

async function startInteractive() {
  console.log('agent-scope: interactive task wizard');
  console.log('  (no agent needed — hit Ctrl+C any time to cancel, nothing is saved until the final "save" step.)');
  console.log('  (tip: for agent-guided onboarding instead, run `pnpm task start --chat`)');
  console.log('');

  const prompter = createPrompter();
  try {
    // 1) Description ---------------------------------------------------------
    const description = await askNonEmpty(
      prompter,
      'What are you working on? (one short sentence)\n> ',
      'A description is required so the task manifest is self-explanatory.',
    );
    console.log('');

    // 2) Task ID -------------------------------------------------------------
    const existingIds = listTasks(root);
    const suggestedId = deriveTaskId(description, { existingIds });
    const idInput = await prompter.ask(
      `Task id (press Enter to accept "${suggestedId}"): `,
      { default: suggestedId },
    );
    let taskId = idInput;
    if (!/^[a-z0-9][a-z0-9-_.]{0,63}$/.test(taskId)) {
      console.log(`  (invalid id "${taskId}" — falling back to "${suggestedId}")`);
      taskId = suggestedId;
    }
    if (existingIds.includes(taskId)) {
      const deduped = deriveTaskId(taskId + '-alt', { existingIds });
      console.log(`  (id "${taskId}" already exists — using "${deduped}")`);
      taskId = deduped;
    }
    const manifestPath = resolve(tasksDir, `${taskId}.json`);
    console.log('');

    // 3) Packages ------------------------------------------------------------
    const packages = discoverPackages(root);
    let selectedPackages = [];
    if (packages.length === 0) {
      console.log('No workspace packages detected — skipping package picker.');
      console.log('(You can add allowed globs freely in the next step.)');
    } else {
      const suggested = suggestPackagesFromDescription(description, packages);
      const suggestedSet = new Set(suggested.map(p => p.path));
      const suggestedIndices = [];
      printPackageList(packages, suggestedSet);
      packages.forEach((p, i) => {
        if (suggestedSet.has(p.path)) suggestedIndices.push(i + 1);
      });
      const prompt = suggestedIndices.length
        ? `Pick packages (space/comma separated; Enter = suggested [${suggestedIndices.join(' ')}]; type "none" for none): `
        : `Pick packages (space/comma separated; "none" or blank for none): `;
      const picked = await prompter.askMultiNumber(prompt, packages.length, {
        default: suggestedIndices,
      });
      selectedPackages = picked.map(i => packages[i - 1]).filter(Boolean);
      if (selectedPackages.length) {
        console.log(`  Selected: ${selectedPackages.map(p => p.name).join(', ')}`);
      } else {
        console.log('  No packages selected. You can still add custom allowed globs below.');
      }
    }
    console.log('');

    // 4) Build artefacts -----------------------------------------------------
    const includeBuildArtifacts = await prompter.askYesNo(
      'Include build artefacts + lockfile as exemptions (**/dist/**, *.tsbuildinfo, pnpm-lock.yaml)?',
      { default: true },
    );
    console.log('');

    // 5) Extras --------------------------------------------------------------
    const extraAllowed = await prompter.askLines(
      'Additional ALLOWED globs (optional):',
      { hint: 'one per line, blank to finish (e.g. scripts/dev.ts)' },
    );
    const extraDeny = await prompter.askLines(
      'Additional DENY globs (optional):',
      { hint: 'one per line, blank to finish (! is added automatically). secrets and .env* are denied by default.' },
    );
    console.log('');

    // 6) Build & preview -----------------------------------------------------
    const inheritBase = listTasks(root).includes('base');
    const manifest = buildManifest({
      id: taskId,
      description,
      selectedPackages,
      includeBuildArtifacts,
      extraAllowed,
      extraDeny,
      inheritBase,
      existingIds,
    });

    const errs = validateManifest(manifest, taskId);
    if (errs.length) {
      console.error('Generated manifest failed validation:');
      for (const e of errs) console.error(`  - ${e}`);
      bail('could not build a valid manifest from your inputs — aborting without saving');
    }

    if (!manifest.allowed && !manifest.inherits) {
      console.log('Heads up: no allowed globs and no inherits — agent will have nothing it can write.');
      const proceed = await prompter.askYesNo('Continue anyway?', { default: false });
      if (!proceed) { console.log('Aborted. Nothing was saved.'); return; }
    }

    console.log('Proposed manifest:');
    console.log(`  ${manifestPath}`);
    console.log('');
    for (const line of JSON.stringify(manifest, null, 2).split('\n')) {
      console.log(`  ${line}`);
    }
    console.log('');

    // 7) Save / edit / cancel -----------------------------------------------
    const decision = await prompter.askChoice('What next?', [
      { key: 's', label: 'save and activate (recommended)' },
      { key: 'e', label: 'edit manually (opens $EDITOR; saved & activated on close)' },
      { key: 'c', label: 'cancel — nothing will be written' },
    ], { default: 's' });

    if (decision === 'c') { console.log('Aborted. Nothing was saved.'); return; }

    if (existsSync(manifestPath)) {
      const overwrite = await prompter.askYesNo(
        `Manifest already exists at ${manifestPath}. Overwrite?`,
        { default: false },
      );
      if (!overwrite) { console.log('Aborted. Existing manifest untouched.'); return; }
    }

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`Created ${manifestPath}`);

    if (decision === 'e') {
      const opened = openInEditor(manifestPath);
      if (!opened.ok) {
        console.log(`(editor launch failed: ${opened.reason} — manifest is saved as-is, edit it later with your editor of choice)`);
      } else {
        // Re-validate after editing; if invalid, leave it there and warn.
        let edited;
        try { edited = JSON.parse(readFileSync(manifestPath, 'utf8')); }
        catch (e) {
          console.error(`Saved file is no longer valid JSON: ${e.message}`);
          console.error('Leaving it in place. Fix it by hand and run `pnpm task validate ' + taskId + '`.');
          return;
        }
        const editErrs = validateManifest(edited, taskId);
        if (editErrs.length) {
          console.error('Edited manifest has validation errors:');
          for (const e of editErrs) console.error(`  - ${e}`);
          console.error('Leaving it in place. Fix it and run `pnpm task validate ' + taskId + '`.');
          return;
        }
      }
    }

    writeFileSync(activeFile, `${taskId}\n`, 'utf8');
    console.log(`Activated: ${taskId}`);
    console.log('');
    console.log('The agent can now only write files matching the allowed globs.');
    console.log('Useful next commands:');
    console.log('  pnpm task show            — see current scope');
    console.log('  pnpm task check <path>    — test a single path');
    console.log('  pnpm task clear           — exit task mode');
    bootstrapWarning();
  } finally {
    prompter.close();
  }
}

async function askNonEmpty(prompter, prompt, explain) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const v = await prompter.ask(prompt);
    if (v && v.trim().length >= 3) return v.trim();
    console.log(`  ${explain}`);
  }
  bail('no description provided after 3 tries — aborting');
}

function printPackageList(packages, suggestedSet) {
  console.log('Workspace packages:');
  const width = Math.max(...packages.map(p => p.name.length), 4);
  const cols = 2;
  const rows = Math.ceil(packages.length / cols);
  for (let r = 0; r < rows; r++) {
    const line = [];
    for (let c = 0; c < cols; c++) {
      const i = c * rows + r;
      if (i >= packages.length) continue;
      const p = packages[i];
      const n = (i + 1).toString().padStart(2, ' ');
      const marker = suggestedSet && suggestedSet.has(p.path) ? '*' : ' ';
      line.push(`  ${marker}${n}. ${p.name.padEnd(width, ' ')}`);
    }
    console.log(line.join('  '));
  }
  if (suggestedSet && suggestedSet.size) console.log('  (* = suggested from your description)');
}

function openInEditor(filePath) {
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  try {
    const parts = editor.split(/\s+/).filter(Boolean);
    const cmd = parts[0];
    const args = parts.slice(1).concat(filePath);
    const r = spawnSync(cmd, args, { stdio: 'inherit' });
    if (r.error) return { ok: false, reason: r.error.message };
    if (typeof r.status === 'number' && r.status !== 0) {
      return { ok: false, reason: `editor exited with status ${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function parseCreateArgs(argv) {
  const out = {
    id: null,
    description: null,
    owner: null,
    notes: null,
    inherits: null,
    allowed: [],
    exemptions: [],
    activate: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) bail(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--description': case '-d': out.description = next(); break;
      case '--owner':                  out.owner       = next(); break;
      case '--notes':                  out.notes       = next(); break;
      case '--inherits':               out.inherits    = next().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--allowed':   case '-a':   out.allowed.push(next()); break;
      case '--exemption': case '-e':   out.exemptions.push(next()); break;
      case '--activate':               out.activate = true; break;
      case '--force':                  out.force    = true; break;
      case '-h': case '--help':
        console.log([
          'usage: task create <id> [flags]',
          '',
          '  --description, -d <text>   short description',
          '  --owner <name>             free-form owner tag',
          '  --notes <text>             multi-line notes (use \\n)',
          '  --inherits <ids>           comma-separated parent task ids',
          '  --allowed, -a <glob>       add an allowed pattern (repeatable)',
          '  --exemption, -e <glob>     add an exemption pattern (repeatable)',
          '  --activate                 set as active task after creation',
          '  --force                    overwrite an existing manifest',
        ].join('\n'));
        process.exit(0);
      default:
        if (a.startsWith('-')) bail(`unknown flag: ${a}`);
        if (!out.id) { out.id = a; break; }
        bail(`unexpected positional arg: ${a}`);
    }
  }
  return out;
}

function create(argv) {
  const opts = parseCreateArgs(argv);
  if (!opts.id) bail('usage: task create <id> --description "..." --allowed "<glob>" [...]');
  if (!/^[a-z0-9][a-z0-9-_.]{0,63}$/.test(opts.id)) {
    bail(`invalid id: ${opts.id} (must match /^[a-z0-9][a-z0-9-_.]{0,63}$/)`);
  }
  const manifestPath = resolve(tasksDir, `${opts.id}.json`);
  if (existsSync(manifestPath) && !opts.force) {
    bail(`manifest already exists: ${manifestPath}\n  (pass --force to overwrite)`);
  }
  const inherits = opts.inherits !== null
    ? opts.inherits
    : (listTasks(root).includes('base') && opts.id !== 'base' ? ['base'] : []);

  if (opts.allowed.length === 0 && inherits.length === 0) {
    bail('at least one --allowed pattern is required (unless --inherits)');
  }

  const manifest = {
    id: opts.id,
    description: opts.description || undefined,
    owner: opts.owner || undefined,
    created: new Date().toISOString(),
    inherits: inherits.length ? inherits : undefined,
    allowed: opts.allowed.length ? opts.allowed : undefined,
    exemptions: opts.exemptions.length ? opts.exemptions : undefined,
    notes: opts.notes || undefined,
  };
  const cleaned = Object.fromEntries(Object.entries(manifest).filter(([,v]) => v !== undefined));
  const errs = validateManifest(cleaned, opts.id);
  if (errs.length) bail(`invalid manifest:\n  - ${errs.join('\n  - ')}`);

  writeFileSync(manifestPath, JSON.stringify(cleaned, null, 2) + '\n', 'utf8');
  console.log(`Created ${manifestPath}`);

  if (opts.activate) {
    loadTask(root, opts.id);
    writeFileSync(activeFile, `${opts.id}\n`, 'utf8');
    console.log(`Active task set: ${opts.id}`);
  } else {
    console.log(`Activate with:  pnpm task set ${opts.id}`);
  }
  bootstrapWarning();
}

function validate(one) {
  const ids = one ? [one] : listTasks(root);
  if (!ids.length) { console.log('(no manifests found)'); return; }
  let failed = 0;
  for (const id of ids) {
    const file = resolve(tasksDir, `${id}.json`);
    if (!existsSync(file)) { console.error(`missing: ${file}`); failed++; continue; }
    let raw, parsed;
    try { raw = readFileSync(file, 'utf8'); } catch (e) { console.error(`${id}: cannot read (${e.message})`); failed++; continue; }
    try { parsed = JSON.parse(raw); } catch (e) { console.error(`${id}: invalid JSON (${e.message})`); failed++; continue; }
    const errs = validateManifest(parsed, id);
    if (errs.length) {
      failed++;
      console.error(`${id}: INVALID`);
      for (const err of errs) console.error(`  - ${err}`);
      continue;
    }
    try {
      loadTask(root, id);
      console.log(`${id}: ok`);
    } catch (e) {
      failed++;
      console.error(`${id}: INVALID (inheritance)`);
      console.error(`  - ${e.message}`);
    }
  }
  if (failed) process.exit(1);
}

function audit(args) {
  let limit = 50;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--since' || a === '-n') { limit = parseInt(args[++i], 10) || 50; }
    else if (a === '-h' || a === '--help') { console.log('usage: task audit [--since N]'); return; }
  }
  if (!existsSync(logsFile)) { console.log('(no denials logged)'); return; }
  const lines = readFileSync(logsFile, 'utf8').split('\n').filter(Boolean);
  const tail = lines.slice(-limit);
  for (const line of tail) {
    try {
      const r = JSON.parse(line);
      console.log(`${r.ts}  ${(r.event || '-').padEnd(26)}  ${(r.task || '-').padEnd(20)}  ${r.path || r.command || ''}`);
    } catch {
      console.log(line);
    }
  }
  console.log(`\n(${tail.length} of ${lines.length} entries)`);
}

function checkAgent() {
  console.log('agent-scope: checking per-agent setup');
  console.log('');
  const results = detectAgents(root);
  for (const r of results) {
    console.log(`${r.name}  ${statusGlyph(r.status)}`);
    console.log(`  enforcement: ${r.enforcement}`);
    for (const d of r.details) console.log(d);
    if (r.setup.length) {
      console.log('  setup:');
      for (const s of r.setup) console.log(s);
    }
    console.log('');
  }
  const c = summary(results);
  console.log(
    `Summary: ${c.ok} hard-enforced, ${c.partial} soft-rule only, ` +
    `${c.warn} need attention, ${c.missing} not configured.`
  );
  if (c.warn > 0) {
    console.log('');
    console.log('Action: at least one agent has issues — see [! check] entries above.');
    process.exit(1);
  }
  console.log('');
  console.log('Tip: run `pnpm task show` to see the active task scope (if any).');
}

function resolveDebug() {
  console.log(`repo root:   ${root}`);
  console.log(`env:         AGENT_SCOPE_TASK=${process.env.AGENT_SCOPE_TASK || '(unset)'}`);
  console.log(`             AGENT_SCOPE_BOOTSTRAP=${process.env.AGENT_SCOPE_BOOTSTRAP || '(unset)'}`);
  console.log(`bootstrap:   ${isBootstrapActive(root) ? 'ACTIVE' : 'inactive'} (token: ${existsSync(bootstrapToken) ? 'present' : 'absent'})`);
  const activeStr = existsSync(activeFile) ? readFileSync(activeFile, 'utf8').trim() : '(none)';
  console.log(`file:        ${activeFile} → ${activeStr}`);
  const { id, source } = resolveActiveTaskId(root);
  console.log(`resolved:    ${id || '(none)'}  (source: ${source})`);
}

// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'list':     list(); break;
    case 'show':
    case undefined:
    case null:
    case '':         show(); break;
    case 'set':      set(rest[0]); break;
    case 'clear':    clear(); break;
    case 'check':    check(rest[0]); break;
    case 'init':     await init(rest[0]); break;
    case 'start':    await start(rest); break;
    case 'create':   create(rest); break;
    case 'validate': validate(rest[0]); break;
    case 'audit':    audit(rest); break;
    case 'resolve':  resolveDebug(); break;
    case 'check-agent':
    case 'check-agents': checkAgent(); break;
    case '-h': case '--help': case 'help':
      console.log([
        'usage: task <command> [args]',
        '',
        '  start              interactive wizard: draft a manifest + activate',
        '  start --smart      paste a description, agent proposes scope in chat',
        '  list               list available task manifests',
        '  show               show the active task and its scope',
        '  set <id>           set the active task',
        '  clear              clear the active task',
        '  check <path>       check a path against the active task',
        '  init <id>          create a new task manifest interactively',
        '  create <id> [...]  create a manifest non-interactively (flags)',
        '  validate [<id>]    validate one or all manifests',
        '  audit [--since N]  show recent denials from the audit log',
        '  resolve            debug: show how the active task is resolved',
        '  check-agent        verify per-agent setup (Cursor/Claude Code/Codex/...)',
      ].join('\n'));
      break;
    default:
      bail(`unknown command: ${cmd}\nrun: task --help`, 2);
  }
} catch (e) {
  bail(e.message);
}
