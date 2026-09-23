// The load graph behind the routing guard in ci-delta-routing.test.mjs: what
// a source file loads by path (loadReferences) and everything a set of seeded
// files loads, with the lane that reaches each file (traceLaneLoads). Its
// own tests pin the forms it follows and the ones it cannot see.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { WORKSPACE_RULES } from '../ci-delta.mjs';
import { REPO_ROOT } from './ci-plan-fixtures.mjs';

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
const readRepoFile = (file) => (isRepoFile(file) ? fs.readFileSync(path.join(REPO_ROOT, file), 'utf8') : undefined);

// The repo path a reference names. Built output (a dist/ directory, including
// a fixture workspace's) stands for its src/, so the answer does not depend on
// whether the build has run, and TypeScript sources are imported by their
// emitted extension or none.
function sourcePath(target) {
  const built = target.match(/^(.+?)\/dist(\/.*)?$/);
  if (built) {
    const [, directory, rest = ''] = built;
    const inSources = `${directory}/src${rest}`;
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

// Module loads come from TypeScript's import scanner (importSpecifiers).
// The forms below are matched as text instead, so each has blind spots:
// a path assembled at run time (a template literal, a variable, a call other
// than resolve/join, a base other than the file's own directory, require()
// under another name) is out of reach, and `import { type X }` still counts
// as a load. The scanner tests pin what they see and what they cannot.
const RELATIVE = String.raw`['"]((?:\.\.?\/)+[^'"]+)['"]`;
// import(new URL('./x.js', import.meta.url)): not a string specifier, so
// TypeScript's scanner does not report it.
const URL_IMPORT = new RegExp(String.raw`\bimport\s*\(\s*new\s+URL\(\s*` + RELATIVE, 'g');
const URL_PATH = new RegExp(String.raw`(?:\bnew\s+URL\(\s*|\brequire\.resolve\s*\(\s*)` + RELATIVE, 'g');
const REPO_PATH_LITERAL = /['"]((?:[\w@.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)['"]/g;
// Files that list the paths a lane runs or reads: tests, and test-runner configs.
const TEST_FILE = /(?:^|\/)(?:test|tests|test-live|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:vitest|playwright)[\w.-]*\.config\.[cm]?[jt]s$/;
const TYPE_ONLY_IMPORT = /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s*['"][^'"]+['"]/g;

// A path a file reads or runs (not a module it imports): an existing file,
// or a directory when the file walks directories; otherwise it names a
// location rather than contents.
function readTarget(target, walks) {
  const mapped = /(?:^|\/)dist(?:\/|$)/.test(target) ? sourcePath(target) : target;
  if (outsideSources(mapped)) return undefined;
  if (isRepoDirectory(mapped)) return walks ? mapped : undefined;
  const file = isRepoFile(mapped) ? mapped : sourcePath(mapped);
  return isRepoFile(file) ? file : undefined;
}

// Paths `file` builds with path.resolve/join (or an alias imported from
// node:path) from its own directory - __dirname, import.meta.dirname or a
// binding of either, dirname(fileURLToPath(import.meta.url)) or
// fileURLToPath(new URL(..., import.meta.url)) - and literal segments,
// including bindings built on earlier ones.
function builtPaths(file, source) {
  const directory = path.posix.dirname(file);
  const helpers = ['resolve', 'join'];
  for (const [, specifiers] of source.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*['"](?:node:)?path(?:\/posix)?['"]/g)) {
    for (const [, alias] of specifiers.matchAll(/\b(?:resolve|join)\s+as\s+([\w$]+)/g)) helpers.push(alias);
  }
  const pathJoin = new RegExp(
    String.raw`(?:\b(?:const|let)\s+([\w$]+)\s*=\s*)?(?:\bpath\.(?:posix\.)?)?\b(?:${helpers.join('|')})\(\s*([\w$]+|import\.meta\.dirname)\s*((?:,\s*(?:'[^']*'|"[^"]*"))+)\s*,?\s*\)`,
    'g',
  );
  const bases = new Map([['__dirname', directory], ['import.meta.dirname', directory]]);
  for (const [, name] of source.matchAll(/\b(?:const|let)\s+([\w$]+)\s*=\s*(?:(?:path\.)?dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)|import\.meta\.dirname\b)/g)) {
    bases.set(name, directory);
  }
  for (const [, name, specifier] of source.matchAll(/\b(?:const|let)\s+([\w$]+)\s*=\s*fileURLToPath\(\s*new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)\s*\)/g)) {
    bases.set(name, path.posix.normalize(path.posix.join(directory, specifier)));
  }
  const segments = (text) => [...text.matchAll(/'([^']*)'|"([^"]*)"/g)].map(([, single, double]) => single ?? double);
  const joined = (base, text) => path.posix.normalize(path.posix.join(bases.get(base), ...segments(text)));
  for (let size = -1; size !== bases.size;) {
    size = bases.size;
    for (const [, name, base, text] of source.matchAll(pathJoin)) {
      if (name && !bases.has(name) && bases.has(base)) bases.set(name, joined(base, text));
    }
  }
  return [...source.matchAll(pathJoin)]
    .filter(([, , base]) => bases.has(base))
    .map(([, , base, text]) => joined(base, text));
}

// The module specifiers `code` loads, read with TypeScript's import scanner
// (ts.preProcessFile, as test-fixture-inputs.mjs reads imports): import and
// export declarations, side-effect imports, import() of a string and
// require(), but never a path that a comment or string only mentions; plus
// URL_IMPORT.
function importSpecifiers(code) {
  return [
    ...ts.preProcessFile(code, true, true).importedFiles.map(({ fileName }) => fileName),
    ...[...code.matchAll(URL_IMPORT)].map(([, specifier]) => specifier),
  ];
}

const packageNames = (specifiers) => [...new Set(specifiers
  .map((specifier) => specifier.match(/^@origintrail-official\/[a-z0-9-]+/)?.[0])
  .filter(Boolean))];

// The workspaces `source` imports by package name: static, side-effect and
// dynamic imports and require().
export function packageImports(source) {
  return packageNames(importSpecifiers(source));
}

// What `file` (repo-relative, with `source` as its contents) loads by path:
// - `modules`: relative imports (side-effect `import './x.js'` included),
//   dynamic imports, `import(new URL(...))` and CommonJS require(), whose own
//   imports load too;
// - `paths`: files it reads or runs without importing: other `new URL(...)`
//   paths, require.resolve(), paths built from its own directory (see
//   builtPaths) and, in tests and test-runner configs, quoted literals naming
//   an existing repo file (`'packages/agent/src/x.ts'`, as source-scanning
//   tests list them);
// - `packages`: workspaces it imports by package name (packageImports).
// Type-only imports are erased before anything runs; paths assembled at run
// time from variables are out of reach.
export function loadReferences(file, source) {
  const code = source.replace(TYPE_ONLY_IMPORT, '');
  const walks = /\b(?:readdir|opendir)(?:Sync)?\(/.test(code);
  const relative = (specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  const specifiers = importSpecifiers(code);
  const modules = [...new Set(specifiers
    .filter((specifier) => /^\.\.?\//.test(specifier))
    .map((specifier) => sourcePath(relative(specifier))))]
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
    packages: packageNames(specifiers),
  };
}

// Everything the seeded files load, and which requirement (a lane, or
// `evm:<scope>`) reaches each file through which file. `seeds` maps a file to
// a Map from requirement to where it comes from, the same shape as the result.
// A module load carries its importer's requirements on to what it imports; a
// path read or run is required but not followed; a package-name import
// requires the imported workspace and its dependencies, recorded against the
// workspace's src/index.ts since any path in a workspace routes by its rule.
// `read(file)` returns a file's source, or undefined when it has none.
export function traceLaneLoads(seeds, { read = readRepoFile } = {}) {
  const { workspaceByName } = readWorkspaces();
  const closures = new Map();
  const closureOf = (workspace) => closures.get(workspace) ?? closures.set(workspace, workspaceClosure([workspace])).get(workspace);
  const needsOf = (map, key) => map.get(key) ?? map.set(key, new Map()).get(key);
  const add = (map, key, requirements, via) => {
    const entry = needsOf(map, key);
    const added = requirements.filter((requirement) => !entry.has(requirement));
    for (const requirement of added) entry.set(requirement, via);
    return added.length > 0;
  };
  const loaded = new Map();
  for (const [file, needs] of seeds) {
    for (const [requirement, via] of needs) add(loaded, file, [requirement], via);
  }
  // Kept apart while tracing so they never spread through a module's imports.
  const readPaths = new Map();
  const workspacesLoaded = new Map();
  const queue = [...loaded.keys()];
  while (queue.length) {
    const file = queue.shift();
    const source = /\.[cm]?[jt]sx?$/.test(file) ? read(file) : undefined;
    if (source === undefined) continue;
    const requirements = [...loaded.get(file).keys()];
    const { modules, paths, packages } = loadReferences(file, source);
    for (const target of modules) {
      if (add(loaded, target, requirements, file)) queue.push(target);
    }
    for (const target of paths) add(readPaths, target, requirements, file);
    for (const name of packages) {
      if (!workspaceByName.has(name)) continue;
      for (const workspace of closureOf(workspaceByName.get(name))) {
        add(workspacesLoaded, workspace, requirements, `${file} (imports ${name})`);
      }
    }
  }
  for (const [key, needs] of [
    ...readPaths,
    ...[...workspacesLoaded].map(([workspace, requirements]) => [`${workspace}/src/index.ts`, requirements]),
  ]) {
    for (const [requirement, via] of needs) add(loaded, key, [requirement], via);
  }
  return loaded;
}
