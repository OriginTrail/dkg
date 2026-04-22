// Pure shell-command parser used by the beforeShellExecution hook.
// Extracted for unit-testability. No IO, no dependencies on scope.mjs.

// Split on &&, ||, ;, | — treat each sub-command independently.
export function splitCommands(cmd) {
  const parts = [];
  let buf = '';
  let inSingle = false, inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) {
        parts.push(buf); buf = ''; i++; continue;
      }
      if (c === ';' || c === '|' || c === '\n') {
        parts.push(buf); buf = ''; continue;
      }
    }
    buf += c;
  }
  if (buf.trim()) parts.push(buf);
  return parts.map(s => s.trim()).filter(Boolean);
}

// Tokenize a single sub-command into argv, stripping quotes.
export function tokenize(cmd) {
  const out = [];
  let buf = '';
  let inSingle = false, inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\' && !inSingle) { buf += cmd[++i] || ''; continue; }
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && /\s/.test(c)) {
      if (buf) { out.push(buf); buf = ''; }
      continue;
    }
    buf += c;
  }
  if (buf) out.push(buf);
  return out;
}

export function extractRedirections(tokens) {
  const targets = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '>' || t === '>>' || t === '&>' || t === '>|') {
      if (tokens[i + 1]) targets.push(tokens[i + 1]);
    } else if (/^[0-9]*>>?$/.test(t)) {
      if (tokens[i + 1]) targets.push(tokens[i + 1]);
    } else if (/^([0-9]*>>?|&>)[^\s]+/.test(t)) {
      targets.push(t.replace(/^([0-9]*>>?|&>)/, ''));
    } else if (t === 'tee' || t === '/usr/bin/tee') {
      for (let j = i + 1; j < tokens.length; j++) {
        const a = tokens[j];
        if (a === '-a' || a === '--append' || a === '-i' || a === '--ignore-interrupts') continue;
        if (a.startsWith('-')) continue;
        targets.push(a);
        break;
      }
    }
  }
  return targets;
}

export function extractDestructiveTargets(tokens) {
  if (!tokens.length) return { cmd: null, targets: [] };
  const head = tokens[0].split('/').pop();
  const DESTRUCTIVE = new Set(['rm', 'mv', 'cp', 'chmod', 'chown', 'truncate', 'install', 'ln', 'sed', 'unlink', 'rmdir']);
  if (!DESTRUCTIVE.has(head)) return { cmd: null, targets: [] };

  const targets = [];
  const rest = tokens.slice(1);
  if (head === 'sed') {
    const inPlace = rest.some(t => t === '-i' || t.startsWith('-i') || t === '--in-place');
    if (!inPlace) return { cmd: head, targets: [] };
  }

  for (const t of rest) {
    if (t.startsWith('-')) continue;
    if (t.includes('=')) continue;
    if (/^[0-9]+$/.test(t)) continue;
    if (head === 'chmod' && /^[0-7]{3,4}$/.test(t)) continue;
    if (head === 'chown' && !t.includes('/') && !t.startsWith('.')) {
      if (targets.length === 0) continue;
    }
    targets.push(t);
  }
  return { cmd: head, targets };
}

export function extractFindTargets(tokens) {
  if (!tokens.length || tokens[0].split('/').pop() !== 'find') return null;
  const isDestructive = tokens.some((t, i) =>
    t === '-delete' ||
    (t === '-exec' && /^(rm|unlink|truncate|mv|sed|chmod|chown)$/.test((tokens[i + 1] || '').split('/').pop()))
  );
  if (!isDestructive) return null;
  const paths = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) break;
    paths.push(t);
  }
  return { cmd: 'find', targets: paths.length ? paths : ['.'] };
}

export function extractXargsTarget(tokens) {
  if (!tokens.length || tokens[0].split('/').pop() !== 'xargs') return null;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) continue;
    const head = t.split('/').pop();
    if (/^(rm|unlink|truncate|mv|sed|chmod|chown|cp|install|ln)$/.test(head)) {
      return { cmd: `xargs ${head}`, targets: [] };
    }
    return null;
  }
  return null;
}

const NESTED_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

const OPAQUE_EVALUATORS = {
  node: ['-e', '--eval', '-p', '--print'],
  deno: ['eval'],
  python: ['-c'],
  python2: ['-c'],
  python3: ['-c'],
  perl: ['-e', '-E'],
  ruby: ['-e'],
  php: ['-r'],
  lua: ['-e'],
};

export function extractNestedShellBody(tokens) {
  const head = tokens[0] && tokens[0].split('/').pop();
  if (!head || !NESTED_SHELLS.has(head)) return null;
  const dashC = tokens.indexOf('-c');
  if (dashC >= 1 && tokens[dashC + 1]) return { shell: head, body: tokens[dashC + 1] };
  return null;
}

export function extractOpaqueBody(tokens) {
  const head = tokens[0] && tokens[0].split('/').pop();
  if (!head) return null;
  const flags = OPAQUE_EVALUATORS[head];
  if (!flags) return null;
  for (let i = 1; i < tokens.length; i++) {
    if (flags.includes(tokens[i]) && tokens[i + 1] != null) {
      return { evaluator: head, flag: tokens[i], body: tokens[i + 1] };
    }
  }
  return null;
}

const WRITE_HINTS = [
  /\bwriteFileSync\b/, /\bappendFileSync\b/, /\bunlinkSync\b/, /\brmSync\b/,
  /\brmdirSync\b/, /\brenameSync\b/, /\bcpSync\b/, /\bcopyFileSync\b/,
  /\bchmodSync\b/, /\bchownSync\b/, /\bsymlinkSync\b/, /\btruncateSync\b/,
  /\bcreateWriteStream\b/, /\bmkdirSync\b/,
  /\bos\.remove\b/, /\bos\.unlink\b/, /\bos\.rename\b/, /\bshutil\.\w+/,
  /\bopen\s*\([^)]*,[^)]*['"](w|a|x)/,
  /\bunlink\b/, /\brename\b/, /\brmdir\b/,
  /\bFile::(open|write|unlink|rename)/,
  /\bFile\.write\b/, /\bFile\.delete\b/,
  />\s*[A-Za-z._/-]/,
];

export function bodyHasWriteIntent(body) {
  return WRITE_HINTS.some(re => re.test(body));
}

export function literalsFromProtected(patterns) {
  return patterns.map(p => p.replace(/\*\*?$/, '').replace(/\/\*\*$/, '/'));
}

export function bodyTouchesProtected(body, protectedPatterns) {
  const literals = literalsFromProtected(protectedPatterns);
  return literals.some(lit => lit && body.includes(lit));
}

// ---------------------------------------------------------------------------
// Approved-task-create detector
// ---------------------------------------------------------------------------
//
// The afterShell hook normally reverts / deletes any writes to protected
// paths (including `agent-scope/tasks/**`). That's the right default — we
// don't want the agent to silently mint itself a wider task scope.
//
// BUT: the smart-onboarding protocol ends with a plan-mode `AskQuestion`
// where the USER explicitly approves the proposed scope. Post-approval,
// the agent should be able to run `pnpm task create <id> ...` directly
// without bouncing the command back to the user to copy-paste.
//
// This function extracts the task id from the command IFF the command
// invokes the canonical task-create CLI. The hook uses that id to
// allowlist only two specific files:
//
//   - agent-scope/tasks/<id>.json   (the manifest the CLI just wrote)
//   - agent-scope/active            (set when --activate was passed)
//
// Everything else in `agent-scope/**` (hooks, library, bin, other tasks)
// stays hard-protected. Writes to ANY other path still get reverted.
//
// Supported invocations:
//   pnpm task create <id> [flags]
//   pnpm run task create <id> [flags]
//   node agent-scope/bin/task.mjs create <id> [flags]
//   node ./agent-scope/bin/task.mjs create <id> [flags]
//
// Returns: the task id string, or null if the command is not a valid
// task-create invocation. Task id validation matches the JSON schema
// (kebab-case, alphanumerics + hyphens/underscores, 1-64 chars).

const TASK_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function looksLikePnpm(t) {
  if (!t) return false;
  const tail = t.split('/').pop();
  return tail === 'pnpm';
}

function looksLikeNode(t) {
  if (!t) return false;
  const tail = t.split('/').pop();
  return tail === 'node' || tail === 'node.exe';
}

function looksLikeTaskJs(t) {
  if (!t) return false;
  const norm = t.replace(/^\.\//, '');
  return (
    norm === 'agent-scope/bin/task.mjs' ||
    norm.endsWith('/agent-scope/bin/task.mjs')
  );
}

// Extract the id from a single tokenized subcommand, or null.
function extractIdFromTokens(tokens) {
  if (!tokens?.length) return null;

  if (looksLikePnpm(tokens[0])) {
    let i = 1;
    if (tokens[i] === 'run') i++;
    if (tokens[i] !== 'task') return null;
    if (tokens[i + 1] !== 'create') return null;
    const id = tokens[i + 2];
    return id && TASK_ID_RE.test(id) ? id : null;
  }

  if (looksLikeNode(tokens[0])) {
    if (!looksLikeTaskJs(tokens[1])) return null;
    if (tokens[2] !== 'create') return null;
    const id = tokens[3];
    return id && TASK_ID_RE.test(id) ? id : null;
  }

  return null;
}

// Scan the full command (which may contain multiple sub-commands joined
// with `&&` / `||` / `;` / `|`) and return the FIRST approved task-create
// id we find, or null.
export function extractTaskCreateId(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  for (const sub of splitCommands(command)) {
    const tokens = tokenize(sub);
    const id = extractIdFromTokens(tokens);
    if (id) return id;
  }
  return null;
}

// Given a task id, return the POSIX relative paths the afterShell hook
// should allow past protection. Always includes the manifest and the
// `active` file. Stable sort / lowercase for comparison callers.
export function approvedTaskCreateWrites(id) {
  if (!id || !TASK_ID_RE.test(id)) return new Set();
  return new Set([
    `agent-scope/tasks/${id}.json`,
    'agent-scope/active',
  ]);
}
