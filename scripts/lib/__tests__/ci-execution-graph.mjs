// The CI execution graph behind the routing tests: what each job of a
// workflow runs, from one reading of its commands. A job's steps run
// commands, and so do the local composite actions and reusable workflows it
// uses. Each command is read by one interpreter into typed edges:
// - `script`: a package.json script it runs - a root script named by pnpm,
//   npm or yarn; a workspace's script (pnpm --filter, -r or --dir, turbo, or
//   pnpm/npm run in that workspace's directory); the install lifecycle hooks
//   an install runs; the pack lifecycle a pack runs; and what a repository
//   program runs as child processes, which the program declares
//   (PROGRAM_CHILD_COMMANDS). A script's pre and post hooks run with it.
// - `file`: a repository file it runs or names, from its working directory.
// The interpreter reads each script and shell script it reaches the same
// way. An edge records the chain of package scripts that led to it and its
// provenance; the routing policy (lane-entrypoints.mjs) maps each edge to what
// a change to its file must select.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
// The one routing-layer definition the graph reads: which package scripts an
// install runs. The planner owns it (it routes install-hook changes to full
// CI), and the trusted controller cannot import anything outside its own
// files, so this is the only place the two can share it.
import { isInstallLifecycleScript } from '../ci-delta.mjs';
import { SUBCOMMAND_CHILD_COMMANDS as RELEASE_CHILD_COMMANDS } from '../../release-packages.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function readRepoText(file) {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  } catch {
    return undefined;
  }
}

const listRepoDirectories = (directory) => {
  try {
    return fs.readdirSync(path.join(REPO_ROOT, directory), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

// Every workspace pnpm installs, from pnpm-workspace.yaml's `packages`
// (exact directories, and `<dir>/*` for each directory below one; any other
// pattern throws): each one's manifest by directory, and directories by
// package name. The graph reads what pnpm installs and runs from this; which
// workspaces a routing rule covers is the policy's (lane-entrypoints.mjs).
// `listDirectories(dir)` names a repository directory's subdirectories.
export function workspaceCatalog({ readRepoFile = readRepoText, listDirectories = listRepoDirectories } = {}) {
  const { packages: patterns = [] } = parse(readRepoFile('pnpm-workspace.yaml') ?? '{}') ?? {};
  const directories = patterns.flatMap((pattern) => {
    if (/^[\w@.-]+(?:\/[\w@.-]+)*$/.test(pattern)) return [path.posix.normalize(pattern)];
    const parent = pattern.match(/^([\w@.-]+(?:\/[\w@.-]+)*)\/\*$/)?.[1];
    if (parent) return listDirectories(parent).map((name) => `${parent}/${name}`);
    throw new Error(`unsupported pnpm-workspace.yaml pattern: ${pattern}`);
  });
  const manifests = new Map();
  for (const directory of directories) {
    const source = readRepoFile(`${directory}/package.json`);
    if (source !== undefined) manifests.set(directory, JSON.parse(source));
  }
  return { manifests, workspaceByName: new Map([...manifests].map(([workspace, { name }]) => [name, workspace])) };
}

// `roots` plus every workspace they depend on (dependencies and
// devDependencies), in `workspaces` ({ manifests, workspaceByName }, by
// default the repository's). Roots that are not workspaces are ignored.
export function workspaceClosure(roots, { manifests, workspaceByName } = workspaceCatalog()) {
  const queue = [...roots];
  const closure = new Set();
  while (queue.length) {
    const workspace = queue.shift();
    if (closure.has(workspace) || !manifests.has(workspace)) continue;
    closure.add(workspace);
    const { dependencies = {}, devDependencies = {} } = manifests.get(workspace);
    for (const name of Object.keys({ ...dependencies, ...devDependencies })) {
      if (workspaceByName.has(name)) queue.push(workspaceByName.get(name));
    }
  }
  return closure;
}

// Repository programs that run commands as child processes, by subcommand,
// as each program declares and runs them: `node scripts/release-packages.mjs
// verify-pack` packs the CLI with npm (release-packages.test.mjs checks the
// subcommand runs exactly what it declares). The interpreter reads each
// declared command like any other, in its declared directory.
export const PROGRAM_CHILD_COMMANDS = Object.freeze(new Map([
  ['scripts/release-packages.mjs', RELEASE_CHILD_COMMANDS],
]));

const PROGRAMS = new Set(['pnpm', 'npm', 'yarn', 'turbo', 'npx', 'pnpx']);
// pnpm's own commands, which never name a package script.
const PNPM_COMMANDS = new Set([
  'add', 'audit', 'bin', 'config', 'create', 'deploy', 'doctor', 'env', 'fetch', 'import', 'init', 'licenses',
  'link', 'list', 'ln', 'ls', 'outdated', 'patch', 'patch-commit', 'prune', 'publish', 'rebuild', 'remove', 'rm',
  'root', 'server', 'setup', 'store', 'un', 'uninstall', 'unlink', 'up', 'update', 'why',
]);
const INSTALL_VERBS = new Set(['install', 'i', 'ci', 'install-test', 'it']);
const SCRIPT_ALIASES = new Map([['t', 'test'], ['tst', 'test'], ['test', 'test'], ['start', 'start'], ['stop', 'stop'], ['restart', 'restart']]);
const PNPM_VALUE_FLAGS = new Set(['--filter', '-F', '--dir', '-C', '--prefix', '--reporter', '--loglevel', '--workspace-concurrency']);
// What `pack` runs: npm and pnpm run these around creating the tarball.
const PACK_LIFECYCLE = ['prepack', 'prepare', 'postpack'];

// A shell script's own directory, however the script spells it: "$(dirname
// "$0")", "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" or
// "${BASH_SOURCE%/*}". The tokenizer reads each as $SCRIPT_DIR.
const SOURCE = String.raw`"?\$(?:0|BASH_SOURCE|\{BASH_SOURCE(?:\[0\])?\})"?`;
const DIRNAME = String.raw`\$\(\s*dirname\s+(?:--\s+)?${SOURCE}\s*\)`;
const SCRIPT_DIRECTORY = new RegExp(String.raw`\$\(\s*cd\s+(?:--\s+)?"?${DIRNAME}"?\s*(?:>\s*\/dev\/null\s*)?(?:2>&1\s*)?&&\s*pwd(?:\s+-P)?\s*\)|${DIRNAME}|\$\{(?:BASH_SOURCE(?:\[0\])?|0)%\/\*\}`, 'g');

// The simple commands of shell `text` - split at newlines, ;, &&, || and |,
// line continuations joined, a script's own directory read as $SCRIPT_DIR,
// command substitutions, subshells and redirections opened up, a GitHub
// expression read as a variable - as words without their quotes, each with
// the directory it runs in (a `cd` to a literal directory moves the commands
// after it, any other `cd` returns to the repository root) and the variable
// assignments it starts with.
export function simpleCommands(text, cwd = '.') {
  const commands = [];
  let directory = cwd;
  const shell = text.replace(/\\\n/g, ' ')
    .replace(/\$\{\{[^}]*\}\}/g, '$GITHUB_EXPRESSION')
    .replace(SCRIPT_DIRECTORY, '$SCRIPT_DIR')
    .replace(/\$\(|[()`<>]/g, ' ');
  for (const part of shell.split(/\n|;|&&|\|\|?/)) {
    const words = part.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/^['"]+|['"]+$/g, ''));
    const assignments = [];
    while (/^[A-Za-z_]\w*=/.test(words[0] ?? '')) assignments.push(words.shift());
    if (words[0] === 'cd') {
      directory = words[1] && !/[$~`]|^-$/.test(words[1]) ? path.posix.normalize(path.posix.join(directory, words[1])) : '.';
    } else if (words.length || assignments.length) {
      commands.push({ words, assignments, cwd: directory });
    }
  }
  return commands;
}

// The package workspaces a pnpm filter selector names: a package name (or a
// `*` pattern), `<name>...` with its dependencies, `...<name>` with its
// dependents, `./<dir>` or `{<dir>}`. Any other selector throws, so a new
// form fails the routing tests instead of hiding what a job runs.
function selectWorkspaces(selector, cwd, workspaces) {
  const { manifests, workspaceByName } = workspaces;
  const withDependencies = selector.endsWith('...');
  const withDependents = selector.startsWith('...');
  const core = selector.replace(/^\.\.\./, '').replace(/\.\.\.$/, '');
  let named;
  if (/^\{.+\}$|^\.\.?\//.test(core)) {
    named = [path.posix.normalize(path.posix.join(cwd, core.replace(/^\{|\}$/g, '')))].filter((workspace) => manifests.has(workspace));
  } else if (/^[@\w][\w@/.*-]*$/.test(core)) {
    const pattern = new RegExp(`^${core.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    named = [...workspaceByName].filter(([name]) => pattern.test(name)).map(([, workspace]) => workspace);
  } else {
    throw new Error(`unsupported pnpm filter selector: ${selector}`);
  }
  if (withDependencies) return [...workspaceClosure(named, workspaces)];
  if (withDependents) {
    return [...manifests.keys()].filter((workspace) => named.some((target) => workspaceClosure([workspace], workspaces).has(target)));
  }
  return named;
}

// What one simple command runs through a package manager or task runner:
// `scripts`, as [workspace, script] pairs ('.' is the root manifest), and
// `nested`, commands it runs in other directories (pnpm exec, npx). Its file
// words resolve from `directories`.
function packageManagerCalls({ words, cwd }, context) {
  const { manifests, rootManifest } = context;
  const scriptsOf = (workspace) => (workspace === '.' ? rootManifest.scripts : manifests.get(workspace)?.scripts) ?? {};
  const withScript = (targets, script) => targets.filter((workspace) => Object.hasOwn(scriptsOf(workspace), script)).map((workspace) => [workspace, script]);
  const everyWorkspace = [...manifests.keys()];
  const installHooks = () => [['.', rootManifest], ...manifests].flatMap(([workspace, { scripts = {} }]) => Object.keys(scripts)
    .filter(isInstallLifecycleScript)
    .map((script) => [workspace, script]));
  const none = { scripts: [], nested: [], directories: [cwd] };
  const at = words.findIndex((word) => PROGRAMS.has(word));
  if (at < 0) return none;
  const [program, ...rest] = words.slice(at);

  if (program === 'turbo' || (['npx', 'pnpx'].includes(program) && rest[0] === 'turbo')) {
    const tasks = (program === 'turbo' ? rest : rest.slice(1)).filter((word) => !word.startsWith('-'));
    return { ...none, scripts: (tasks[0] === 'run' ? tasks.slice(1) : tasks).flatMap((task) => withScript(everyWorkspace, task)) };
  }
  if (program === 'npx' || program === 'pnpx') return none;

  // pnpm, npm and yarn: options, then a verb.
  const included = [];
  const excluded = [];
  let directory;
  let recursive = false;
  let index = 0;
  for (; index < rest.length && rest[index].startsWith('-'); index += 1) {
    const [flag, inline] = rest[index].split(/=(.*)/s);
    const value = inline ?? (PNPM_VALUE_FLAGS.has(flag) ? rest[++index] : undefined);
    if (program === 'pnpm' && (flag === '--filter' || flag === '-F')) {
      (value.startsWith('!') ? excluded : included).push(...selectWorkspaces(value.replace(/^!/, ''), cwd, context));
    } else if (flag === '--dir' || flag === '-C' || flag === '--prefix') {
      directory = path.posix.normalize(path.posix.join(cwd, value));
    } else if (flag === '-r' || flag === '--recursive') {
      recursive = true;
    } else if (flag === '-w' || flag === '--workspace-root') {
      directory = '.';
    }
  }
  const targets = (directory ? [directory] : included.length ? included : recursive || excluded.length ? everyWorkspace : [cwd])
    .filter((workspace) => !excluded.includes(workspace))
    .filter((workspace) => workspace === '.' || manifests.has(workspace));
  const verb = rest[index] ?? (program === 'yarn' ? 'install' : undefined);
  const after = rest.slice(index + 1);
  if (INSTALL_VERBS.has(verb)) return { ...none, scripts: installHooks() };
  if (verb === 'pack') return { ...none, scripts: targets.flatMap((workspace) => PACK_LIFECYCLE.flatMap((script) => withScript([workspace], script))) };
  if (verb === 'exec' || verb === 'dlx') {
    const runIn = verb === 'exec' && targets.length ? targets : [cwd];
    return { scripts: [], nested: runIn.map((target) => ({ words: after, cwd: target })), directories: [] };
  }
  const script = verb === 'run' || verb === 'run-script'
    ? after.find((word) => !word.startsWith('-'))
    : PNPM_COMMANDS.has(verb) ? undefined : SCRIPT_ALIASES.get(verb) ?? verb;
  return { ...none, scripts: script ? withScript(targets, script) : [] };
}

// The repository files a command word names: each part of it (split at =,
// commas, quotes, braces and brackets, so a --flag=value, a list or a JSON
// value is read too; a trailing . or : ends a sentence, not a path) that is a
// path from the command's directory, or from the repository root behind a
// leading $VARIABLE/ or ${VARIABLE}/ ("$GITHUB_WORKSPACE/scripts/x.sh"). In
// a shell script, `scriptDirectory` is its own directory: a path behind a
// variable, or one starting ./ or ../, may be relative to it too
// ("$SCRIPT_DIR/lib.sh"). A path that names no file that way but runs
// through a scripts/ directory - under another checkout (candidate/), a
// relative climb, a template's value or an absolute root - names that
// repository script. A part with another expansion or a glob names no single
// file; neither does an option. `exists` decides what is a file.
function namedFiles(word, cwd, exists, scriptDirectory) {
  return word.replace(/\$\{(\w+)\}/g, '$$$1').split(/[=,"'{}[\]]+/).filter(Boolean).flatMap((part) => {
    let candidate = part.replace(/(?<=\w)[.:]+$/, '');
    const rooted = candidate.match(/^\$\w+\/(.+)$/);
    if (rooted) [, candidate] = rooted;
    if (!/\/|\.\w+$/.test(candidate) || /[$*?`()<>|]|^-/.test(candidate) || [...candidate].some((character) => character < ' ')) return [];
    const bases = candidate.startsWith('/') ? [] : rooted ? ['.', scriptDirectory] : [cwd, /^\.\.?\//.test(candidate) ? scriptDirectory : undefined];
    const files = [...new Set(bases.filter((base) => base !== undefined).map((base) => path.posix.normalize(path.posix.join(base, candidate))))]
      .filter((file) => file !== '.' && !file.startsWith('../') && exists(file));
    if (files.length) return files;
    const script = candidate.match(/(?:^|\/)(scripts\/[^/].*)$/)?.[1];
    return script && exists(path.posix.normalize(script)) ? [path.posix.normalize(script)] : [];
  });
}

// The repository files command or shell `text` names (namedFiles, for each
// word of each simple command), for commands run in `cwd`; `scriptDirectory`
// is the directory of the shell script the text is, if any.
export function commandFiles(text, { cwd = '.', scriptDirectory, exists }) {
  return [...new Set(simpleCommands(text, cwd).flatMap(({ words, assignments, cwd: directory }) => [...assignments, ...words]
    .flatMap((word) => namedFiles(word, directory, exists, scriptDirectory))))];
}

// A shell script: a .sh or .bash file, or an extensionless one whose shebang
// runs a shell.
export function isShellScript(file, source) {
  return /\.(?:sh|bash)$/.test(file)
    || (!path.posix.basename(file).includes('.') && /^#!\s*\/\S*\/(?:env\s+)?(?:ba|da|z)?sh\b/.test(source));
}

// Shell text without its `#` comments: a # at a line's start or after
// whitespace (${#var} and a#b are not comments).
const withoutComments = (text) => text.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '$1')).join('\n');

// A word that builds a script path from a value: an expansion inside a
// scripts/ path, or in a script's file name ("$SCRIPT_DIR/${helper}.sh").
const assemblesScriptPath = (word) => word.includes('$')
  && (/(?:^|\/)scripts\/[^$]*\$/.test(word) || /(?:^|\/)[^/]*\$[^/]*\.(?:sh|bash|py|[cm]?[jt]s)$/.test(word));

// Keywords that open a compound command, and wrappers that run the command
// after them: what a simple command's program follows.
const COMMAND_PREFIXES = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time', 'exec', 'nohup', 'command']);
// Programs that run the file their first operand names, each with the
// options after which no file runs (the code is an argument, a module or
// stdin) and the options that take the next word as their value.
const SHELL_RUNNER = { inline: ['-c', '-s'], valued: (option) => /^[-+][A-Za-z]*[oO]$/.test(option) };
const NODE_RUNNER = {
  inline: ['-e', '--eval', '-p', '--print'],
  valued: (option) => ['--import', '--require', '-r', '--loader', '--experimental-loader', '--env-file', '--conditions', '-C', '--input-type', '--tsconfig'].includes(option),
};
const SCRIPT_RUNNERS = new Map([
  ...['bash', 'sh', 'zsh', 'dash'].map((program) => [program, SHELL_RUNNER]),
  ...['source', '.'].map((program) => [program, { inline: [], valued: () => false }]),
  ...['node', 'tsx'].map((program) => [program, NODE_RUNNER]),
  ...['python', 'python3'].map((program) => [program, { inline: ['-c', '-m'], valued: (option) => ['-W', '-X'].includes(option) }]),
]);

// The word naming the file a simple command runs, if it runs one: past the
// keywords and wrappers it follows (env with its assignments, timeout with
// its duration, npx with its options), the operand of a script runner (bash,
// source, node, python), or the program itself when that is a path. A
// program word that is a URL, an assignment or a glob (a `case` pattern)
// names no file, and neither does npx -c, which runs a command string.
function executedWord(words) {
  const rest = words.map((word) => word.replace(/["']/g, '')).filter(Boolean);
  let at = 0;
  for (;;) {
    if (COMMAND_PREFIXES.has(rest[at]) || /^[A-Za-z_]\w*=/.test(rest[at] ?? '')) {
      at += 1;
    } else if (rest[at] === 'env') {
      for (at += 1; /^-|^[A-Za-z_]\w*=/.test(rest[at] ?? ''); at += 1);
    } else if (rest[at] === 'timeout') {
      for (at += 1; (rest[at] ?? '').startsWith('-'); at += /^-[sk]$/.test(rest[at]) ? 2 : 1);
      at += 1;
    } else if (rest[at] === 'npx' || rest[at] === 'pnpx') {
      for (at += 1; (rest[at] ?? '').startsWith('-'); at += /^(?:-p|--package)$/.test(rest[at]) ? 2 : 1) {
        if (/^(?:-c|--call)$/.test(rest[at])) return undefined;
      }
    } else {
      break;
    }
  }
  const program = rest[at];
  const runner = SCRIPT_RUNNERS.get(program);
  if (!runner) return program?.includes('/') && !/[=*?[]|^\/\/|:\/\//.test(program) ? program : undefined;
  for (at += 1; at < rest.length; at += 1) {
    if (rest[at] === '-' || runner.inline.includes(rest[at])) return undefined;
    if (runner.valued(rest[at])) at += 1;
    else if (!/^[-+]/.test(rest[at])) return rest[at];
  }
  return undefined;
}

// A path whose file is picked at run time: past a leading $VARIABLE/ root (a
// repository or script directory, which namedFiles resolves), it still
// expands a value ($helper, ${name}, $1), which no reading can resolve.
const picksFileAtRunTime = (word) => /(?<!\\)\$[\w{@*#?!$]/.test(word.replace(/^\$\{?\w+\}?\//, ''));

// The one reading of a piece of shell text - a workflow step, a package
// script, a shell script - with its `#` comments dropped, as typed edges:
// - calls: the package scripts it runs, as [workspace, script] ('.' is the
//   root manifest): named by a package manager, turbo, install or pack;
// - files: the repository files it runs or names (namedFiles), each with
//   the directory it was named from, the child commands a declared program
//   runs (PROGRAM_CHILD_COMMANDS) included;
// - runs: of those, the files a command runs (a script runner's operand or a
//   program path: executedWord), whose own imports run too;
// - assembled: the script paths it builds from a value, which no reading can
//   resolve ("$SCRIPT_DIR/${helper}.sh", scripts/$name), and each file a
//   command runs that is picked at run time: a script runner's operand or a
//   program path that expands a value past its directory
//   (bash "$SCRIPT_DIR/$helper", node "$entry", "$SCRIPT_DIR/$step").
// `cwd` is where it runs, `scriptDirectory` the directory of the shell script
// it is (if any), `context` the manifests ({ manifests, workspaceByName,
// rootManifest }) and `exists` what is a file.
export function analyzeShell(text, { cwd = '.', scriptDirectory, exists, context }) {
  const calls = [];
  const files = [];
  const runs = new Set();
  const assembled = new Set();
  const queue = simpleCommands(withoutComments(text), cwd);
  while (queue.length) {
    const command = queue.shift();
    const { scripts, nested, directories } = packageManagerCalls(command, context);
    queue.push(...nested, ...childCommands(command, exists));
    calls.push(...scripts);
    const words = [...(command.assignments ?? []), ...command.words];
    for (const directory of directories) {
      for (const file of words.flatMap((word) => namedFiles(word, directory, exists, scriptDirectory))) files.push({ file, directory });
    }
    for (const word of words.map((candidate) => candidate.replace(/["']/g, ''))) if (assemblesScriptPath(word)) assembled.add(word);
    const executed = executedWord(command.words);
    if (executed !== undefined && picksFileAtRunTime(executed)) {
      assembled.add(executed);
    } else if (executed !== undefined) {
      for (const directory of directories) for (const file of namedFiles(executed, directory, exists, scriptDirectory)) runs.add(file);
    }
  }
  return { calls, files, runs: [...runs], assembled: [...assembled] };
}

// The child commands a declared program runs for the subcommand a command
// gives it (PROGRAM_CHILD_COMMANDS), as commands in their declared
// directories.
function childCommands({ words, cwd }, exists) {
  for (const [index, word] of words.entries()) {
    const program = namedFiles(word, cwd, exists).find((file) => PROGRAM_CHILD_COMMANDS.has(file));
    const children = program ? PROGRAM_CHILD_COMMANDS.get(program)[words[index + 1]] : undefined;
    if (children) return children.map(({ command, args, cwd: directory }) => ({ words: [command, ...args], assignments: [], cwd: directory }));
  }
  return [];
}


// Follows shell text through the package scripts and shell scripts it
// reaches, reading each with analyzeShell, and records the `commands` it
// reads (each once, in the order reached) and its `edges`: a `file` edge per
// repository file named (with the shell script directory it was named in,
// and `run` when a command runs it), a
// `script` edge per package script run and an `assembled` edge per script
// path built from a value, each with the chain of package scripts
// ({ workspace, script }) that led there and its provenance (`via`).
function executionReader({ readRepoFile, exists, context }) {
  const commands = [];
  const projected = new Set();
  const followed = new Set();
  const edges = [];
  const scriptText = (workspace, script) => (workspace === '.' ? context.rootManifest.scripts : context.manifests.get(workspace)?.scripts)?.[script];
  const chainKey = (chain) => chain.map((link) => `${link.workspace}:${link.script}`).join('>');
  const project = (key, text) => {
    if (!projected.has(key)) {
      projected.add(key);
      commands.push(text);
    }
  };
  // Read `text` as commands run in `cwd`, reached through `chain`; the text
  // of a shell script is read from `scriptDirectory`, its own directory.
  const readCommands = (text, cwd, chain, via, scriptDirectory) => {
    const { calls, files, runs, assembled } = analyzeShell(text, { cwd, scriptDirectory, exists, context });
    for (const { file } of files) edges.push({ kind: 'file', file, chain, via, scriptDirectory, run: runs.includes(file) });
    for (const word of assembled) edges.push({ kind: 'assembled', text: word, chain, via });
    for (const [workspace, script] of calls) {
      for (const name of [`pre${script}`, script, `post${script}`]) runScript(workspace, name, chain, via);
    }
    for (const { file, directory } of files) {
      const key = `${file}@${chainKey(chain)}`;
      const source = followed.has(key) ? undefined : readRepoFile(file);
      if (source === undefined || !isShellScript(file, source)) continue;
      followed.add(key);
      project(`shell ${file}`, source);
      readCommands(source, directory, chain, `${via} > ${file}`, path.posix.dirname(file));
    }
  };
  const runScript = (workspace, script, chain, via) => {
    const text = scriptText(workspace, script);
    if (text === undefined || chain.some((link) => link.workspace === workspace && link.script === script)) return;
    const next = [...chain, { workspace, script }];
    const key = chainKey(next);
    if (followed.has(key)) return;
    followed.add(key);
    const where = `${via} > ${workspace === '.' ? '' : `${workspace} `}${script}`;
    edges.push({ kind: 'script', workspace, script, chain: next, via: where });
    project(`script ${workspace} ${script}`, text);
    readCommands(text, workspace, next, where);
  };
  return { commands, edges, readCommands, runScript };
}

// The edges package scripts reach, followed as a job's commands are: each
// [workspace, script] call with its pre and post hooks. Options as for
// workflowExecution, plus `exists`.
export function packageScriptEdges(calls, {
  readRepoFile = readRepoText,
  exists = (file) => readRepoFile(file) !== undefined,
  workspaces = workspaceCatalog({ readRepoFile }),
  rootManifest = JSON.parse(readRepoFile('package.json') ?? '{}'),
} = {}) {
  const reader = executionReader({ readRepoFile, exists, context: { ...workspaces, rootManifest } });
  for (const [workspace, script] of calls) {
    for (const name of [`pre${script}`, script, `post${script}`]) reader.runScript(workspace, name, [], workspace === '.' ? script : `${workspace} ${script}`);
  }
  return reader.edges;
}

// Every job of a workflow as { job, condition, commands, edges }:
// - `commands`: the text of every command it runs (steps, and the package
//   scripts and shell scripts they reach), each once, in the order reached;
// - `edges`: { kind: 'script', workspace, script, chain, via } for each
//   package script run and { kind: 'file', file, chain, via } for each
//   repository file named, where `chain` lists the package scripts
//   ({ workspace, script }) that led there and `via` spells out the path.
// A local action or reusable workflow that cannot be read throws.
// `readRepoFile` reads a repository file (undefined when there is none);
// `workspaces` and `rootManifest` default to what it reads.
export function workflowExecution(workflowSource, {
  readRepoFile = readRepoText,
  workspaces = workspaceCatalog({ readRepoFile }),
  rootManifest = JSON.parse(readRepoFile('package.json') ?? '{}'),
} = {}) {
  const context = { ...workspaces, rootManifest };
  const exists = (file) => readRepoFile(file) !== undefined;
  const workflow = parse(workflowSource);
  return Object.entries(workflow.jobs ?? {}).map(([job, definition]) => {
    const reader = executionReader({ readRepoFile, exists, context });
    // The directory a step's `run` executes in, as GitHub picks it: the
    // step's working-directory, else its job's defaults.run, else its
    // workflow's, else the repository root. One the graph cannot resolve
    // statically (an expression, a path out of the repository) throws.
    const workingDirectory = (...settings) => {
      const setting = settings.find((value) => value !== undefined && value !== null);
      if (setting === undefined) return '.';
      const directory = path.posix.normalize(String(setting));
      if (/\$\{\{/.test(directory) || directory.startsWith('/') || directory === '..' || directory.startsWith('../')) {
        throw new Error(`${job} runs a step in a working directory the graph cannot resolve: ${setting}`);
      }
      return directory;
    };
    const followJob = ({ steps = [], uses, defaults } = {}, workflowDirectory) => {
      const jobDirectory = defaults?.run?.['working-directory'];
      for (const step of steps) {
        if (step.run !== undefined && step.run !== null) {
          const run = String(step.run);
          reader.commands.push(run);
          reader.readCommands(run, workingDirectory(step['working-directory'], jobDirectory, workflowDirectory), [], job);
        }
        followUses(step.uses);
      }
      followUses(uses);
    };
    const seenUses = new Set();
    const followUses = (uses) => {
      const target = uses?.match(/^\.\/(.+?)\/?$/)?.[1];
      if (!target || seenUses.has(target)) return;
      seenUses.add(target);
      const source = /\.ya?ml$/.test(target)
        ? readRepoFile(target)
        : ['action.yml', 'action.yaml'].map((name) => readRepoFile(`${target}/${name}`)).find((text) => text !== undefined);
      if (source === undefined) throw new Error(`${uses} names no local workflow or action`);
      const { jobs, runs, defaults } = parse(source);
      if (jobs) for (const nested of Object.values(jobs)) followJob(nested, defaults?.run?.['working-directory']);
      else followJob({ steps: runs?.steps });
    };
    followJob(definition, workflow.defaults?.run?.['working-directory']);
    return { job, condition: definition.if ?? '', commands: reader.commands, edges: reader.edges };
  });
}
