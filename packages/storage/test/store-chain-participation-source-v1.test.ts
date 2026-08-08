import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

interface DecoratorSource {
  readonly key: string;
  readonly location: string;
  readonly className: string;
  readonly innerParameter: string;
  readonly directlyRegistered: boolean;
}

const STORAGE_SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
const EXPECTED_STORAGE_DECORATORS = Object.freeze([
  'changelog-store.ts#ChangelogStore',
  'graph-set-index-store.ts#GraphSetIndexStore',
  'shared-memory-literal-blob-store.ts#SharedMemoryLiteralBlobStore',
]);

function entityNamesTripleStore(name: ts.EntityName): boolean {
  return ts.isIdentifier(name)
    ? name.text === 'TripleStore'
    : name.right.text === 'TripleStore';
}

function expressionNamesTripleStore(expression: ts.Expression): boolean {
  return ts.isIdentifier(expression)
    ? expression.text === 'TripleStore'
    : ts.isPropertyAccessExpression(expression) && expression.name.text === 'TripleStore';
}

function typeNamesTripleStore(type: ts.TypeNode | undefined): boolean {
  return type !== undefined
    && ts.isTypeReferenceNode(type)
    && entityNamesTripleStore(type.typeName);
}

function directlyRegisters(
  constructor: ts.ConstructorDeclaration,
  innerParameter: string,
): boolean {
  return constructor.body?.statements.some((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
      return false;
    }
    const call = statement.expression;
    return ts.isIdentifier(call.expression)
      && call.expression.text === 'linkStoreChainV1'
      && call.arguments.length >= 2
      && call.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword
      && ts.isIdentifier(call.arguments[1]!)
      && call.arguments[1]!.text === innerParameter;
  }) ?? false;
}

function discoverDecorators(sourceText: string, fileName: string): DecoratorSource[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: DecoratorSource[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined
      && node.heritageClauses?.some(
        (clause) => clause.token === ts.SyntaxKind.ImplementsKeyword
          && clause.types.some((type) => expressionNamesTripleStore(type.expression)),
      )) {
      const constructor = node.members.find(ts.isConstructorDeclaration);
      const inner = constructor?.parameters.find(
        (parameter) => ts.isIdentifier(parameter.name)
          && typeNamesTripleStore(parameter.type),
      );
      if (constructor !== undefined && inner !== undefined && ts.isIdentifier(inner.name)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        found.push({
          key: `${fileName}#${node.name.text}`,
          location: `${fileName}:${line}`,
          className: node.name.text,
          innerParameter: inner.name.text,
          directlyRegistered: directlyRegisters(constructor, inner.name.text),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function listTypeScriptSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptSources(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
      ? [path]
      : [];
  });
}

function relativeSourcePath(path: string): string {
  return relative(STORAGE_SOURCE_ROOT, path).split(sep).join('/');
}

function registrationViolation(decorator: DecoratorSource): string | null {
  return decorator.directlyRegistered
    ? null
    : `${decorator.location} ${decorator.className}: missing linkStoreChainV1(this, ${decorator.innerParameter})`;
}

describe('first-party store-chain participation source contract', () => {
  it('requires direct registration from every Storage-owned decorator', () => {
    const discovered = listTypeScriptSources(STORAGE_SOURCE_ROOT)
      .flatMap((path) => discoverDecorators(
        readFileSync(path, 'utf8'),
        relativeSourcePath(path),
      ))
      .sort((left, right) => left.key.localeCompare(right.key));

    expect(discovered.map(({ key }) => key)).toEqual(EXPECTED_STORAGE_DECORATORS);
    expect(discovered.flatMap((decorator) => {
      const violation = registrationViolation(decorator);
      return violation === null ? [] : [violation];
    })).toEqual([]);
  });

  it('rejects a non-exported decorator whose registration is not executed', () => {
    const [decorator] = discoverDecorators(`
      class ForgetfulDecoratorStore implements TripleStore {
        constructor(private readonly inner: TripleStore) {
          const neverCalled = () => linkStoreChainV1(this, inner);
          void neverCalled;
        }
      }
    `, 'fixture.ts');

    expect(decorator).toBeDefined();
    expect(registrationViolation(decorator!)).toBe(
      'fixture.ts:2 ForgetfulDecoratorStore: missing linkStoreChainV1(this, inner)',
    );
  });

  it('accepts namespace-qualified TripleStore references', () => {
    const [decorator] = discoverDecorators(`
      class QualifiedDecoratorStore implements storage.TripleStore {
        constructor(private readonly inner: storage.TripleStore) {
          linkStoreChainV1(this, inner);
        }
      }
    `, 'qualified-fixture.ts');

    expect(decorator).toMatchObject({
      key: 'qualified-fixture.ts#QualifiedDecoratorStore',
      directlyRegistered: true,
    });
  });
});
