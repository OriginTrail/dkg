#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  analyzeSparqlOperation,
  recognizedReadOnlySparqlForm,
} from '../packages/core/src/sparql-operation.ts';
import ts from 'typescript';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE_PACKAGE_NAME = '@origintrail-official/dkg-storage';
const REVIEWED_NON_STORE_MARKER = 'dkg-raw-channel-non-store';
// Reviewed dynamic read call sites are sealed per package. A new package, call,
// or changed query expression fails the gate and prints the exact inventory
// that needs review before this baseline may be deliberately advanced.
const DYNAMIC_QUERY_BASELINE = Object.freeze({
  agent: Object.freeze({
    count: 149,
    sha256: '7f0c5415793ae19d2547ea18e651537716a93a165e69321bc82d050c8903939e',
  }),
  cli: Object.freeze({
    count: 16,
    sha256: '53295425b84f6e3e8c31e46be5bd4c02bb0635e573eec7e68ade2cbdf44f9b46',
  }),
  publisher: Object.freeze({
    count: 110,
    sha256: '76eb399cb8d4b0abbb9916cd5f86eead37044bc1dc78cbd1858f885218fd6207',
  }),
  query: Object.freeze({
    count: 3,
    sha256: 'b42b47da1be2ee11825f4aff29ad57341c862558f9a048a85708237514bd3d2f',
  }),
  'random-sampling': Object.freeze({
    count: 9,
    sha256: 'f17b2ab6570a946515879aeee70555702f506f68f2579bb1c188ca40ac9f0439',
  }),
});
const TRIPLE_STORE_DECLARATION = /\/packages\/storage\/(?:src\/triple-store\.ts|dist\/triple-store\.d\.ts)$/u;

function normalized(path) {
  return resolve(path).split(sep).join('/');
}

function workspaceStorageConsumers() {
  const packagesRoot = resolve(REPOSITORY_ROOT, 'packages');
  const consumers = [];
  for (const name of readdirSync(packagesRoot).sort()) {
    const packageJsonPath = resolve(packagesRoot, name, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };
    if (!(STORAGE_PACKAGE_NAME in dependencies)) continue;
    const configPath = `packages/${name}/tsconfig.json`;
    consumers.push([name, configPath]);
  }
  if (consumers.length === 0) {
    throw new Error('no workspace package depending on dkg-storage was discovered');
  }
  return consumers;
}

function loadProgram(configPath) {
  const absoluteConfig = resolve(REPOSITORY_ROOT, configPath);
  const loaded = ts.readConfigFile(absoluteConfig, ts.sys.readFile);
  if (loaded.error) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(absoluteConfig),
    { noEmit: true },
    absoluteConfig,
  );
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
      .join('\n'));
  }
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
}

function findTripleStoreType(program, checker) {
  for (const sourceFile of program.getSourceFiles()) {
    if (!TRIPLE_STORE_DECLARATION.test(normalized(sourceFile.fileName))) continue;
    for (const statement of sourceFile.statements) {
      if (ts.isInterfaceDeclaration(statement) && statement.name.text === 'TripleStore') {
        return checker.getTypeAtLocation(statement.name);
      }
    }
  }
  throw new Error('TripleStore declaration was not resolved; build workspace packages first');
}

function methodAccess(expression) {
  if (ts.isPropertyAccessExpression(expression)) {
    return { receiver: expression.expression, method: expression.name.text };
  }
  if (
    ts.isElementAccessExpression(expression)
    && expression.argumentExpression
    && ts.isStringLiteral(expression.argumentExpression)
  ) {
    return { receiver: expression.expression, method: expression.argumentExpression.text };
  }
  return null;
}

function staticSparql(expression, checker, seen = new Set()) {
  if (!expression || seen.has(expression)) return null;
  const path = new Set(seen);
  path.add(expression);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isSatisfiesExpression(expression)
  ) {
    return staticSparql(expression.expression, checker, path);
  }
  if (
    ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticSparql(expression.left, checker, path);
    const right = staticSparql(expression.right, checker, path);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const substitution = staticSparql(span.expression, checker, path);
      if (substitution === null) return null;
      value += substitution + span.literal.text;
    }
    return value;
  }
  if (ts.isIdentifier(expression)) {
    const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
    if (
      declaration
      && ts.isVariableDeclaration(declaration)
      && declaration.initializer
      && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      return staticSparql(declaration.initializer, checker, path);
    }
  }
  return null;
}

function isTripleStoreReceiver(checker, receiver, tripleStoreType) {
  return isTripleStoreReceiverThroughAliases(checker, receiver, tripleStoreType, new Set());
}

function isTripleStoreReceiverThroughAliases(checker, receiver, tripleStoreType, seen) {
  if (!receiver || seen.has(receiver)) return false;
  seen.add(receiver);
  const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) {
    if (checker.isTypeAssignableTo(type, tripleStoreType)) return true;
  }
  if (
    ts.isParenthesizedExpression(receiver)
    || ts.isAsExpression(receiver)
    || ts.isTypeAssertionExpression(receiver)
    || ts.isSatisfiesExpression(receiver)
    || ts.isNonNullExpression(receiver)
  ) {
    return isTripleStoreReceiverThroughAliases(
      checker,
      receiver.expression,
      tripleStoreType,
      seen,
    );
  }
  if (ts.isIdentifier(receiver)) {
    const declaration = checker.getSymbolAtLocation(receiver)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return isTripleStoreReceiverThroughAliases(
        checker,
        declaration.initializer,
        tripleStoreType,
        seen,
      );
    }
  }
  return false;
}

function isUntypedReceiver(checker, receiver) {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

function resolveRawStoreCall(expression, checker, seen = new Set()) {
  if (!expression || seen.has(expression)) return null;
  seen.add(expression);
  const direct = methodAccess(expression);
  if (direct) return direct;
  if (!ts.isIdentifier(expression)) return null;
  const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
  if (!declaration) return null;
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    return resolveRawStoreCall(declaration.initializer, checker, seen);
  }
  if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
    const variable = declaration.parent.parent;
    if (!ts.isVariableDeclaration(variable) || !variable.initializer) return null;
    const property = declaration.propertyName ?? declaration.name;
    const method = ts.isIdentifier(property) || ts.isStringLiteral(property)
      ? property.text
      : null;
    return method === null ? null : { receiver: variable.initializer, method };
  }
  return null;
}

function hasReviewedNonStoreMarker(sourceFile, node) {
  const start = node.getStart(sourceFile);
  return sourceFile.text.slice(Math.max(0, start - 240), start)
    .includes(REVIEWED_NON_STORE_MARKER);
}

function selfTestStaticSparql() {
  const fileName = '/managed-store-raw-channel-fixture.ts';
  const sourceFile = ts.createSourceFile(fileName, `
    const graph = 'urn:test:g';
    const variableBacked = 'DELETE WHERE { ?s <urn:p> ?o }';
    inspect(variableBacked);
    inspect(\`DELETE WHERE { GRAPH <\${graph}> { ?s <urn:p> ?o } }\`);
    inspect('SELECT ?s WHERE { ?s <urn:p> ?o }' + '; DROP ALL');
  `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const options = { target: ts.ScriptTarget.ES2022, noLib: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (candidate) => candidate === fileName ? sourceFile : undefined;
  host.fileExists = (candidate) => candidate === fileName;
  host.readFile = (candidate) => candidate === fileName ? sourceFile.text : undefined;
  const program = ts.createProgram({ rootNames: [fileName], options, host });
  const checker = program.getTypeChecker();
  const resolved = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'inspect'
    ) {
      resolved.push(staticSparql(node.arguments[0], checker));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const expected = [
    'DELETE WHERE { ?s <urn:p> ?o }',
    'DELETE WHERE { GRAPH <urn:test:g> { ?s <urn:p> ?o } }',
    'SELECT ?s WHERE { ?s <urn:p> ?o }; DROP ALL',
  ];
  if (JSON.stringify(resolved) !== JSON.stringify(expected)) {
    throw new Error(`static SPARQL resolver self-test failed: ${JSON.stringify(resolved)}`);
  }
}

function selfTestRawStoreAliasResolution() {
  const fileName = '/managed-store-raw-channel-alias-fixture.ts';
  const sourceFile = ts.createSourceFile(fileName, `
    interface TripleStore {
      update(sparql: string): Promise<void>;
      query(sparql: string): Promise<unknown>;
    }
    declare const store: TripleStore;
    const raw: any = store;
    raw.update('INSERT DATA { <urn:s> <urn:p> "o" }');
    const alias = raw;
    alias.query('DELETE WHERE { ?s ?p ?o }');
    const updateAlias = store.update;
    updateAlias('DROP ALL');
    const { query } = store;
    query('CLEAR ALL');
    declare const detached: any;
    detached.update('INSERT DATA { <urn:s> <urn:p> "o" }');
  `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const options = { target: ts.ScriptTarget.ES2022, noLib: true, strict: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (candidate) => candidate === fileName ? sourceFile : undefined;
  host.fileExists = (candidate) => candidate === fileName;
  host.readFile = (candidate) => candidate === fileName ? sourceFile.text : undefined;
  const program = ts.createProgram({ rootNames: [fileName], options, host });
  const checker = program.getTypeChecker();
  const declaration = sourceFile.statements.find((statement) => (
    ts.isInterfaceDeclaration(statement) && statement.name.text === 'TripleStore'
  ));
  if (!declaration || !ts.isInterfaceDeclaration(declaration)) {
    throw new Error('raw-store alias self-test could not find TripleStore');
  }
  const tripleStoreType = checker.getTypeAtLocation(declaration.name);
  const anchored = [];
  const detached = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const access = resolveRawStoreCall(node.expression, checker);
      if (access && (access.method === 'update' || access.method === 'query')) {
        if (isTripleStoreReceiver(checker, access.receiver, tripleStoreType)) {
          anchored.push(access.method);
        } else if (isUntypedReceiver(checker, access.receiver)) {
          detached.push(access.method);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (anchored.join(',') !== 'update,query,update,query' || detached.join(',') !== 'update') {
    throw new Error(
      `raw-store alias self-test failed: anchored=${anchored.join(',')} detached=${detached.join(',')}`,
    );
  }
}

function scanPackage(name, configPath) {
  const program = loadProgram(configPath);
  const checker = program.getTypeChecker();
  const tripleStoreType = findTripleStoreType(program, checker);
  const sourceRoot = normalized(resolve(REPOSITORY_ROOT, `packages/${name}/src`));
  const violations = [];
  let recognizedCalls = 0;
  let staticallyAnalyzedQueries = 0;
  let dynamicQueries = 0;
  const dynamicQueryFingerprints = [];
  let scannedFiles = 0;

  for (const sourceFile of program.getSourceFiles()) {
    const fileName = normalized(sourceFile.fileName);
    if (!fileName.startsWith(`${sourceRoot}/`) || sourceFile.isDeclarationFile) continue;
    scannedFiles += 1;
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const access = resolveRawStoreCall(node.expression, checker);
        if (
          access
          && (access.method === 'update' || access.method === 'query')
        ) {
          const typedTripleStore = isTripleStoreReceiver(
            checker,
            access.receiver,
            tripleStoreType,
          );
          const untypedCandidate = !typedTripleStore
            && isUntypedReceiver(checker, access.receiver);
          if (!typedTripleStore && !untypedCandidate) {
            ts.forEachChild(node, visit);
            return;
          }
          if (untypedCandidate && hasReviewedNonStoreMarker(sourceFile, node)) {
            ts.forEachChild(node, visit);
            return;
          }
          recognizedCalls += 1;
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          const location = `${fileName.slice(REPOSITORY_ROOT.length + 1)}:${line}`;
          if (access.method === 'update') {
            violations.push(`${location}: ${untypedCandidate ? 'untyped raw-channel candidate' : 'raw TripleStore'}.update()`);
          } else {
            const sparql = staticSparql(node.arguments[0], checker);
            if (sparql !== null) {
              staticallyAnalyzedQueries += 1;
              const analysis = analyzeSparqlOperation(sparql);
              if (recognizedReadOnlySparqlForm(analysis) === null) {
                violations.push(
                  `${location}: non-read static ${untypedCandidate ? 'untyped raw-channel candidate' : 'TripleStore'}.query()`,
                );
              }
            } else if (untypedCandidate) {
              violations.push(`${location}: dynamic untyped raw-channel candidate.query()`);
            } else {
              dynamicQueries += 1;
              const argument = node.arguments[0];
              const argumentText = argument?.getText(sourceFile).replace(/\s+/gu, ' ').trim()
                ?? '<missing>';
              const sourcePath = fileName.slice(REPOSITORY_ROOT.length + 1);
              dynamicQueryFingerprints.push(`${sourcePath} ${argumentText}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  if (recognizedCalls === 0) {
    violations.push(`${name}: no typed TripleStore calls were recognized; architecture gate is inert`);
  }
  return {
    name,
    recognizedCalls,
    staticallyAnalyzedQueries,
    dynamicQueries,
    dynamicQueryFingerprints,
    scannedFiles,
    violations,
  };
}

selfTestStaticSparql();
selfTestRawStoreAliasResolution();
const packageConfigs = workspaceStorageConsumers();
const results = packageConfigs.map(([name, config]) => scanPackage(name, config));
const violations = results.flatMap((result) => result.violations);
let dynamicQueryCount = 0;
for (const result of results) {
  const fingerprints = [...result.dynamicQueryFingerprints].sort();
  const observed = {
    count: fingerprints.length,
    sha256: createHash('sha256').update(fingerprints.join('\n')).digest('hex'),
  };
  dynamicQueryCount += observed.count;
  const expected = DYNAMIC_QUERY_BASELINE[result.name];
  if (
    expected?.count !== observed.count
    || expected?.sha256 !== observed.sha256
  ) {
    violations.push(
      `${result.name}: dynamic TripleStore.query() baseline changed: `
      + `expected ${expected?.count ?? 0}/${expected?.sha256 ?? '<unset>'}, `
      + `received ${observed.count}/${observed.sha256}`,
    );
    for (const fingerprint of fingerprints) {
      violations.push(`dynamic query review required: ${fingerprint}`);
    }
  }
}
for (const name of Object.keys(DYNAMIC_QUERY_BASELINE)) {
  if (!results.some((result) => result.name === name)) {
    violations.push(`${name}: dynamic query baseline names a package outside the derived scope`);
  }
}
for (const result of results) {
  console.log(
    `[managed-store-raw-channels] ${result.name}: ` +
    `${result.scannedFiles} files, ${result.recognizedCalls} typed call(s), ` +
    `${result.staticallyAnalyzedQueries} static query program(s), ` +
    `${result.dynamicQueries} baseline-reviewed dynamic query call(s)`,
  );
}
if (violations.length > 0) {
  console.error('[managed-store-raw-channels] FAILED');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    '[managed-store-raw-channels] PASS: no first-party raw update() or statically mutating '
    + 'query() calls; '
    + `${dynamicQueryCount} dynamic query call site(s) match the reviewed per-package baseline `
    + '(runtime ownership guard remains authoritative)',
  );
}
