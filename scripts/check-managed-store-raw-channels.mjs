#!/usr/bin/env node

import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeSparqlOperation } from '../packages/core/dist/sparql-operation.js';
import ts from 'typescript';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_CONFIGS = [
  ['agent', 'packages/agent/tsconfig.json'],
  ['cli', 'packages/cli/tsconfig.json'],
  ['publisher', 'packages/publisher/tsconfig.json'],
  ['query', 'packages/query/tsconfig.json'],
];
const TRIPLE_STORE_DECLARATION = /\/packages\/storage\/(?:src\/triple-store\.ts|dist\/triple-store\.d\.ts)$/u;

function normalized(path) {
  return resolve(path).split(sep).join('/');
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

function staticSparql(expression) {
  return expression && (
    ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
  ) ? expression.text : null;
}

function isTripleStoreReceiver(checker, receiver, tripleStoreType) {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return false;
  return checker.isTypeAssignableTo(type, tripleStoreType);
}

function scanPackage(name, configPath) {
  const program = loadProgram(configPath);
  const checker = program.getTypeChecker();
  const tripleStoreType = findTripleStoreType(program, checker);
  const sourceRoot = normalized(resolve(REPOSITORY_ROOT, `packages/${name}/src`));
  const violations = [];
  let recognizedCalls = 0;
  let scannedFiles = 0;

  for (const sourceFile of program.getSourceFiles()) {
    const fileName = normalized(sourceFile.fileName);
    if (!fileName.startsWith(`${sourceRoot}/`) || sourceFile.isDeclarationFile) continue;
    scannedFiles += 1;
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const access = methodAccess(node.expression);
        if (
          access
          && (access.method === 'update' || access.method === 'query')
          && isTripleStoreReceiver(checker, access.receiver, tripleStoreType)
        ) {
          recognizedCalls += 1;
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          const location = `${fileName.slice(REPOSITORY_ROOT.length + 1)}:${line}`;
          if (access.method === 'update') {
            violations.push(`${location}: raw TripleStore.update()`);
          } else {
            const sparql = staticSparql(node.arguments[0]);
            if (sparql !== null) {
              const analysis = analyzeSparqlOperation(sparql);
              if (analysis.operation.kind !== 'read' || analysis.mutatingKeyword !== null) {
                violations.push(`${location}: non-read static TripleStore.query()`);
              }
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
  return { name, recognizedCalls, scannedFiles, violations };
}

const results = PACKAGE_CONFIGS.map(([name, config]) => scanPackage(name, config));
const violations = results.flatMap((result) => result.violations);
for (const result of results) {
  console.log(
    `[managed-store-raw-channels] ${result.name}: ` +
    `${result.scannedFiles} files, ${result.recognizedCalls} typed call(s)`,
  );
}
if (violations.length > 0) {
  console.error('[managed-store-raw-channels] FAILED');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exitCode = 1;
} else {
  console.log('[managed-store-raw-channels] PASS: no first-party raw mutating store calls');
}
