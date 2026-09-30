// The load graph behind the routing guard in ci-delta-routing.test.mjs: what
// a source file loads by path (loadReferences) and everything a set of seeded
// files loads, with the lane that reaches each file (traceLaneLoads). Its
// own tests pin the forms it follows and the ones it cannot see.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { analyzeShell, commandFiles, isShellScript, packageScriptEdges, readWorkspaces, workspaceClosure } from './ci-execution-graph.mjs';
import { REPO_ROOT } from './ci-plan-fixtures.mjs';

export { readWorkspaces, workspaceClosure };

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
const NO_ANALYSIS = Object.freeze({ computedLoads: [], strings: [], assembledScriptPaths: [] });

// One pass over a module's syntax tree for what TypeScript's import scanner
// does not report, with the join and resolve helpers read from its node:path
// imports (join, resolve and their aliases; path, posix and win32 bindings):
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
function analyzeModule(file, code) {
  if (!/\b(?:import|require)\s*\(|scripts/.test(code)) return NO_ANALYSIS;
  const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, scriptKind(file));
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
  const urlOfString = (node) => {
    let target = ts.isPropertyAccessExpression(node) && node.name.text === 'href' ? node.expression : node;
    if (ts.isCallExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'fileURLToPath') {
      [target] = target.arguments;
    }
    return target !== undefined && ts.isNewExpression(target) && ts.isIdentifier(target.expression)
      && target.expression.text === 'URL' && target.arguments?.length > 0 && ts.isStringLiteral(target.arguments[0]);
  };
  const analysis = { computedLoads: [], strings: [], assembledScriptPaths: [] };
  const visit = (node) => {
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
      const directory = pathHelper(node) ? node.arguments.findIndex((argument) => isLiteral(argument) && SCRIPTS_DIRECTORY.test(argument.text)) : -1;
      const segments = directory >= 0 ? node.arguments.slice(directory + 1) : [];
      if (segments.length && segments.every(isLiteral)) analysis.strings.push(['scripts', ...segments.map(({ text }) => text)].join('/'));
      if (segments.some((segment) => !isLiteral(segment))) analysis.assembledScriptPaths.push(node.getText(tree));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return analysis;
}

// Whether `candidate` names a file the guard can follow (readTarget).
const followable = (candidate) => readTarget(candidate, false) !== undefined;
// The repository scripts (under scripts/) that a string names, read like
// command text: a test's embedded shell or a script path in a message.
const namedScripts = (text) => commandFiles(text, { exists: followable }).filter((file) => file.startsWith('scripts/'));

// What `file` (repo-relative, with `source` as its contents) loads by path:
// - `modules`: relative imports (side-effect `import './x.js'` included),
//   dynamic imports, `import(new URL(...))` and CommonJS require(), whose own
//   imports load too;
// - `paths`: files it reads or runs without importing: other `new URL(...)`
//   paths, require.resolve(), paths built from its own directory (see
//   builtPaths) and, in tests and test-runner configs, quoted literals naming
//   an existing repo file (`'packages/agent/src/x.ts'`, as source-scanning
//   tests list them);
// - `packages`: workspaces it imports by package name (packageImports);
// - `computed`: module loads computed at run time (computedLoads);
// - `assembled`: script paths assembled at run time (assembledScriptPaths).
// Type-only imports are erased before anything runs; other paths assembled
// at run time from variables are out of reach.
export function loadReferences(file, source) {
  const code = source.replace(TYPE_ONLY_IMPORT, '');
  const walks = /\b(?:readdir|opendir)(?:Sync)?\(/.test(code);
  const relative = (specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  const specifiers = importSpecifiers(code);
  const modules = [...new Set(specifiers
    .filter((specifier) => /^\.\.?\//.test(specifier))
    .map((specifier) => sourcePath(relative(specifier))))]
    .filter((target) => !outsideSources(target));
  const { computedLoads, strings, assembledScriptPaths } = analyzeModule(file, code);
  const literals = (TEST_FILE.test(file) ? [...code.matchAll(REPO_PATH_LITERAL)] : [])
    .map(([, literal]) => literal)
    .filter((literal) => !/(?:^|\/)\.\.?(?:\/|$)/.test(literal));
  const paths = [
    ...[...code.matchAll(URL_PATH)].map(([, specifier]) => relative(specifier)),
    ...builtPaths(file, code),
    ...literals,
    ...(TEST_FILE.test(file) ? strings.flatMap(namedScripts) : []),
  ].map((target) => readTarget(target, walks)).filter(Boolean);
  return {
    modules,
    paths: [...new Set(paths)].filter((target) => !modules.includes(target) && target !== file),
    packages: packageNames(specifiers),
    computed: computedLoads,
    assembled: assembledScriptPaths,
  };
}

// The repository's manifests, as the shell analyzer reads package-manager
// calls against them; read once.
let repository;
const repositoryManifests = () => repository ??= {
  workspaces: readWorkspaces(),
  rootManifest: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')),
};

// What a shell script runs or sources, from the one shell reading
// (analyzeShell) the execution graph uses too: of the files it names, the
// repository scripts (by repo path, behind any directory variable:
// "$repo_root/scripts/devnet.sh") and the files beside it
// ("$SCRIPT_DIR/devnet-lib.sh", "$(dirname "$0")/x.sh", ./x.sh); of what the
// package scripts it runs reach (packageScriptEdges), the repository scripts
// and the files beside the shell scripts they run. A script path it or they
// build from a value ("$SCRIPT_DIR/${helper}.sh", scripts/$name) is
// `assembled`.
export function shellReferences(file, source) {
  const directory = path.posix.dirname(file);
  const { workspaces, rootManifest } = repositoryManifests();
  const { calls, files, assembled } = analyzeShell(source, {
    scriptDirectory: directory,
    exists: followable,
    context: { ...workspaces, rootManifest },
  });
  const reached = calls.length ? packageScriptEdges(calls, { exists: followable, workspaces, rootManifest }) : [];
  const beside = (target, scriptDirectory) => target.startsWith('scripts/') || path.posix.dirname(target) === scriptDirectory;
  const named = [
    ...files.filter(({ file: target }) => beside(target, directory)).map(({ file: target }) => target),
    ...reached.filter(({ kind, file: target, scriptDirectory }) => kind === 'file' && beside(target, scriptDirectory)).map(({ file: target }) => target),
  ];
  return {
    modules: [],
    paths: [...new Set(named.map((target) => readTarget(target, false)).filter((target) => target && target !== file))],
    packages: [],
    computed: [],
    assembled: [...new Set([...assembled, ...reached.filter(({ kind }) => kind === 'assembled').map(({ text }) => text)])],
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
const NO_DEPENDENCIES = Object.freeze({ modules: [], paths: [], packages: [], computed: [], assembled: [] });

// What `file` (repo-relative, `source` its contents) loads, reads or runs,
// from the handler for its format, with that format's name (undefined for
// a format the guard does not read).
export function dependenciesOf(file, source) {
  const handler = FORMATS.find(({ matches }) => matches(file, source));
  return handler ? { format: handler.format, ...handler.references(file, source) } : { format: undefined, ...NO_DEPENDENCIES };
}

// Everything the seeded files load, and which requirement (a lane, an
// `evm:<scope>`, or `full`) reaches each file through which file. `seeds`
// maps a file to a Map from requirement to where it comes from, the same
// shape as the result. Each file is read through dependenciesOf. A module
// load carries its importer's requirements on to what it imports; a path read
// or run is required, and followed only when it is a shell script (a lane
// that names a module by path may only read it); a package-name import
// requires the imported workspace and its dependencies, recorded against the
// workspace's src/index.ts since any path in a workspace routes by its rule.
// `read(file)` returns a file's source, or undefined when it has none.
// Returns { loaded, unfollowed }: `unfollowed` maps each traced file to the
// module loads it computes and the script paths it assembles at run time,
// which the trace cannot follow.
export function traceLaneLoads(seeds, { read = readRepoFile } = {}) {
  const workspaces = readWorkspaces();
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
  const queue = [...loaded.keys()].map((file) => [file, loaded]);
  while (queue.length) {
    const [file, reachedBy] = queue.shift();
    const source = read(file);
    if (source === undefined) continue;
    const { format, modules, paths, packages, computed, assembled } = dependenciesOf(file, source);
    if (reachedBy === readPaths && format !== 'shell') continue;
    const requirements = [...reachedBy.get(file).keys()];
    if (computed.length || assembled.length) unfollowed.set(file, [...computed, ...assembled]);
    for (const target of modules) {
      if (add(loaded, target, requirements, file)) queue.push([target, loaded]);
    }
    for (const target of paths) {
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
  return { loaded, unfollowed };
}
