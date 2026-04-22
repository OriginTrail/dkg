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
  buildOnboardingTrigger,
  writeOnboardingMarker,
  copyToClipboard,
} from '../lib/onboarding.mjs';
import { detectAgents, statusGlyph, summary } from '../lib/check-agent.mjs';
import { createPrompter } from '../lib/prompter.mjs';

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
// Task onboarding — `pnpm task start`
// ---------------------------------------------------------------------------
//
// Single flow: the CLI asks "What are you working on?" (one short prompt,
// single Enter to submit, multi-line pastes captured in full), then drops
// a one-shot marker file at `agent-scope/.pending-onboarding` embedding
// the user's description plus the Task onboarding protocol. The next
// message the user sends in ANY chat (new or existing) makes the agent
// read the description, explore the repo, and propose a scope via a
// plan-mode AskQuestion. On approval the agent runs `pnpm task create`
// itself via the allowlist.
//
// Requires an interactive terminal. For non-interactive / CI use call
// `pnpm task create <id> --description ... --allowed ... --activate`
// directly — that path has always been scripted-friendly.
// ---------------------------------------------------------------------------

async function start() {
  const { id: activeId } = resolveActiveTaskId(root);
  if (activeId) {
    console.log(`You already have a task going: ${activeId}`);
    console.log(`Run \`pnpm task clear\` to drop it, or \`pnpm task show\` to see it.`);
    bootstrapWarning();
    return;
  }

  if (!process.stdin.isTTY) {
    console.error('Run `pnpm task start` in a real terminal — it asks you a question.');
    console.error('For CI or scripts, use `pnpm task create` directly.');
    process.exit(2);
  }

  const prompter = createPrompter();
  let description = '';
  try {
    console.log('What are you working on?');
    console.log('');
    description = await prompter.askPasteableDescription('> ');
  } finally {
    prompter.close();
  }

  const trimmed = description.trim();
  if (!trimmed || trimmed.length < 10) {
    bail('Give me at least a sentence so I know what you\'re doing.');
  }

  const trigger = buildOnboardingTrigger({ description: trimmed });
  writeOnboardingMarker(root, trigger);
  const clip = copyToClipboard(trigger);

  console.log('');
  console.log('Got it. Send any message in chat (e.g. `start working`).');
  console.log('I\'ll read what you wrote, look around the repo, and ask you');
  console.log('to accept a scope before I touch anything.');
  if (clip.ok) {
    console.log('');
    console.log('(Also copied to your clipboard, just in case.)');
  }
  bootstrapWarning();
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
    case 'start':    await start(); break;
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
        '  start              describe the task; the agent proposes a scope in chat',
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
