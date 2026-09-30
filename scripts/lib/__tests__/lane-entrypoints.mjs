// What CI executes, as the seeds of the load-closure guard in
// ci-delta-routing.test.mjs (traced by traceLaneLoads in load-graph.mjs).
// laneSeeds() starts from what each lane runs: its workspaces' code and
// tests, the support files its job commands name, and the repository scripts
// reached through the workspace scripts CI runs (workspaceScriptRuns). A
// workspace script counts only where a CI command reaches it, never because
// its workspace owns a lane.
import fs from 'node:fs';
import path from 'node:path';
import { CI_LANES, WORKSPACE_OWNING_LANES, WORKSPACE_RULES, isInstallLifecycleScript } from '../ci-delta.mjs';
import { PRIMARY_LANE_JOBS } from '../ci-results.mjs';
import { EVM_TEST_SCOPES } from '../../ci/evm-test-scopes.mjs';
import { REPO_ROOT, sourceFiles, workflowJobCommands } from './ci-plan-fixtures.mjs';
import { readWorkspaces, workspaceClosure } from './load-graph.mjs';

const laneByJob = Object.fromEntries(Object.entries(PRIMARY_LANE_JOBS).map(([lane, job]) => [job, lane]));

// The lane a ci.yml job runs for: its mapped lane or, like a job that only
// calls a reusable workflow, the lane output its condition reads.
export function jobLane(job, condition) {
  return [laneByJob[job], condition.match(/needs\.changes\.outputs\.(\w+) == 'true'/)?.[1]]
    .find((lane) => CI_LANES.includes(lane));
}

// Workspace scripts CI runs from inside another program, where no command
// names them: `release:verify-pack` in the build job runs `npm pack
// --dry-run` in packages/cli (scripts/release-packages.mjs), which runs the
// CLI's prepack. The routing test checks the build job still runs it.
export const IMPLICIT_WORKSPACE_SCRIPTS = Object.freeze([
  { job: 'build', workspace: 'packages/cli', script: 'prepack', via: 'npm pack --dry-run in release:verify-pack' },
]);

// pnpm's own commands, which never name a package script. `test`, `start`,
// `stop` and `restart` run the script of that name.
const PNPM_COMMANDS = new Set([
  'add', 'audit', 'bin', 'config', 'create', 'deploy', 'dlx', 'doctor', 'env', 'exec', 'fetch', 'i', 'import',
  'init', 'install', 'install-test', 'it', 'licenses', 'link', 'list', 'ln', 'ls', 'outdated', 'pack', 'patch',
  'patch-commit', 'prune', 'publish', 'rebuild', 'remove', 'rm', 'root', 'server', 'setup', 'store', 'un',
  'uninstall', 'unlink', 'up', 'update', 'why',
]);
const SCRIPT_ALIASES = new Map([['t', 'test'], ['tst', 'test'], ['test', 'test'], ['start', 'start'], ['stop', 'stop'], ['restart', 'restart']]);
const PNPM_VALUE_FLAGS = new Set(['--filter', '-F', '--dir', '-C', '--reporter', '--loglevel', '--workspace-concurrency']);
const ROOT_MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

// The simple commands of shell `text`, as words without quotes, each with
// the directory it runs in (a `cd` to a literal directory moves the rest).
function simpleCommands(text, cwd) {
  const commands = [];
  let directory = cwd;
  for (const part of text.replace(/\\\n/g, ' ').split(/\n|;|&&|\|\|?/)) {
    const words = part.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/^['"]|['"]$/g, ''));
    while (/^[A-Za-z_]\w*=/.test(words[0] ?? '')) words.shift();
    if (words[0] === 'cd') {
      directory = words[1] && !/[$~]|^-$/.test(words[1]) ? path.posix.normalize(path.posix.join(directory, words[1])) : '.';
    } else if (words.length) {
      commands.push({ words, cwd: directory });
    }
  }
  return commands;
}

// The package workspaces a pnpm filter selector names: a package name (or a
// `*` pattern), `<name>...` with its dependencies, `...<name>` with its
// dependents, `./<dir>` or `{<dir>}`. Any other selector throws, so a new
// form fails the guard instead of hiding what a job runs.
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

// The workspace scripts one simple command runs, as [workspace, script]:
// pnpm [--filter <selector>]... [-r] [--dir <dir>] [run] <script>, npm run
// <script>, pnpm install (every install lifecycle hook) and turbo [run]
// <task>... (every workspace that has the task's script). A command in a
// workspace directory runs that workspace's scripts; the root manifest's
// scripts are followed by workflowJobCommands.
function scriptCalls({ words, cwd }, workspaces) {
  const { manifests, rootManifest } = workspaces;
  const everyWorkspace = [...manifests.keys()];
  const withScript = (targets, script) => targets.filter((workspace) => Object.hasOwn(manifests.get(workspace)?.scripts ?? {}, script));
  const [program, ...rest] = words;
  if (program === 'turbo' || (['npx', 'pnpx'].includes(program) && rest[0] === 'turbo')) {
    const tasks = (program === 'turbo' ? rest : rest.slice(1)).filter((word) => !word.startsWith('-'));
    return (tasks[0] === 'run' ? tasks.slice(1) : tasks).flatMap((task) => withScript(everyWorkspace, task).map((workspace) => [workspace, task]));
  }
  if (program === 'npm') {
    const [verb, script] = rest.filter((word) => !word.startsWith('-'));
    const name = ['run', 'run-script'].includes(verb) ? script : SCRIPT_ALIASES.get(verb);
    return name && manifests.has(cwd) ? withScript([cwd], name).map((workspace) => [workspace, name]) : [];
  }
  if (program !== 'pnpm') return [];
  const included = [];
  const excluded = [];
  let directory;
  let recursive = false;
  let index = 0;
  for (; index < rest.length && rest[index].startsWith('-'); index += 1) {
    const [flag, inline] = rest[index].split(/=(.*)/s);
    const value = inline ?? (PNPM_VALUE_FLAGS.has(flag) ? rest[++index] : undefined);
    if (flag === '--filter' || flag === '-F') {
      (value.startsWith('!') ? excluded : included).push(...selectWorkspaces(value.replace(/^!/, ''), cwd, workspaces));
    } else if (flag === '--dir' || flag === '-C') {
      directory = path.posix.normalize(path.posix.join(cwd, value));
    } else if (flag === '-r' || flag === '--recursive') {
      recursive = true;
    } else if (flag === '-w' || flag === '--workspace-root') {
      directory = '.';
    }
  }
  const verb = rest[index];
  if (verb === 'install' || verb === 'i') {
    // Install runs the root's and every workspace's install lifecycle hooks.
    return [['.', rootManifest], ...manifests].flatMap(([workspace, { scripts = {} }]) => Object.keys(scripts)
      .filter(isInstallLifecycleScript)
      .map((script) => [workspace, script]));
  }
  if (verb === 'exec' && rest[index + 1] === 'turbo') return scriptCalls({ words: rest.slice(index + 1), cwd }, workspaces);
  const script = verb === 'run' || verb === 'run-script'
    ? rest.slice(index + 1).find((word) => !word.startsWith('-'))
    : PNPM_COMMANDS.has(verb) ? undefined : SCRIPT_ALIASES.get(verb) ?? verb;
  if (!script) return [];
  const targets = (directory ? [directory] : included.length ? included : recursive || excluded.length ? everyWorkspace : [cwd])
    .filter((workspace) => !excluded.includes(workspace));
  return withScript(targets.filter((workspace) => manifests.has(workspace)), script).map((workspace) => [workspace, script]);
}

// Every workspace script CI runs, as { workspace, script, text, requirement,
// via }: named by a job's commands (as workflowJobCommands follows them), run
// by pnpm install (install lifecycle hooks, the root's too), by the scripts
// those call (with their pre/post hooks), or listed in
// IMPLICIT_WORKSPACE_SCRIPTS. Each carries the requirement for what it runs:
// - the lane of the ci.yml job that runs it;
// - `full` for an install hook, since every job installs, and for a job that
//   serves no one lane: the shared build job, whose dist/, dist-ui/ and
//   network/ output every lane restores, push-only jobs and the EVM
//   workflow, whose runner every scope uses.
// `workflows` maps a workflow file name to its source; `workspaces` and
// `rootManifest` default to the repository's manifests.
export function workspaceScriptRuns(workflows, { workspaces = readWorkspaces(), rootManifest = ROOT_MANIFEST } = {}) {
  const context = { ...workspaces, rootManifest };
  const runs = new Map();
  const follow = (workspace, script, requirement, via) => {
    const { scripts = {} } = workspace === '.' ? rootManifest : workspaces.manifests.get(workspace) ?? {};
    for (const name of [`pre${script}`, script, `post${script}`]) {
      const key = `${workspace} ${name} ${requirement}`;
      if (!Object.hasOwn(scripts, name) || runs.has(key)) continue;
      runs.set(key, { workspace, script: name, text: scripts[name], requirement, via });
      for (const command of simpleCommands(scripts[name], workspace)) {
        for (const [target, called] of scriptCalls(command, context)) {
          follow(target, called, isInstallLifecycleScript(called) ? 'full' : requirement, `${workspace} ${name}`);
        }
      }
    }
  };
  for (const [workflow, source] of workflows) {
    for (const { job, condition, commands } of workflowJobCommands(source)) {
      const requirement = (workflow === 'ci.yml' && jobLane(job, condition)) || 'full';
      for (const text of commands) {
        for (const command of simpleCommands(text, '.')) {
          for (const [workspace, script] of scriptCalls(command, context)) {
            follow(workspace, script, isInstallLifecycleScript(script) ? 'full' : requirement, `${workflow} ${job}`);
          }
        }
      }
      for (const implicit of IMPLICIT_WORKSPACE_SCRIPTS) {
        if (workflow === 'ci.yml' && implicit.job === job) follow(implicit.workspace, implicit.script, requirement, `${workflow} ${job}: ${implicit.via}`);
      }
    }
  }
  return [...runs.values()];
}

// The repository scripts (under the root scripts/) a workspace script's
// command text names, resolved from the workspace directory.
export function repositoryScriptsRun({ workspace, text }) {
  return [...new Set(text.split(/[\s;&|()<>]+/)
    .flatMap((word) => word.replace(/["']/g, '').split('='))
    .filter((word) => /\//.test(word) && !/[$*]/.test(word))
    .map((word) => path.posix.normalize(path.posix.join(workspace, word)))
    .filter((file) => file.startsWith('scripts/') && fs.statSync(path.join(REPO_ROOT, file), { throwIfNoEntry: false })?.isFile()))];
}

// The load-closure guard's seeds: a Map from each file CI executes to a Map
// from requirement (a lane, `evm:<scope>` or `full`) to where it comes from.
// - A workspace's code and tests run in its owning lanes; node-ui's browser
//   specs in the e2e lane and integration suites in the EVM scope that lists
//   them. A workspace's own scripts/ and fixture workspaces (test-fixtures/)
//   run only where something runs them.
// - A lane job runs the bench, devnet, test-systems and tools files its
//   commands name, as workflowJobCommands follows them.
// - The repository scripts the workspace scripts CI runs name
//   (workspaceScriptRuns), with that run's requirement.
export function laneSeeds({ workflows = ['ci.yml', 'evm-integration.yml'].map((workflow) => [
  workflow,
  fs.readFileSync(path.join(REPO_ROOT, '.github/workflows', workflow), 'utf8'),
]) } = {}) {
  const seeds = new Map();
  const seed = (file, requirements, via) => {
    const entry = seeds.get(file) ?? seeds.set(file, new Map()).get(file);
    for (const requirement of requirements) if (!entry.has(requirement)) entry.set(requirement, via);
  };
  const evmScopeFiles = new Map(Object.entries(EVM_TEST_SCOPES).flatMap(([scope, { packageDirectory, files }]) =>
    files.map((file) => [path.posix.normalize(path.posix.join(packageDirectory, file)), `evm:${scope}`])));
  for (const [workspace, owningLanes] of Object.entries(WORKSPACE_OWNING_LANES)) {
    if (WORKSPACE_RULES[workspace].forceFull) continue;
    for (const file of sourceFiles(workspace)) {
      const inside = file.slice(workspace.length + 1);
      if (/^(?:scripts|test-fixtures|test\/archive)\//.test(inside)) continue;
      // Demo apps' run.mjs entry points run by hand; the demo lane runs tests.
      if (workspace === 'demo' && /^[^/]+\/run\.[cm]?[jt]s$/.test(inside)) continue;
      if (inside.startsWith('integration/')) {
        if (evmScopeFiles.has(file)) seed(file, [evmScopeFiles.get(file)], 'EVM_TEST_SCOPES');
      } else if (workspace === 'packages/node-ui' && inside.startsWith('e2e/')) {
        seed(file, ['kosava_node_ui_e2e'], 'the browser suite');
      } else {
        seed(file, [...owningLanes, ...(evmScopeFiles.has(file) ? [evmScopeFiles.get(file)] : [])], `${workspace} lanes`);
      }
    }
  }
  for (const [workflow, source] of workflows) {
    if (workflow !== 'ci.yml') continue;
    for (const { job, condition, commands } of workflowJobCommands(source)) {
      const lane = jobLane(job, condition);
      if (!lane) continue;
      for (const command of commands) {
        for (const [file] of command.matchAll(/\b(?:bench|devnet|test-systems|tools)\/[^\s'"]+\.[cm]?[jt]sx?\b/g)) {
          seed(file, [lane], `${job} job`);
        }
      }
    }
  }
  for (const run of workspaceScriptRuns(workflows)) {
    for (const script of repositoryScriptsRun(run)) seed(script, [run.requirement], `${run.workspace} ${run.script} (${run.via})`);
  }
  return seeds;
}
