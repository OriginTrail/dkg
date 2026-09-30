// The CI execution graph behind the routing tests: what each job of a
// workflow runs, from one reading of its commands. A job's steps run
// commands, and so do the local composite actions and reusable workflows it
// uses. Each command is read by one interpreter into typed edges:
// - `script`: a package.json script it runs - a root script named by pnpm,
//   npm or yarn; a workspace's script (pnpm --filter, -r or --dir, turbo, or
//   pnpm/npm run in that workspace's directory); the install lifecycle hooks
//   an install runs; the pack lifecycle a pack runs; and the scripts a
//   program runs itself, which COMMAND_EFFECTS declares. A script's pre and
//   post hooks run with it.
// - `file`: a repository file it runs or names, from its working directory.
// The interpreter reads each script and shell script it reaches the same
// way. An edge records the chain of package scripts that led to it and its
// provenance; the routing policy (lane-entrypoints.mjs) maps each edge to what
// a change to its file must select.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { WORKSPACE_RULES, isInstallLifecycleScript } from '../ci-delta.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function readRepoText(file) {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  } catch {
    return undefined;
  }
}

// Every package workspace's manifest by directory, and directories by package
// name. A workspace whose manifest `readRepoFile` cannot read is left out.
export function readWorkspaces({ readRepoFile = readRepoText } = {}) {
  const manifests = new Map();
  for (const workspace of Object.keys(WORKSPACE_RULES)) {
    const source = readRepoFile(`${workspace}/package.json`);
    if (source !== undefined) manifests.set(workspace, JSON.parse(source));
  }
  return { manifests, workspaceByName: new Map([...manifests].map(([workspace, { name }]) => [name, workspace])) };
}

// `roots` plus every workspace they depend on (dependencies and
// devDependencies), in `workspaces` ({ manifests, workspaceByName }, by
// default the repository's). Roots that are not workspaces are ignored.
export function workspaceClosure(roots, { manifests, workspaceByName } = readWorkspaces()) {
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

// Programs that run commands of their own, keyed by the command that starts
// one: `release-packages.mjs verify-pack` runs `npm pack --dry-run` in
// packages/cli, which runs the CLI's pack lifecycle. The interpreter reads
// `runs` like any other command; the routing test checks each program's
// source still contains `evidence`.
export const COMMAND_EFFECTS = Object.freeze([
  {
    command: /\bscripts\/release-packages\.mjs\s+verify-pack\b/,
    runs: { text: 'npm pack --dry-run --json', cwd: 'packages/cli' },
    evidence: { file: 'scripts/release-packages.mjs', text: "runner('npm', ['pack', '--dry-run', '--json']" },
  },
]);

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

// The simple commands of shell `text` - split at newlines, ;, &&, || and |,
// line continuations joined, command substitutions and subshells opened up,
// a GitHub expression read as a variable - as words without their quotes,
// each with the directory it runs in: a `cd` to a literal directory moves
// the commands after it, any other `cd` returns to the repository root.
export function simpleCommands(text, cwd = '.') {
  const commands = [];
  let directory = cwd;
  const shell = text.replace(/\\\n/g, ' ').replace(/\$\{\{[^}]*\}\}/g, '$GITHUB_EXPRESSION').replace(/\$\(|[()`]/g, ' ');
  for (const part of shell.split(/\n|;|&&|\|\|?/)) {
    const words = part.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/^['"]+|['"]+$/g, ''));
    while (/^[A-Za-z_]\w*=/.test(words[0] ?? '')) words.shift();
    if (words[0] === 'cd') {
      directory = words[1] && !/[$~`]|^-$/.test(words[1]) ? path.posix.normalize(path.posix.join(directory, words[1])) : '.';
    } else if (words.length) {
      commands.push({ words, cwd: directory });
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

// The repository file a command word names, if any: a path from the
// command's directory, or from the repository root behind a leading
// $VARIABLE/ or ${VARIABLE}/ ("$GITHUB_WORKSPACE/scripts/x.sh"). A word with
// another expansion or a glob names no single file; so does an option.
function namedFiles(word, cwd, exists) {
  return word.split(/=(.*)/s).filter(Boolean).flatMap((part) => {
    let candidate = part.replace(/^['"]+|['"]+$/g, '');
    let base = cwd;
    const rooted = candidate.match(/^\$(?:\{\w+\}|\w+)\/(.+)$/);
    if (rooted) {
      [, candidate] = rooted;
      base = '.';
    }
    if (!/\/|\.\w+$/.test(candidate) || /[$*?{}`()<>|]|^-|^\//.test(candidate)) return [];
    const file = path.posix.normalize(path.posix.join(base, candidate));
    return file === '.' || file.startsWith('../') || !exists(file) ? [] : [file];
  });
}

const SHELL_SCRIPT = /\.(?:sh|bash)$/;

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
  workspaces = readWorkspaces({ readRepoFile }),
  rootManifest = JSON.parse(readRepoFile('package.json') ?? '{}'),
} = {}) {
  const context = { ...workspaces, rootManifest };
  const exists = (file) => readRepoFile(file) !== undefined;
  const scriptText = (workspace, script) => (workspace === '.' ? rootManifest.scripts : workspaces.manifests.get(workspace)?.scripts)?.[script];
  return Object.entries(parse(workflowSource).jobs ?? {}).map(([job, definition]) => {
    const commands = [];
    const projected = new Set();
    const followed = new Set();
    const edges = [];
    const project = (key, text) => {
      if (!projected.has(key)) {
        projected.add(key);
        commands.push(text);
      }
    };
    // Read `text` as commands run in `cwd`, reached through `chain`.
    const readCommands = (text, cwd, chain, via) => {
      const scripts = [];
      const shells = [];
      const queue = simpleCommands(text, cwd);
      for (const effect of COMMAND_EFFECTS) {
        if (effect.command.test(text)) queue.push(...simpleCommands(effect.runs.text, effect.runs.cwd));
      }
      while (queue.length) {
        const command = queue.shift();
        const { scripts: calls, nested, directories } = packageManagerCalls(command, context);
        queue.push(...nested);
        scripts.push(...calls);
        for (const directory of directories) {
          for (const file of command.words.flatMap((word) => namedFiles(word, directory, exists))) {
            edges.push({ kind: 'file', file, chain, via });
            if (SHELL_SCRIPT.test(file)) shells.push([file, directory]);
          }
        }
      }
      for (const [workspace, script] of scripts) {
        for (const name of [`pre${script}`, script, `post${script}`]) runScript(workspace, name, chain, via);
      }
      for (const [file, directory] of shells) {
        const key = `${file}@${chain.map((link) => `${link.workspace}:${link.script}`).join('>')}`;
        const source = readRepoFile(file);
        if (source === undefined || followed.has(key)) continue;
        followed.add(key);
        project(`shell ${file}`, source);
        readCommands(source, directory, chain, `${via} > ${file}`);
      }
    };
    const runScript = (workspace, script, chain, via) => {
      const text = scriptText(workspace, script);
      if (text === undefined || chain.some((link) => link.workspace === workspace && link.script === script)) return;
      const next = [...chain, { workspace, script }];
      const key = next.map((link) => `${link.workspace}:${link.script}`).join('>');
      if (followed.has(key)) return;
      followed.add(key);
      const where = `${via} > ${workspace === '.' ? '' : `${workspace} `}${script}`;
      edges.push({ kind: 'script', workspace, script, chain: next, via: where });
      project(`script ${workspace} ${script}`, text);
      readCommands(text, workspace, next, where);
    };
    const followJob = ({ steps = [], uses } = {}) => {
      for (const step of steps) {
        if (step.run !== undefined && step.run !== null) {
          const run = String(step.run);
          commands.push(run);
          readCommands(run, '.', [], job);
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
      const { jobs, runs } = parse(source);
      if (jobs) for (const nested of Object.values(jobs)) followJob(nested);
      else followJob({ steps: runs?.steps });
    };
    followJob(definition);
    return { job, condition: definition.if ?? '', commands, edges };
  });
}
