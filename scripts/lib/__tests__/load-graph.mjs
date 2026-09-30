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
// (repositoryContext).
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
// are what pnpm installs and runs. Each part left out is the checkout's: a
// fixture passes every part and reads nothing else, and passing only `read`
// replaces some sources in the checkout, as the planted routing tests do.
// Every reading below takes one; the checkout's is built once.
export function repositoryContext(parts = {}) {
  const part = (name) => parts[name] ?? checkoutContext()[name];
  return Object.freeze({
    read: part('read'),
    isFile: part('isFile'),
    isDirectory: part('isDirectory'),
    workspaces: part('workspaces'),
    rootManifest: part('rootManifest'),
  });
}
let checkout;
const checkoutContext = () => checkout ??= {
  read: readRepoFile,
  isFile: isRepoFile,
  isDirectory: isRepoDirectory,
  workspaces: workspaceCatalog(),
  rootManifest: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')),
};

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
// `context` is the repository it is in (repositoryContext).
function analyzeModule(file, code, context) {
  if (!/\b(?:import|require)\s*\(|scripts|\b(?:join|resolve)\s*\(|__dirname|import\.meta|child_process|worker_threads|execa/.test(code)) return NO_ANALYSIS;
  const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, scriptKind(file));
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
  // The path a join/resolve call builds from a known directory and literals.
  const builtPath = (node) => {
    if (!ts.isCallExpression(node) || !pathHelper(node) || node.arguments.length < 2) return undefined;
    const [base, ...segments] = node.arguments;
    const start = baseOf(base);
    if (start === undefined || !segments.every((segment) => ts.isStringLiteral(segment))) return undefined;
    return path.posix.normalize(path.posix.join(start, ...segments.map(({ text }) => text)));
  };
  // The directory an expression holds: the module's own, a file URL made
  // from a literal, or a built path.
  const heldDirectory = (node) => {
    if (node.getText(tree) === 'import.meta.dirname') return directory;
    if (isCallOf(node, 'dirname') && isCallOf(node.arguments[0], 'fileURLToPath') && isMetaUrl(node.arguments[0].arguments[0])) return directory;
    if (isCallOf(node, 'fileURLToPath')) {
      const [url] = node.arguments;
      if (ts.isNewExpression(url) && url.expression.getText(tree) === 'URL' && url.arguments?.length === 2
        && ts.isStringLiteral(url.arguments[0]) && isMetaUrl(url.arguments[1])) {
        return path.posix.normalize(path.posix.join(directory, url.arguments[0].text));
      }
    }
    return builtPath(node);
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
  const bindings = [];
  const collect = (node) => {
    if (ts.isVariableDeclarationList(node) && (node.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) {
      bindings.push(...node.declarations.filter((declaration) => ts.isIdentifier(declaration.name) && declaration.initializer));
    }
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
  const initializers = new Map(bindings.map(({ name, initializer }) => [name.text, initializer]));
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
    if (isLiteral(node)) return /^[\w@.+~/-]+$/.test(node.text) ? [node.text] : [];
    if (ts.isIdentifier(node)) return bases.has(node.text) ? [bases.get(node.text)] : runTargets(initializers.get(node.text), depth + 1);
    const built = builtPath(node) ?? scriptsPath(node);
    return built === undefined ? [] : [built];
  };
  // How a call runs a file (RUNNER_MODULES), when its callee is an imported
  // runner or a runner module's member.
  const runnerOf = (node) => {
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return undefined;
    const callee = node.expression;
    if (ts.isIdentifier(callee)) return runnerNames.get(callee.text);
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const kinds = ts.isIdentifier(callee.expression) ? runnerModules.get(callee.expression.text) : requiredModule(callee.expression);
    return kinds?.[callee.name.text];
  };
  // The program a spawn-like call runs, when a literal or process.execPath
  // (node) names it, through bindings; and its argument list's elements.
  const programOf = (node, depth = 0) => {
    if (node === undefined || depth > 8) return undefined;
    if (node.getText(tree) === 'process.execPath') return 'node';
    if (isLiteral(node)) return path.posix.basename(node.text);
    return ts.isIdentifier(node) ? programOf(initializers.get(node.text), depth + 1) : undefined;
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
    if (ts.isIdentifier(node) && !bases.has(node.text) && initializers.has(node.text)) return alternatives(initializers.get(node.text), depth + 1);
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
    return ts.isIdentifier(node) ? commandLine(initializers.get(node.text), depth + 1) : undefined;
  };
  // What a runner call runs: the repository files it names (paths), or the
  // text of the operand no reading resolves (unresolved).
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
    // A script runner runs the operand of each argument list it may get.
    const program = programOf(first);
    if (scriptOperand(program, []) === undefined) return { paths: runTargets(first), unresolved: [] };
    const lists = second === undefined ? [[]] : alternatives(second).map((value) => (ts.isArrayLiteralExpression(value) ? [...value.elements] : undefined));
    const runs = lists.map((elements) => {
      if (elements === undefined) return { paths: [], unresolved: [second.getText(tree)] };
      const at = scriptOperand(program, elements.map((element) => (isLiteral(element) ? element.text : undefined)));
      return at < 0 ? none : operand(elements[at]);
    });
    return { paths: runs.flatMap(({ paths }) => paths), unresolved: [...new Set(runs.flatMap(({ unresolved }) => unresolved))] };
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
//   dynamic imports, `import(new URL(...))` and CommonJS require(), whose own
//   imports load too;
// - `paths`: files it reads or runs without importing: other `new URL(...)`
//   paths, require.resolve(), paths join/resolve builds from its own
//   directory (analyzeModule's builtPaths) and, in tests and test-runner
//   configs, quoted literals naming
//   an existing repo file (`'packages/agent/src/x.ts'`, as source-scanning
//   tests list them);
// - `runs`: the files it runs as a child process or worker (analyzeModule's
//   runPaths), whose own imports run too, unlike a file it only reads;
// - `packages`: workspaces it imports by package name (packageImports);
// - `computed`: module loads computed at run time (computedLoads);
// - `assembled`: script paths assembled at run time (assembledScriptPaths)
//   and files it runs that no reading resolves (unresolvedRuns);
// - `unresolvedReads`: the literal paths it reads from a directory
//   analyzeModule cannot resolve (join(resolvePackageDir(dir), 'x.json')
//   reads 'x.json'), which the routing guard checks in what installs run.
// Type-only imports are erased before anything runs; other paths assembled
// at run time from variables are out of reach. `context` is the repository
// (repositoryContext; the checkout by default).
export function loadReferences(file, source, context = repositoryContext()) {
  const code = source.replace(TYPE_ONLY_IMPORT, '');
  const walks = /\b(?:readdir|opendir)(?:Sync)?\(/.test(code);
  const relative = (specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  const specifiers = importSpecifiers(code);
  const modules = [...new Set(specifiers
    .filter((specifier) => /^\.\.?\//.test(specifier))
    .map((specifier) => sourcePath(relative(specifier), context.isFile)))]
    .filter((target) => !outsideSources(target));
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
    paths: [...new Set([...paths, ...runs])].filter((target) => !modules.includes(target) && target !== file),
    runs,
    packages: packageNames(specifiers),
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
// `assembled`. Of those files, `runs` are the ones a command runs
// (node scripts/x.mjs), whose own imports run too. Package scripts, files and
// manifests all come from `context` (repositoryContext; the checkout by
// default).
export function shellReferences(file, source, context = repositoryContext()) {
  const directory = path.posix.dirname(file);
  const { read, workspaces, rootManifest } = context;
  const exists = followable(context);
  const { calls, files, runs, assembled } = analyzeShell(source, {
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
  const run = new Set([...runs, ...reached.filter((edge) => edge.kind === 'file' && edge.run).map(({ file: target }) => target)]);
  const targets = (list) => [...new Set(list.map((target) => readTarget(target, false, context)).filter((target) => target && target !== file))];
  return {
    modules: [],
    paths: targets(named),
    runs: targets(named.filter((target) => run.has(target))),
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
// a format the guard does not read), in `context` (repositoryContext; the
// checkout by default).
export function dependenciesOf(file, source, context = repositoryContext()) {
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
// `context` is the repository it reads (repositoryContext; by default the
// checkout, with `read(file)`, when given, supplying the sources).
// Returns { loaded, unfollowed, unresolvedReads }: `unfollowed` maps each
// traced file to the module loads it computes and the script paths it
// assembles at run time, which the trace cannot follow; `unresolvedReads`
// maps it to the files it reads by name from a directory the trace cannot
// resolve.
export function traceLaneLoads(seeds, { read, context = repositoryContext(read ? { read } : {}), workspaceSeeds = new Set() } = {}) {
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
    const followed = runs.filter((target) => !workspaceSeeds.has(target));
    for (const target of [...modules, ...followed]) {
      if (add(loaded, target, requirements, file)) queue.push([target, loaded]);
    }
    for (const target of paths.filter((target) => !followed.includes(target))) {
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
