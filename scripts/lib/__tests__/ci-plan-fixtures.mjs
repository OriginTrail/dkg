// Shared fixtures for the CI planner, controller and aggregate-gate tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CI_LANES, PRIMARY_LANE_JOBS, WORKSPACE_RULES, planCi } from '../ci-delta.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const NON_SOLIDITY_LANES = CI_LANES.filter((lane) => lane !== 'contracts');
export const LANE_JOBS = Object.values(PRIMARY_LANE_JOBS);

export function change(filePath, status = 'M') {
  return { status, paths: [filePath] };
}

export function pullRequestPlan(changeEntries, overrides = {}) {
  return planCi({
    eventName: 'pull_request',
    changeEntries,
    ...overrides,
  });
}

export function selectedLanes(plan) {
  return CI_LANES.filter((lane) => plan.lanes[lane]);
}

// The `needs` the primary aggregate gate inspects: `changes` succeeded and
// every other job was skipped, except the jobs named in `results`.
export function gateNeeds(results = {}) {
  const needs = Object.fromEntries([
    'build',
    'evm-node-test-artifacts',
    'evm-devnet-test-artifacts',
    ...LANE_JOBS,
    'abi-freshness',
    'solidity',
    'solidity-coverage',
    'tornado-static-analysis',
  ].map((job) => [job, { result: 'skipped' }]));
  needs.changes = { result: 'success' };
  for (const [job, result] of Object.entries(results)) needs[job] = { result };
  return needs;
}

export function succeeded(...jobs) {
  return Object.fromEntries(jobs.flat().map((job) => [job, 'success']));
}

// Source files (repo-relative) under `directory`, skipping installs and builds.
export function sourceFiles(directory) {
  return fs.readdirSync(path.join(REPO_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', 'dist-ui', 'coverage'].includes(entry.name)) return [];
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [relative] : [];
  });
}

function readWorkspaces() {
  const manifests = new Map(Object.keys(WORKSPACE_RULES).map((workspace) => [
    workspace,
    JSON.parse(fs.readFileSync(path.join(REPO_ROOT, workspace, 'package.json'), 'utf8')),
  ]));
  return { manifests, workspaceByName: new Map([...manifests].map(([workspace, { name }]) => [name, workspace])) };
}

// `roots` plus every workspace they depend on (dependencies and
// devDependencies). Roots that are not workspaces are ignored.
export function workspaceClosure(roots) {
  const { manifests, workspaceByName } = readWorkspaces();
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

const isRepoFile = (candidate) => fs.statSync(path.join(REPO_ROOT, candidate), { throwIfNoEntry: false })?.isFile() === true;
const isRepoDirectory = (candidate) => fs.statSync(path.join(REPO_ROOT, candidate), { throwIfNoEntry: false })?.isDirectory() === true;
const outsideSources = (target) => target === '.' || target.startsWith('../') || /(?:^|\/)node_modules\//.test(target);

// The repo path a reference names. A package's dist/ output stands for its
// src/, so the answer does not depend on whether the build has run, and
// TypeScript sources are imported by their emitted extension or none.
function sourcePath(target) {
  const built = target.match(/^(packages\/[^/]+)\/dist(\/.*)?$/);
  if (built) {
    const [, packageDirectory, rest = ''] = built;
    const inSources = `${packageDirectory}/src${rest}`;
    if (!/\.[cm]?js$/.test(inSources)) return inSources;
    const candidates = ['ts', 'tsx', 'mts'].map((extension) => inSources.replace(/\.[cm]?js$/, `.${extension}`));
    return candidates.find(isRepoFile) ?? candidates[0];
  }
  return [
    target,
    target.replace(/\.js$/, '.ts'),
    target.replace(/\.js$/, '.tsx'),
    target.replace(/\.mjs$/, '.mts'),
    `${target}.ts`,
    `${target}/index.ts`,
  ].find(isRepoFile) ?? target;
}

const MODULE_LOAD = /(?:\bfrom\s*|\bimport\s*\(\s*(?:new\s+URL\(\s*)?)['"]((?:\.\.?\/)+[^'"]+)['"]/g;
const URL_PATH = /\bnew\s+URL\(\s*['"]((?:\.\.?\/)+[^'"]+)['"]/g;
const PACKAGE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)['"](@origintrail-official\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/g;
const PATH_JOIN = /(?:\b(?:const|let)\s+([\w$]+)\s*=\s*)?(?:\bpath\.)?\b(?:resolve|join)\(\s*([\w$]+)\s*((?:,\s*(?:'[^']*'|"[^"]*"))+)\s*\)/g;
const REPO_PATH_LITERAL = /['"]((?:[\w@.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)['"]/g;
const TEST_FILE = /(?:^|\/)(?:test|tests|test-live|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TYPE_ONLY_IMPORT = /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s*['"][^'"]+['"]/g;

// A path a file reads or runs (not a module it imports): an existing file,
// or a directory when the file walks directories; otherwise it names a
// location rather than contents.
function readTarget(target, walks) {
  const mapped = /^packages\/[^/]+\/dist(?:\/|$)/.test(target) ? sourcePath(target) : target;
  if (outsideSources(mapped)) return undefined;
  if (isRepoDirectory(mapped)) return walks ? mapped : undefined;
  const file = isRepoFile(mapped) ? mapped : sourcePath(mapped);
  return isRepoFile(file) ? file : undefined;
}

// Paths `file` builds with path.resolve/join from its own directory
// (__dirname or import.meta.url) and literal segments, including bindings
// built on earlier ones. A directory counts only when the file walks
// directories; otherwise it names a location rather than contents.
function builtPaths(file, source) {
  const bases = new Map([['__dirname', path.posix.dirname(file)]]);
  for (const [, name] of source.matchAll(/\b(?:const|let)\s+([\w$]+)\s*=\s*(?:path\.)?dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)/g)) {
    bases.set(name, path.posix.dirname(file));
  }
  const segments = (text) => [...text.matchAll(/'([^']*)'|"([^"]*)"/g)].map(([, single, double]) => single ?? double);
  const joined = (base, text) => path.posix.normalize(path.posix.join(bases.get(base), ...segments(text)));
  for (let size = -1; size !== bases.size;) {
    size = bases.size;
    for (const [, name, base, text] of source.matchAll(PATH_JOIN)) {
      if (name && !bases.has(name) && bases.has(base)) bases.set(name, joined(base, text));
    }
  }
  return [...source.matchAll(PATH_JOIN)]
    .filter(([, , base]) => bases.has(base))
    .map(([, , base, text]) => joined(base, text));
}

// What `file` (repo-relative, with `source` as its contents) loads by path:
// - `modules`: relative imports, dynamic imports and `import(new URL(...))`,
//   whose own imports load too;
// - `paths`: files it reads or runs without importing: other `new URL(...)`
//   paths, paths built from its own directory (see builtPaths) and, in test
//   files, quoted literals naming an existing repo file
//   (`'packages/agent/src/x.ts'`, as source-scanning tests list them);
// - `packages`: workspaces it imports by package name.
// Type-only imports are erased before anything runs; paths assembled at run
// time from variables are out of reach.
export function loadReferences(file, source) {
  const code = source.replace(TYPE_ONLY_IMPORT, '');
  const walks = /\b(?:readdir|opendir)(?:Sync)?\(/.test(code);
  const relative = (specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  const modules = [...new Set([...code.matchAll(MODULE_LOAD)].map(([, specifier]) => sourcePath(relative(specifier))))]
    .filter((target) => !outsideSources(target));
  const literals = (TEST_FILE.test(file) ? [...code.matchAll(REPO_PATH_LITERAL)] : [])
    .map(([, literal]) => literal)
    .filter((literal) => !/(?:^|\/)\.\.?(?:\/|$)/.test(literal));
  const paths = [
    ...[...code.matchAll(URL_PATH)].map(([, specifier]) => relative(specifier)),
    ...builtPaths(file, code),
    ...literals,
  ].map((target) => readTarget(target, walks)).filter(Boolean);
  return {
    modules,
    paths: [...new Set(paths)].filter((target) => !modules.includes(target) && target !== file),
    packages: [...new Set([...code.matchAll(PACKAGE_IMPORT)].map(([, name]) => name))],
  };
}
