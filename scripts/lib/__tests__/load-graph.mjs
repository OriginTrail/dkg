// The load graph behind the routing guard in ci-delta-routing.test.mjs: what
// a source file loads by path (loadReferences) and everything a set of seeded
// files loads, with the lane that reaches each file (traceLaneLoads). Its
// own tests pin the forms it follows and the ones it cannot see.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { analyzeShell, commandFiles, isShellScript, packageScriptEdges, scriptOperand, workspaceCatalog, workspaceClosure } from './ci-execution-graph.mjs';
import { REPO_ROOT } from './ci-plan-fixtures.mjs';

export { workspaceCatalog, workspaceClosure };

const isRepoFile = (candidate) => fs.statSync(path.join(REPO_ROOT, candidate), { throwIfNoEntry: false })?.isFile() === true;
const isRepoDirectory = (candidate) => fs.statSync(path.join(REPO_ROOT, candidate), { throwIfNoEntry: false })?.isDirectory() === true;
const outsideSources = (target) => target === '.' || target.startsWith('../') || /(?:^|\/)node_modules\//.test(target);
const readRepoFile = (file) => (isRepoFile(file) ? fs.readFileSync(path.join(REPO_ROOT, file), 'utf8') : undefined);

// The repo path a reference names. Built output (a dist/ directory, including
// a fixture workspace's) stands for its src/, so the answer does not depend on
// whether the build has run, and TypeScript sources are imported by their
// emitted extension or none.
function sourcePath(target, isFile = isRepoFile) {
  const built = target.match(/^(.+?)\/dist(\/.*)?$/);
  if (built) {
    const [, directory, rest = ''] = built;
    const inSources = `${directory}/src${rest}`;
    if (!/\.[cm]?js$/.test(inSources)) return inSources;
    const candidates = ['ts', 'tsx', 'mts'].map((extension) => inSources.replace(/\.[cm]?js$/, `.${extension}`));
    return candidates.find(isFile) ?? candidates[0];
  }
  return [
    target,
    target.replace(/\.js$/, '.ts'),
    target.replace(/\.js$/, '.tsx'),
    target.replace(/\.mjs$/, '.mts'),
    `${target}.ts`,
    `${target}/index.ts`,
  ].find(isFile) ?? target;
}

// Module loads come from TypeScript's import scanner (importSpecifiers); one
// whose specifier is computed at run time is reported (computedLoads), and
// the routing guard fails until it is listed with a reason. The forms below
// are matched as text instead, so each has blind spots: a path assembled at
// run time (a template literal, a variable, a call other than resolve/join,
// a base other than the file's own directory, require() under another name)
// is out of reach, and `import { type X }` still counts as a load. The
// scanner tests pin what they see and what they cannot.
const RELATIVE = String.raw`['"]((?:\.\.?\/)+[^'"]+)['"]`;
// import(new URL('./x.js', import.meta.url)): not a string specifier, so
// TypeScript's scanner does not report it.
const URL_IMPORT = new RegExp(String.raw`\bimport\s*\(\s*new\s+URL\(\s*` + RELATIVE, 'g');
const URL_PATH = new RegExp(String.raw`(?:\bnew\s+URL\(\s*|\brequire\.resolve\s*\(\s*)` + RELATIVE, 'g');
const REPO_PATH_LITERAL = /['"]((?:[\w@.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)['"]/g;
// Text that ends inside a scripts/ path ("scripts/", "$ROOT/scripts/devnet-"),
// so whatever follows it completes the script's path.
const OPEN_SCRIPT_PATH = /(?:^|[^\w.-])scripts\/(?:[\w.-]+\/)*[\w.-]*$/;
// A path segment naming a scripts directory: 'scripts', '../../scripts/'.
const SCRIPTS_DIRECTORY = /(?:^|\/)scripts\/?$/;
// Files that list the paths a lane runs or reads: tests, and test-runner configs.
const TEST_FILE = /(?:^|\/)(?:test|tests|test-live|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:vitest|playwright)[\w.-]*\.config\.[cm]?[jt]s$/;
const TYPE_ONLY_IMPORT = /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s*['"][^'"]+['"]/g;

// A path a file reads or runs (not a module it imports): an existing file,
// or a directory when the file walks directories; otherwise it names a
// location rather than contents. `context` is the repository it is in
// (checkoutContext, overlayContext or fixtureContext).
function readTarget(target, walks, { isFile, isDirectory }) {
  const mapped = /(?:^|\/)dist(?:\/|$)/.test(target) ? sourcePath(target, isFile) : target;
  if (outsideSources(mapped)) return undefined;
  if (isDirectory(mapped)) return walks ? mapped : undefined;
  const file = isFile(mapped) ? mapped : sourcePath(mapped, isFile);
  return isFile(file) ? file : undefined;
}

// The repository a trace reads: `read(file)` returns a file's source
// (undefined when there is none), `isFile` and `isDirectory` say what a path
// is, and `workspaces` ({ manifests, workspaceByName }) and `rootManifest`
// are what pnpm installs and runs. Every reading below takes one, built by
// one of three constructors, each with a single boundary:
// - checkoutContext(): the repository checkout, built once;
// - overlayContext(base, files): `base` with the sources in `files` (a Map
//   from path to text) added or replaced; the manifests stay the base's, so
//   an overlay naming a manifest throws;
// - fixtureContext(files): nothing but `files`, from which the directories,
//   the workspaces (pnpm-workspace.yaml) and the root manifest come too.
let checkout;
export function checkoutContext() {
  return checkout ??= Object.freeze({
    read: readRepoFile,
    isFile: isRepoFile,
    isDirectory: isRepoDirectory,
    workspaces: workspaceCatalog(),
    rootManifest: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')),
  });
}
const isManifest = (file) => file === 'pnpm-workspace.yaml' || path.posix.basename(file) === 'package.json';
// Every directory above the files.
const directoriesOf = (files) => new Set([...files].flatMap((file) => {
  const parts = file.split('/').slice(0, -1);
  return parts.map((part, index) => parts.slice(0, index + 1).join('/'));
}));
export function overlayContext(base, files) {
  const manifest = [...files.keys()].find(isManifest);
  if (manifest !== undefined) throw new Error(`an overlay keeps its base's manifests; ${manifest} needs a fixtureContext`);
  const directories = directoriesOf(files.keys());
  return Object.freeze({
    ...base,
    read: (file) => (files.has(file) ? files.get(file) : base.read(file)),
    isFile: (file) => files.has(file) || base.isFile(file),
    isDirectory: (candidate) => directories.has(candidate) || base.isDirectory(candidate),
  });
}
export function fixtureContext(files) {
  const directories = directoriesOf(files.keys());
  const read = (file) => files.get(file);
  const listDirectories = (parent) => [...directories]
    .filter((candidate) => path.posix.dirname(candidate) === parent)
    .map((candidate) => path.posix.basename(candidate))
    .sort();
  return Object.freeze({
    read,
    isFile: (file) => files.has(file),
    isDirectory: (candidate) => directories.has(candidate),
    workspaces: workspaceCatalog({ readRepoFile: read, listDirectories }),
    rootManifest: JSON.parse(read('package.json') ?? '{}'),
  });
}

const scriptKind = (file) => (/\.[cm]?[jt]sx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);

// The module specifiers `code` loads, read with TypeScript's import scanner
// (ts.preProcessFile, as test-fixture-inputs.mjs reads imports): import and
// export declarations, side-effect imports, import() of a string and
// require(), but never a path that a comment or string only mentions; plus
// URL_IMPORT.
export function importSpecifiers(code) {
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

// The file a package subpath import loads (`@origintrail-official/x/sub`),
// through the workspace's `exports` map (a string, or the require, import or
// default condition) in `context`; undefined when the map names none or its
// file (or the source it is built from) does not exist, so the import counts
// as the whole package.
function subpathTarget(specifier, { workspaces, isFile }) {
  const [, name, subpath] = specifier.match(/^(@origintrail-official\/[a-z0-9-]+)\/(.+)$/) ?? [];
  const workspace = name && workspaces.workspaceByName.get(name);
  let entry = workspace ? workspaces.manifests.get(workspace)?.exports?.[`./${subpath}`] : undefined;
  while (entry && typeof entry === 'object') entry = entry.require ?? entry.import ?? entry.default;
  const target = typeof entry === 'string' ? sourcePath(path.posix.normalize(path.posix.join(workspace, entry)), isFile) : undefined;
  return target !== undefined && isFile(target) ? target : undefined;
}

const isLiteral = (node) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
const NO_ANALYSIS = Object.freeze({
  builtPaths: [], unresolvedReads: [], computedLoads: [], strings: [], assembledScriptPaths: [], runPaths: [], unresolvedRuns: [],
});
// The functions that run a file as a child process or worker, by the module
// that exports them (with or without node:), and how each names that file:
// - program: a program and its arguments (spawn, execFile, execa): a script
//   runner's operand (scriptOperand: node, bash, python), or the program;
// - module: the module it runs (fork, execaNode, worker_threads' Worker);
// - command: a command line (exec, execaCommand), read as shell.
const RUNNER_MODULES = new Map([
  ['child_process', { spawn: 'program', spawnSync: 'program', execFile: 'program', execFileSync: 'program', fork: 'module', exec: 'command', execSync: 'command' }],
  ['worker_threads', { Worker: 'module' }],
  ['execa', { execa: 'program', execaSync: 'program', execaNode: 'module', execaCommand: 'command', execaCommandSync: 'command' }],
]);
const runnerKinds = (specifier) => RUNNER_MODULES.get(specifier.replace(/^node:/, ''));
const NO_MANIFESTS = Object.freeze({ manifests: new Map(), workspaceByName: new Map(), rootManifest: {} });

// One pass over a module's syntax tree for what TypeScript's import scanner
// does not report. It reads the join and resolve helpers from the module's
// node:path imports (join, resolve and their aliases; path, posix and win32
// bindings) and keeps a table of the directories const and let bindings
// hold: the module's own directory (__dirname, import.meta.dirname,
// dirname(fileURLToPath(import.meta.url))), fileURLToPath(new URL('...',
// import.meta.url)), and a join/resolve of a known directory and literal
// segments, through any chain of bindings. From each call it records:
// - builtPaths: the path a join/resolve call builds from a known directory
//   and string-literal segments;
// - unresolvedReads: the literal path a join/resolve call reads from a
//   directory it cannot resolve (join(resolvePackageDir(dir), 'x.json')
//   reads 'x.json'), which stays the same when the directory's expression
//   changes;
// - computedLoads: module loads whose specifier is computed at run time
//   (import(name), require(`../${file}`)), as source text; no trace can follow
//   them. A string specifier, or new URL() of one (URL_IMPORT and URL_PATH
//   read those), is not computed; require() under another name is not seen.
// - strings: the text of its string and template literals, plus the path a
//   join/resolve call builds from a scripts directory and literal segments
//   (join(root, 'scripts', 'devnet.sh') names scripts/devnet.sh); comments
//   are not in the tree.
// - assembledScriptPaths: script paths it assembles at run time, as source
//   text - a template literal or `+` that continues a scripts/ path with a
//   value (`scripts/${name}`), or a join/resolve call that joins a value onto
//   a scripts directory (join(root, 'scripts', helper)) - which no trace can
//   follow either.
// - runPaths: the files it runs as a child process or worker, through the
//   runners it imports from RUNNER_MODULES under any name (an alias, a
//   namespace, a require() binding) - the file each call names, read as a
//   path: a repository path, a file URL made from a literal, a built path, a
//   join onto a scripts directory, or a binding holding one
//   (spawnSync(process.execPath, [join(root, 'scripts', 'x.mjs')]) runs
//   scripts/x.mjs), and the files an exec command line runs;
// - unresolvedRuns: the file a runner runs when no reading resolves it (a
//   parameter, a property, a temporary copy), as source text, which the
//   routing guard fails on until it is listed, as it does a computed load. A
//   program other than a script runner (git, docker) is a tool, not a file.
// `context` is the repository it is in (checkoutContext, overlayContext or
// fixtureContext).
function analyzeModule(file, code, context) {
  if (!/\b(?:import|require)\s*\(|scripts|\b(?:join|resolve)\s*\(|__dirname|import\.meta|child_process|worker_threads|execa/.test(code)) return NO_ANALYSIS;
  const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, scriptKind(file));
  const directory = path.posix.dirname(file);
  const helpers = new Set(['join', 'resolve']);
  const pathModules = new Set(['path', 'posix', 'path.posix', 'path.win32']);
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !/^(?:node:)?path(?:\/posix)?$/.test(statement.moduleSpecifier.text)) continue;
    const { name, namedBindings } = statement.importClause ?? {};
    if (name) pathModules.add(name.text);
    if (namedBindings && ts.isNamespaceImport(namedBindings)) pathModules.add(namedBindings.name.text);
    for (const element of namedBindings && ts.isNamedImports(namedBindings) ? namedBindings.elements : []) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === 'join' || imported === 'resolve') helpers.add(element.name.text);
      if (imported === 'posix' || imported === 'win32') pathModules.add(element.name.text);
    }
  }
  const pathHelper = ({ expression }) => (ts.isIdentifier(expression) && helpers.has(expression.text))
    || (ts.isPropertyAccessExpression(expression) && ['join', 'resolve'].includes(expression.name.text)
      && pathModules.has(expression.expression.getText(tree)));
  const isCallOf = (node, name) => ts.isCallExpression(node) && node.arguments.length === 1
    && ((ts.isIdentifier(node.expression) && node.expression.text === name)
      || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === name));
  const isMetaUrl = (node) => node?.getText(tree) === 'import.meta.url';
  // The directories bindings hold, by name.
  const bases = new Map([['__dirname', directory]]);
  const baseOf = (node) => (ts.isIdentifier(node) ? bases.get(node.text) : heldDirectory(node));
  // The path a join/resolve call builds from a known directory and literals;
  // `base` reads a directory expression (baseOf, or runBaseOf for a run).
  const builtPath = (node, base = baseOf) => {
    if (!ts.isCallExpression(node) || !pathHelper(node) || node.arguments.length < 2) return undefined;
    const [first, ...segments] = node.arguments;
    const start = base(first);
    if (start === undefined || !segments.every((segment) => ts.isStringLiteral(segment))) return undefined;
    return path.posix.normalize(path.posix.join(start, ...segments.map(({ text }) => text)));
  };
  // The directory an expression holds: the module's own, a file URL made
  // from a literal, or a built path.
  const heldDirectory = (node, base = baseOf) => {
    if (node.getText(tree) === 'import.meta.dirname') return directory;
    if (isCallOf(node, 'dirname') && isCallOf(node.arguments[0], 'fileURLToPath') && isMetaUrl(node.arguments[0].arguments[0])) return directory;
    if (isCallOf(node, 'fileURLToPath')) {
      const [url] = node.arguments;
      if (ts.isNewExpression(url) && url.expression.getText(tree) === 'URL' && url.arguments?.length === 2
        && ts.isStringLiteral(url.arguments[0]) && isMetaUrl(url.arguments[1])) {
        return path.posix.normalize(path.posix.join(directory, url.arguments[0].text));
      }
    }
    return builtPath(node, base);
  };
  // The runners the module imports (RUNNER_MODULES), by local name, and the
  // bindings that hold a runner module whole (import * as cp, import cp,
  // require('node:child_process')): an alias runs as what it names, and a
  // method that shares a runner's name (a RegExp's exec) runs nothing.
  const runnerNames = new Map();
  const runnerModules = new Map();
  const bindRunners = (kinds, name, elements) => {
    if (name) runnerModules.set(name, kinds);
    for (const [imported, local] of elements) if (kinds[imported]) runnerNames.set(local, kinds[imported]);
  };
  for (const statement of tree.statements) {
    const kinds = ts.isImportDeclaration(statement) ? runnerKinds(statement.moduleSpecifier.text) : undefined;
    if (!kinds) continue;
    const { name, namedBindings } = statement.importClause ?? {};
    if (namedBindings && ts.isNamespaceImport(namedBindings)) bindRunners(kinds, namedBindings.name.text, []);
    const named = namedBindings && ts.isNamedImports(namedBindings) ? namedBindings.elements : [];
    bindRunners(kinds, name?.text, named.map((element) => [(element.propertyName ?? element.name).text, element.name.text]));
  }
  const requiredModule = (node) => (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
    && node.arguments.length === 1 && isLiteral(node.arguments[0]) ? runnerKinds(node.arguments[0].text) : undefined);
  // How many bindings each name has in the module - declarations,
  // parameters, imports, function and class names - so the run analysis reads
  // a name through its declaration only when that is its one binding, a
  // const: a parameter or another scope's declaration could shadow any other.
  const bindingCounts = new Map();
  const countBinding = (name) => {
    if (name === undefined) return;
    if (ts.isIdentifier(name)) bindingCounts.set(name.text, (bindingCounts.get(name.text) ?? 0) + 1);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) if (!ts.isOmittedExpression(element)) countBinding(element.name);
    }
  };
  const constInitializers = new Map();
  const bindings = [];
  const collect = (node) => {
    if (ts.isVariableDeclarationList(node) && (node.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) {
      bindings.push(...node.declarations.filter((declaration) => ts.isIdentifier(declaration.name) && declaration.initializer));
    }
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const)) {
      for (const { name, initializer } of node.declarations) if (ts.isIdentifier(name) && initializer) constInitializers.set(name.text, initializer);
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) countBinding(node.name);
    if ((ts.isImportClause(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) countBinding(node.name);
    const kinds = ts.isVariableDeclaration(node) && node.initializer ? requiredModule(node.initializer) : undefined;
    if (kinds && ts.isIdentifier(node.name)) bindRunners(kinds, node.name.text, []);
    if (kinds && ts.isObjectBindingPattern(node.name)) {
      bindRunners(kinds, undefined, node.name.elements.filter((element) => ts.isIdentifier(element.name))
        .map((element) => [(element.propertyName ?? element.name).getText(tree), element.name.text]));
    }
    ts.forEachChild(node, collect);
  };
  collect(tree);
  for (let size = -1; size !== bases.size;) {
    size = bases.size;
    for (const { name, initializer } of bindings) {
      if (bases.has(name.text)) continue;
      const held = heldDirectory(initializer);
      if (held !== undefined) bases.set(name.text, held);
    }
  }
  // The repository script a join/resolve call names by joining literals onto
  // a scripts directory, whatever the directory before it
  // (join(root, 'scripts', 'devnet.sh') names scripts/devnet.sh).
  const scriptsPath = (node) => {
    if (!ts.isCallExpression(node) || !pathHelper(node)) return undefined;
    const scriptsAt = node.arguments.findIndex((argument) => isLiteral(argument) && SCRIPTS_DIRECTORY.test(argument.text));
    const segments = scriptsAt >= 0 ? node.arguments.slice(scriptsAt + 1) : [];
    return segments.length && segments.every(isLiteral) ? ['scripts', ...segments.map(({ text }) => text)].join('/') : undefined;
  };
  // A name's const initializer, and the directory it holds, when that const
  // is the name's one binding in the module.
  const soleInitializer = (name) => (bindingCounts.get(name) === 1 ? constInitializers.get(name) : undefined);
  const soleBase = (name) => (soleInitializer(name) !== undefined ? bases.get(name) : undefined);
  const runBaseOf = (node) => (ts.isIdentifier(node) ? soleBase(node.text) : heldDirectory(node, runBaseOf));
  // The files an expression names as something to run (runPaths).
  const runTargets = (node, depth = 0) => {
    if (node === undefined || depth > 8) return [];
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((element) => runTargets(element, depth + 1));
    if (ts.isSpreadElement(node) || ts.isParenthesizedExpression(node)) return runTargets(node.expression, depth + 1);
    if (ts.isPropertyAccessExpression(node) && ['href', 'pathname'].includes(node.name.text)) return runTargets(node.expression, depth + 1);
    if (isCallOf(node, 'fileURLToPath') || isCallOf(node, 'pathToFileURL')) return runTargets(node.arguments[0], depth + 1);
    if (ts.isNewExpression(node) && node.expression.getText(tree) === 'URL' && node.arguments?.length === 2
      && ts.isStringLiteral(node.arguments[0]) && isMetaUrl(node.arguments[1])) {
      return [path.posix.normalize(path.posix.join(directory, node.arguments[0].text))];
    }
    if (isLiteral(node)) return /^[\w@.+~/-]+$/.test(node.text) ? [path.posix.normalize(node.text)] : [];
    if (ts.isIdentifier(node)) {
      const base = soleBase(node.text);
      return base !== undefined ? [base] : runTargets(soleInitializer(node.text), depth + 1);
    }
    const built = builtPath(node, runBaseOf) ?? scriptsPath(node);
    return built === undefined ? [] : [built];
  };
  // How a call runs a file (RUNNER_MODULES), when its callee is an imported
  // runner or a runner module's member.
  // The runner an expression names: an imported runner, a runner module's
  // member, or an alias of one.
  // An expression without its type assertions, parentheses and `!`.
  const unwrap = (node) => (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) ? unwrap(node.expression) : node);
  const runnerNamed = (expression) => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) return runnerNames.get(node.text);
    if (ts.isCallExpression(node)) return aliasedRunner(node);
    if (!ts.isPropertyAccessExpression(node)) return undefined;
    const kinds = ts.isIdentifier(node.expression) ? runnerModules.get(node.expression.text) : requiredModule(node.expression);
    return kinds?.[node.name.text];
  };
  // An alias keeps its runner: a sole const bound to a runner, to
  // promisify(runner) or to runner.bind(thisValue) calls the same way.
  const aliasedRunner = (value) => {
    if (value === undefined) return undefined;
    const initializer = unwrap(value);
    if (!ts.isCallExpression(initializer)) return runnerNamed(initializer);
    const { expression, arguments: args } = initializer;
    const promisify = (ts.isIdentifier(expression) && expression.text === 'promisify')
      || (ts.isPropertyAccessExpression(expression) && expression.name.text === 'promisify');
    if (promisify && args.length === 1) return runnerNamed(args[0]);
    const binds = ts.isPropertyAccessExpression(expression) && expression.name.text === 'bind' && args.length <= 1;
    return binds ? runnerNamed(expression.expression) : undefined;
  };
  for (let size = -1; size !== runnerNames.size;) {
    size = runnerNames.size;
    for (const [name, initializer] of constInitializers) {
      const kind = bindingCounts.get(name) === 1 && !runnerNames.has(name) ? aliasedRunner(initializer) : undefined;
      if (kind !== undefined) runnerNames.set(name, kind);
    }
  }
  const runnerOf = (node) => (ts.isCallExpression(node) || ts.isNewExpression(node) ? runnerNamed(node.expression) : undefined);
  // Whether a reference to a runner (`node`) only calls it, aliases it,
  // names it (a declaration, a property) or types it: anywhere else - an
  // argument, an object, a default - it escapes into code that may call it
  // with anything, so the run analysis reports it.
  const INSPECTORS = new Set(['expect', 'vi.mocked', 'jest.mocked']);
  const staysKnown = (reference) => {
    // Step out through type assertions and parentheses.
    let node = reference;
    while (node.parent && unwrap(node.parent) !== node.parent && unwrap(node.parent) === unwrap(node)) node = node.parent;
    const { parent } = node;
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return true;
    // A test's expect(spawn) or vi.mocked(spawn) inspects a mock and runs nothing.
    if (ts.isCallExpression(parent) && parent.arguments.length === 1 && parent.arguments[0] === node
      && INSPECTORS.has(parent.expression.getText(tree))) return true;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
    if ((ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)
      || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return true;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
    if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
    for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
      if (ts.isTypeNode(ancestor) || ts.isTypeQueryNode(ancestor)) return true;
      if (ts.isExpressionStatement(ancestor) || ts.isBlock(ancestor) || ts.isSourceFile(ancestor)) break;
    }
    // Aliases: const run = spawn, promisify(spawn), spawn.bind(null) - bound
    // to a const the analysis follows, or called on the spot.
    let alias = node;
    if (ts.isCallExpression(parent) && parent.arguments.includes(node)) alias = parent;
    else if (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === 'bind') alias = parent.parent;
    if (alias !== node && aliasedRunner(alias) === undefined) return false;
    while (alias.parent && unwrap(alias.parent) === unwrap(alias) && alias.parent !== alias) alias = alias.parent;
    const holder = alias.parent;
    if (alias !== node && (ts.isCallExpression(holder) || ts.isNewExpression(holder)) && holder.expression === alias) return true;
    return ts.isVariableDeclaration(holder) && holder.initializer === alias && ts.isIdentifier(holder.name) && runnerNames.has(holder.name.text);
  };
  // The program a spawn-like call runs, when process.execPath (node), a
  // literal or a path built from a known directory names it
  // (node_modules/.bin/tsx), through bindings.
  const programOf = (node, depth = 0) => {
    if (node === undefined || depth > 8) return undefined;
    if (node.getText(tree) === 'process.execPath') return 'node';
    if (isLiteral(node)) return path.posix.basename(node.text);
    if (ts.isIdentifier(node) && soleBase(node.text) === undefined) return programOf(soleInitializer(node.text), depth + 1);
    const [built] = runTargets(node);
    return built === undefined ? undefined : path.posix.basename(built);
  };
  // The values an expression may take: each branch of a ?:, ?? or ||, through
  // parentheses, file-URL conversions and bindings.
  const alternatives = (node, depth = 0) => {
    if (node === undefined || depth > 8) return [node];
    if (ts.isParenthesizedExpression(node)) return alternatives(node.expression, depth + 1);
    if (ts.isConditionalExpression(node)) return [...alternatives(node.whenTrue, depth + 1), ...alternatives(node.whenFalse, depth + 1)];
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
      return [...alternatives(node.left, depth + 1), ...alternatives(node.right, depth + 1)];
    }
    if (isCallOf(node, 'fileURLToPath') || isCallOf(node, 'pathToFileURL')) return alternatives(node.arguments[0], depth + 1);
    if (ts.isPropertyAccessExpression(node) && ['href', 'pathname'].includes(node.name.text)) return alternatives(node.expression, depth + 1);
    if (ts.isIdentifier(node) && soleBase(node.text) === undefined && soleInitializer(node.text) !== undefined) {
      return alternatives(soleInitializer(node.text), depth + 1);
    }
    return [node];
  };
  // The shell line a command-line runner runs: a literal, or a template whose
  // substitutions read as variables (`git clone "${url}"` runs git, and
  // `node ${script}` a file picked at run time), through bindings.
  const commandLine = (node, depth = 0) => {
    if (node === undefined || depth > 8) return undefined;
    if (isLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(({ literal }) => `$VALUE${literal.text}`).join('');
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return [node.left, node.right].map((part) => commandLine(part, depth + 1) ?? '$VALUE').join('');
    }
    return ts.isIdentifier(node) ? commandLine(soleInitializer(node.text), depth + 1) : undefined;
  };
  // What a runner call runs: the repository files it names (paths), or the
  // text of the operand no reading resolves (unresolved).
  const merged = (results) => ({ paths: results.flatMap(({ paths }) => paths), unresolved: [...new Set(results.flatMap(({ unresolved }) => unresolved))] });
  const runsOf = (kind, [first, second] = []) => {
    const none = { paths: [], unresolved: [] };
    // Every value the operand may take must name a repository file.
    const operand = (node) => {
      const found = alternatives(node).map((value) => runTargets(value).filter((target) => readTarget(target, false, context) !== undefined));
      return { paths: found.flat(), unresolved: found.every((paths) => paths.length) ? [] : [node.getText(tree)] };
    };
    if (first === undefined) return none;
    if (kind === 'command') {
      const line = commandLine(first);
      if (line === undefined) return { paths: [], unresolved: [first.getText(tree)] };
      const { runs, assembled } = analyzeShell(line, { exists: followable(context), context: NO_MANIFESTS });
      return { paths: runs, unresolved: assembled.length ? [first.getText(tree)] : [] };
    }
    if (kind === 'module') {
      const evaluates = second !== undefined && ts.isObjectLiteralExpression(second) && second.properties.some((property) => ts.isPropertyAssignment(property)
        && property.name.getText(tree) === 'eval' && property.initializer.kind === ts.SyntaxKind.TrueKeyword);
      return evaluates ? none : operand(first);
    }
    // Each value the program may take is a script runner (node, bash,
    // python), which runs the operand of each argument list it may get; a
    // repository file, which runs itself; or a tool its literal name names
    // (git, docker). One no reading identifies (a parameter, a property, the
    // environment) may be any of them, so it is reported.
    const lists = second === undefined ? [[]] : alternatives(second).map((value) => (ts.isArrayLiteralExpression(value) ? [...value.elements] : undefined));
    return merged(alternatives(first).map((value) => {
      const program = programOf(value);
      if (program !== undefined && scriptOperand(program, []) !== undefined) {
        return merged(lists.map((elements) => {
          if (elements === undefined) return { paths: [], unresolved: [second.getText(tree)] };
          const at = scriptOperand(program, elements.map((element) => (isLiteral(element) ? element.text : undefined)));
          return at < 0 ? none : operand(elements[at]);
        }));
      }
      const files = runTargets(value).filter((target) => readTarget(target, false, context) !== undefined);
      if (files.length) return { paths: files, unresolved: [] };
      return program === undefined ? { paths: [], unresolved: [first.getText(tree)] } : none;
    }));
  };
  const urlOfString = (node) => {
    let target = ts.isPropertyAccessExpression(node) && node.name.text === 'href' ? node.expression : node;
    if (ts.isCallExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'fileURLToPath') {
      [target] = target.arguments;
    }
    return target !== undefined && ts.isNewExpression(target) && ts.isIdentifier(target.expression)
      && target.expression.text === 'URL' && target.arguments?.length > 0 && ts.isStringLiteral(target.arguments[0]);
  };
  const analysis = { builtPaths: [], unresolvedReads: [], computedLoads: [], strings: [], assembledScriptPaths: [], runPaths: [], unresolvedRuns: [] };
  const visit = (node) => {
    const runner = runnerOf(node);
    if (runner !== undefined) {
      const { paths, unresolved } = runsOf(runner, node.arguments ?? []);
      analysis.runPaths.push(...paths);
      analysis.unresolvedRuns.push(...unresolved);
    }
    const reference = (ts.isIdentifier(node) && runnerNames.has(node.text))
      || (ts.isPropertyAccessExpression(node) && runnerNamed(node) !== undefined && !ts.isIdentifier(node.parent));
    if (reference && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && runnerNamed(node.parent) === undefined && node.parent.name.text !== 'bind')
      && !staysKnown(node)) {
      analysis.unresolvedRuns.push(node.parent.getText(tree).replace(/\s+/g, ' '));
    }
    if (isLiteral(node) || node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle
      || node.kind === ts.SyntaxKind.TemplateTail) {
      analysis.strings.push(node.text);
    }
    if (ts.isTemplateExpression(node)) {
      const beforeValues = [node.head.text, ...node.templateSpans.slice(0, -1).map(({ literal }) => literal.text)];
      if (beforeValues.some((text) => OPEN_SCRIPT_PATH.test(text))) analysis.assembledScriptPaths.push(node.getText(tree));
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
      && isLiteral(node.left) && !isLiteral(node.right) && OPEN_SCRIPT_PATH.test(node.left.text)) {
      analysis.assembledScriptPaths.push(node.getText(tree));
    } else if (ts.isCallExpression(node)) {
      const loads = node.arguments.length > 0 && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'));
      if (loads && !ts.isStringLiteral(node.arguments[0]) && !urlOfString(node.arguments[0])) {
        analysis.computedLoads.push(node.arguments[0].getText(tree));
      }
      if (pathHelper(node)) {
        const scriptsAt = node.arguments.findIndex((argument) => isLiteral(argument) && SCRIPTS_DIRECTORY.test(argument.text));
        const segments = scriptsAt >= 0 ? node.arguments.slice(scriptsAt + 1) : [];
        const script = scriptsPath(node);
        if (script !== undefined) analysis.strings.push(script);
        if (segments.some((segment) => !isLiteral(segment))) analysis.assembledScriptPaths.push(node.getText(tree));
        const built = builtPath(node);
        const last = node.arguments.at(-1);
        if (built !== undefined) analysis.builtPaths.push(built);
        else if (node.arguments.length > 1 && ts.isStringLiteral(last) && /^[\w.-]+\.\w+$/.test(last.text)) {
          const tail = [];
          for (const argument of [...node.arguments].reverse()) {
            if (!ts.isStringLiteral(argument)) break;
            tail.unshift(argument.text);
          }
          analysis.unresolvedReads.push(path.posix.join(...tail));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return analysis;
}

// Whether `candidate` names a file the guard can follow in `context`
// (readTarget).
const followable = (context) => (candidate) => readTarget(candidate, false, context) !== undefined;
// The repository scripts (under scripts/) that a string names, read like
// command text: a test's embedded shell or a script path in a message.
const namedScripts = (text, context) => commandFiles(text, { exists: followable(context) }).filter((file) => file.startsWith('scripts/'));

// What `file` (repo-relative, with `source` as its contents) loads by path:
// - `modules`: relative imports (side-effect `import './x.js'` included),
//   dynamic imports, `import(new URL(...))` and CommonJS require(), and the
//   one file a package subpath import loads through its exports map, whose
//   own imports load too;
// - `paths`: files it reads without importing or running: other `new URL(...)`
//   paths, require.resolve(), paths join/resolve builds from its own
//   directory (analyzeModule's builtPaths) and, in tests and test-runner
//   configs, quoted literals naming
//   an existing repo file (`'packages/agent/src/x.ts'`, as source-scanning
//   tests list them);
// - `runs`: the files it runs as a child process or worker (analyzeModule's
//   runPaths), whose own imports run too, unlike the files it only reads;
//   each reference is in one of `modules`, `paths` and `runs`;
// - `packages`: workspaces it imports by package name (packageImports);
// - `computed`: module loads computed at run time (computedLoads);
// - `assembled`: script paths assembled at run time (assembledScriptPaths)
//   and files it runs that no reading resolves (unresolvedRuns);
// - `unresolvedReads`: the literal paths it reads from a directory
//   analyzeModule cannot resolve (join(resolvePackageDir(dir), 'x.json')
//   reads 'x.json'), which the routing guard checks in what installs run.
// Type-only imports are erased before anything runs; other paths assembled
// at run time from variables are out of reach. `context` is the repository
// (checkoutContext by default).
export function loadReferences(file, source, context = checkoutContext()) {
  const code = source.replace(TYPE_ONLY_IMPORT, '');
  const walks = /\b(?:readdir|opendir)(?:Sync)?\(/.test(code);
  const relative = (specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  const specifiers = importSpecifiers(code);
  // A package subpath its exports map resolves loads that one file, not the
  // whole package.
  const subpaths = new Map(specifiers.map((specifier) => [specifier, subpathTarget(specifier, context)]).filter(([, target]) => target));
  const modules = [...new Set([
    ...specifiers.filter((specifier) => /^\.\.?\//.test(specifier)).map((specifier) => sourcePath(relative(specifier), context.isFile)),
    ...subpaths.values(),
  ])].filter((target) => !outsideSources(target));
  const { builtPaths, unresolvedReads, computedLoads, strings, assembledScriptPaths, runPaths, unresolvedRuns } = analyzeModule(file, code, context);
  const literals = (TEST_FILE.test(file) ? [...code.matchAll(REPO_PATH_LITERAL)] : [])
    .map(([, literal]) => literal)
    .filter((literal) => !/(?:^|\/)\.\.?(?:\/|$)/.test(literal));
  const paths = [
    ...[...code.matchAll(URL_PATH)].map(([, specifier]) => relative(specifier)),
    ...builtPaths,
    ...literals,
    ...(TEST_FILE.test(file) ? strings.flatMap((text) => namedScripts(text, context)) : []),
  ].map((target) => readTarget(target, walks, context)).filter(Boolean);
  const runs = [...new Set(runPaths.map((target) => readTarget(target, false, context)).filter(Boolean))]
    .filter((target) => !modules.includes(target) && target !== file);
  return {
    modules,
    paths: [...new Set(paths)].filter((target) => !modules.includes(target) && !runs.includes(target) && target !== file),
    runs,
    packages: packageNames(specifiers.filter((specifier) => !subpaths.has(specifier))),
    computed: computedLoads,
    assembled: [...assembledScriptPaths, ...unresolvedRuns],
    unresolvedReads,
  };
}

// What a shell script runs or sources, from the one shell reading
// (analyzeShell) the execution graph uses too: of the files it names, the
// repository scripts (by repo path, behind any directory variable:
// "$repo_root/scripts/devnet.sh") and the files beside it
// ("$SCRIPT_DIR/devnet-lib.sh", "$(dirname "$0")/x.sh", ./x.sh); of what the
// package scripts it runs reach (packageScriptEdges), the repository scripts
// and the files beside the shell scripts they run. A script path it or they
// build from a value ("$SCRIPT_DIR/${helper}.sh", scripts/$name) is
// `assembled`. Those a command runs (node scripts/x.mjs), whose own imports
// run too, are its `runs`, and the rest its `paths`. Package scripts, files and
// manifests all come from `context` (checkoutContext by default).
export function shellReferences(file, source, context = checkoutContext()) {
  const directory = path.posix.dirname(file);
  const { read, workspaces, rootManifest } = context;
  const exists = followable(context);
  const { calls, files, runs: executed, assembled } = analyzeShell(source, {
    scriptDirectory: directory,
    exists,
    context: { ...workspaces, rootManifest },
  });
  const reached = calls.length ? packageScriptEdges(calls, { readRepoFile: read, exists, workspaces, rootManifest }) : [];
  const beside = (target, scriptDirectory) => target.startsWith('scripts/') || path.posix.dirname(target) === scriptDirectory;
  const named = [
    ...files.filter(({ file: target }) => beside(target, directory)).map(({ file: target }) => target),
    ...reached.filter(({ kind, file: target, scriptDirectory }) => kind === 'file' && beside(target, scriptDirectory)).map(({ file: target }) => target),
  ];
  const run = new Set([...executed, ...reached.filter((edge) => edge.kind === 'file' && edge.run).map(({ file: target }) => target)]);
  const targets = (list) => [...new Set(list.map((target) => readTarget(target, false, context)).filter((target) => target && target !== file))];
  const runs = targets(named.filter((target) => run.has(target)));
  return {
    modules: [],
    paths: targets(named).filter((target) => !runs.includes(target)),
    runs,
    packages: [],
    computed: [],
    assembled: [...new Set([...assembled, ...reached.filter(({ kind }) => kind === 'assembled').map(({ text }) => text)])],
    unresolvedReads: [],
  };
}

// The formats the guard reads, by extension; an extensionless file is shell
// when its shebang runs a shell. Anything else (JSON, YAML, Python, TOML,
// documents, other extensionless files) names nothing the guard follows, so
// a path mentioned in it is not a dependency.
const FORMATS = [
  { format: 'module', matches: (file) => /\.[cm]?[jt]sx?$/.test(file), references: loadReferences },
  { format: 'shell', matches: isShellScript, references: shellReferences },
];
const NO_DEPENDENCIES = Object.freeze({ modules: [], paths: [], runs: [], packages: [], computed: [], assembled: [], unresolvedReads: [] });

// What `file` (repo-relative, `source` its contents) loads, reads or runs,
// from the handler for its format, with that format's name (undefined for
// a format the guard does not read), in `context` (checkoutContext by
// default).
export function dependenciesOf(file, source, context = checkoutContext()) {
  const handler = FORMATS.find(({ matches }) => matches(file, source));
  return handler ? { format: handler.format, ...handler.references(file, source, context) } : { format: undefined, ...NO_DEPENDENCIES };
}

// Everything the seeded files load, and which requirement (a lane, an
// `evm:<scope>`, or `full`) reaches each file through which file. `seeds`
// maps a file to a Map from requirement to where it comes from, the same
// shape as the result. Each file is read through dependenciesOf. A module
// load carries its importer's requirements on to what it imports, and so
// does a file it runs as a child process or worker (`runs`: a module under
// spawnSync(process.execPath, [file]), a script a shell command runs),
// except package workspace code the lanes seed (`workspaceSeeds`, from
// laneExecution), whose imports are traced from those seeds with its
// workspace's lanes: like a path it only reads, that code is required for
// the lane that runs it but not followed, so a test that starts the CLI does
// not hold everything the CLI may load to its lane. A path a file only reads
// is required, and followed only when it is a shell script (a module a lane
// only reads, as a source-scanning test does, runs none of its imports); a
// package-name import
// requires the imported workspace and its dependencies, recorded against the
// workspace's src/index.ts since any path in a workspace routes by its rule.
// `context` is the repository it reads: checkoutContext by default, an
// overlayContext or fixtureContext for a planted trace.
// Returns { loaded, unfollowed, unresolvedReads }: `unfollowed` maps each
// traced file to the module loads it computes and the script paths it
// assembles at run time, which the trace cannot follow; `unresolvedReads`
// maps it to the files it reads by name from a directory the trace cannot
// resolve.
export function traceLaneLoads(seeds, { context = checkoutContext(), workspaceSeeds = new Set(), ...unknown } = {}) {
  if (Object.keys(unknown).length) throw new Error(`traceLaneLoads takes a context, not ${Object.keys(unknown).join(', ')}`);
  const { workspaces } = context;
  const { workspaceByName } = workspaces;
  const closures = new Map();
  const closureOf = (workspace) => closures.get(workspace) ?? closures.set(workspace, workspaceClosure([workspace], workspaces)).get(workspace);
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
  const unfollowed = new Map();
  const unresolvedReads = new Map();
  const queue = [...loaded.keys()].map((file) => [file, loaded]);
  while (queue.length) {
    const [file, reachedBy] = queue.shift();
    const source = context.read(file);
    if (source === undefined) continue;
    const { format, modules, paths, runs, packages, computed, assembled, unresolvedReads: reads = [] } = dependenciesOf(file, source, context);
    if (reachedBy === readPaths && format !== 'shell') continue;
    const requirements = [...reachedBy.get(file).keys()];
    if (computed.length || assembled.length) unfollowed.set(file, [...computed, ...assembled]);
    if (reads.length) unresolvedReads.set(file, reads);
    for (const target of [...modules, ...runs.filter((target) => !workspaceSeeds.has(target))]) {
      if (add(loaded, target, requirements, file)) queue.push([target, loaded]);
    }
    for (const target of [...paths, ...runs.filter((target) => workspaceSeeds.has(target))]) {
      if (add(readPaths, target, requirements, file)) queue.push([target, readPaths]);
    }
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
  return { loaded, unfollowed, unresolvedReads };
}
