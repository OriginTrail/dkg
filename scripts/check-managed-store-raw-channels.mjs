#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  analyzeSparqlOperation,
  recognizedReadOnlySparqlForm,
} from '../packages/core/src/sparql-operation.ts';
import ts from 'typescript';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE_PACKAGE_NAME = '@origintrail-official/dkg-storage';
const DYNAMIC_QUERY_INVENTORY_PATH = resolve(
  REPOSITORY_ROOT,
  'scripts/managed-store-dynamic-query-inventory.json',
);
const WRITE_INVENTORY = process.argv.includes('--write-inventory');
const DYNAMIC_QUERY_REASON = 'Typed dynamic query; runtime store admission enforces read-only form.';
const REVIEWED_NON_STORE_CALLS = Object.freeze([
  Object.freeze({
    package: 'agent',
    path: 'packages/agent/src/generic-sql-source.ts',
    symbol: 'query',
    method: 'query',
    receiver: 'request',
    expression: 'sql',
    reason: 'Optional mssql Request.query API; not an RDF TripleStore channel.',
  }),
]);
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

function declarationName(node) {
  const name = node?.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function reviewedNonStoreCallKey(record) {
  return [
    record.package,
    record.path,
    record.symbol,
    record.method,
    record.receiver,
    record.expression,
  ].join('\0');
}

const REVIEWED_NON_STORE_CALLS_BY_KEY = new Map(
  REVIEWED_NON_STORE_CALLS.map((record) => [reviewedNonStoreCallKey(record), record]),
);

function untypedRawCallRecord(packageName, sourcePath, sourceFile, node, access) {
  const normalizedText = (value) => value?.getText(sourceFile).replace(/\s+/gu, ' ').trim()
    ?? '<missing>';
  return Object.freeze({
    package: packageName,
    path: sourcePath,
    symbol: enclosingSymbol(node),
    method: access.method,
    receiver: normalizedText(access.receiver),
    expression: normalizedText(node.arguments[0]),
  });
}

function enclosingSymbol(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isMethodDeclaration(current)
      || ts.isFunctionDeclaration(current)
      || ts.isGetAccessorDeclaration(current)
      || ts.isSetAccessorDeclaration(current)
    ) {
      const member = declarationName(current) ?? '<anonymous>';
      const owner = current.parent && ts.isClassDeclaration(current.parent)
        ? declarationName(current.parent)
        : null;
      return owner ? `${owner}.${member}` : member;
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
      && ts.isVariableDeclaration(current.parent)
    ) {
      return declarationName(current.parent) ?? '<anonymous>';
    }
  }
  return '<module>';
}

function reviewedDynamicQueryInventory(records) {
  const occurrences = new Map();
  const expressionsByRecord = new Map();
  const inventory = [...records]
    .sort((left, right) => (
      left.path.localeCompare(right.path)
      || left.symbol.localeCompare(right.symbol)
      || left.expressionSha256.localeCompare(right.expressionSha256)
      || left.line - right.line
    ))
    .map(({ line: _line, expression, ...record }) => {
      const identity = `${record.package}\0${record.path}\0${record.symbol}\0${record.expressionSha256}`;
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      const compact = Object.freeze({ ...record, occurrence });
      expressionsByRecord.set(JSON.stringify(compact), expression);
      return compact;
    });
  return { inventory, expressionsByRecord };
}

function diffDynamicQueryInventory(expected, observed) {
  const counts = (records) => {
    const result = new Map();
    for (const record of records) {
      const key = JSON.stringify(record);
      result.set(key, (result.get(key) ?? 0) + 1);
    }
    return result;
  };
  const expectedCounts = counts(expected);
  const observedCounts = counts(observed);
  const missing = [];
  const added = [];
  for (const [key, count] of expectedCounts) {
    for (let index = observedCounts.get(key) ?? 0; index < count; index++) {
      missing.push(JSON.parse(key));
    }
  }
  for (const [key, count] of observedCounts) {
    for (let index = expectedCounts.get(key) ?? 0; index < count; index++) {
      added.push(JSON.parse(key));
    }
  }
  return { missing, added };
}

function dynamicQueryInventoryLabel(record, expression) {
  return `${record.package}:${record.path}#${record.symbol}[${record.occurrence}] `
    + `${record.expressionSha256} - ${DYNAMIC_QUERY_REASON}`
    + (expression === undefined ? '' : ` - ${expression}`);
}

function loadDynamicQueryInventory() {
  const parsed = JSON.parse(readFileSync(DYNAMIC_QUERY_INVENTORY_PATH, 'utf8'));
  if (parsed?.version !== 1 || !Array.isArray(parsed.records)) {
    throw new Error('dynamic query inventory must contain version 1 records');
  }
  return parsed.records;
}

function serializeDynamicQueryInventory(records) {
  const lines = records.map((record) => `    ${JSON.stringify(record)}`);
  return `{\n  "version": 1,\n  "records": [\n${lines.join(',\n')}\n  ]\n}\n`;
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

function selfTestReviewedNonStoreCalls() {
  const reviewed = {
    package: 'agent',
    path: 'packages/agent/src/example.ts',
    symbol: 'readSql',
    method: 'query',
    receiver: 'request',
    expression: 'sql',
  };
  const allowlist = new Map([[reviewedNonStoreCallKey(reviewed), reviewed]]);
  if (!allowlist.has(reviewedNonStoreCallKey(reviewed))) {
    throw new Error('reviewed non-store self-test rejected an exact non-store call');
  }
  const untypedStoreAlias = { ...reviewed, receiver: 'rawStore' };
  if (allowlist.has(reviewedNonStoreCallKey(untypedStoreAlias))) {
    throw new Error('reviewed non-store self-test admitted an untyped store alias');
  }
}

function selfTestDynamicQueryInventoryDiff() {
  const base = Object.freeze({
    package: 'agent',
    path: 'packages/agent/src/example.ts',
    symbol: 'Example.read',
    expressionSha256: 'hash-a',
    occurrence: 1,
  });
  const changed = { ...base, expressionSha256: 'hash-b' };
  const moved = { ...base, path: 'packages/agent/src/moved.ts' };
  const unchanged = diffDynamicQueryInventory([base], [base]);
  if (unchanged.missing.length !== 0 || unchanged.added.length !== 0) {
    throw new Error('dynamic query inventory self-test rejected an unchanged record');
  }
  for (const candidate of [changed, moved]) {
    const diff = diffDynamicQueryInventory([base], [candidate]);
    if (diff.missing.length !== 1 || diff.added.length !== 1) {
      throw new Error('dynamic query inventory self-test missed a move/expression change');
    }
  }
  const added = diffDynamicQueryInventory([base], [base, { ...base, occurrence: 2 }]);
  const removed = diffDynamicQueryInventory([base, { ...base, occurrence: 2 }], [base]);
  if (added.added.length !== 1 || removed.missing.length !== 1) {
    throw new Error('dynamic query inventory self-test missed an addition/removal');
  }
  const label = dynamicQueryInventoryLabel(base, 'sparql');
  if (!label.includes(DYNAMIC_QUERY_REASON) || !label.endsWith(' - sparql')) {
    throw new Error('dynamic query inventory self-test lost review diagnostics');
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
  const dynamicQueryRecords = [];
  const reviewedNonStoreCalls = new Set();
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
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          const sourcePath = fileName.slice(REPOSITORY_ROOT.length + 1);
          const location = `${sourcePath}:${line}`;
          if (untypedCandidate) {
            const record = untypedRawCallRecord(name, sourcePath, sourceFile, node, access);
            const key = reviewedNonStoreCallKey(record);
            if (REVIEWED_NON_STORE_CALLS_BY_KEY.has(key)) {
              reviewedNonStoreCalls.add(key);
              ts.forEachChild(node, visit);
              return;
            }
          }
          recognizedCalls += 1;
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
              dynamicQueryRecords.push({
                package: name,
                path: sourcePath,
                symbol: enclosingSymbol(node),
                expression: argumentText,
                expressionSha256: createHash('sha256').update(argumentText).digest('hex'),
                line,
              });
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
    dynamicQueryRecords,
    reviewedNonStoreCalls,
    scannedFiles,
    violations,
  };
}

selfTestStaticSparql();
selfTestRawStoreAliasResolution();
selfTestReviewedNonStoreCalls();
selfTestDynamicQueryInventoryDiff();
const packageConfigs = workspaceStorageConsumers();
const results = packageConfigs.map(([name, config]) => scanPackage(name, config));
const violations = results.flatMap((result) => result.violations);
const observedReviewedNonStoreCalls = new Set(
  results.flatMap((result) => [...result.reviewedNonStoreCalls]),
);
for (const [key, record] of REVIEWED_NON_STORE_CALLS_BY_KEY) {
  if (!observedReviewedNonStoreCalls.has(key)) {
    violations.push(
      `reviewed non-store call missing: ${record.package}:${record.path}#${record.symbol} `
      + `${record.receiver}.${record.method}(${record.expression}) - ${record.reason}`,
    );
  }
}
const observed = reviewedDynamicQueryInventory(
  results.flatMap((result) => result.dynamicQueryRecords),
);
const observedInventory = observed.inventory;

if (WRITE_INVENTORY) {
  writeFileSync(
    DYNAMIC_QUERY_INVENTORY_PATH,
    serializeDynamicQueryInventory(observedInventory),
    'utf8',
  );
  console.log(
    `[managed-store-raw-channels] wrote ${observedInventory.length} reviewed record(s) `
    + `to ${DYNAMIC_QUERY_INVENTORY_PATH}`,
  );
} else {
  const expectedInventory = loadDynamicQueryInventory();
  const inventoryDiff = diffDynamicQueryInventory(expectedInventory, observedInventory);
  for (const record of inventoryDiff.missing) {
    violations.push(`reviewed dynamic query missing: ${dynamicQueryInventoryLabel(record)}`);
  }
  for (const record of inventoryDiff.added) {
    violations.push(
      `dynamic query review required: ${dynamicQueryInventoryLabel(
        record,
        observed.expressionsByRecord.get(JSON.stringify(record)),
      )}`,
    );
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
} else if (!WRITE_INVENTORY) {
  console.log(
    '[managed-store-raw-channels] PASS: no first-party raw update() or statically mutating '
    + 'query() calls; '
    + `${observedInventory.length} dynamic query call site(s) match the explicit reviewed inventory `
    + '(runtime ownership guard remains authoritative)',
  );
}
