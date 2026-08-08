import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

type ParticipationMode = 'registered' | 'public-inner';

interface DecoratorEvidence {
  readonly key: string;
  readonly location: string;
  readonly className: string;
  readonly innerParameter: string;
  readonly registered: boolean;
  readonly publicInner: boolean;
}

const STORAGE_SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
const AGENT_WRAPPER_PATH = fileURLToPath(
  new URL('../../agent/src/dkg-agent-base.ts', import.meta.url),
);
const AGENT_WRAPPER_NAME = 'createListContextGraphsCacheInvalidatingStore';

const EXPECTED_STORAGE_DECORATORS: Readonly<Record<string, ParticipationMode>> = Object.freeze({
  'changelog-store.ts#ChangelogStore': 'registered',
  'graph-set-index-store.ts#GraphSetIndexStore': 'registered',
  'shared-memory-literal-blob-store.ts#SharedMemoryLiteralBlobStore': 'registered',
});

function propertyNameText(name: ts.PropertyName | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function typeNamesTripleStore(type: ts.TypeNode | undefined, sourceFile: ts.SourceFile): boolean {
  return type !== undefined && /(?:^|\W)TripleStore(?:\W|$)/.test(type.getText(sourceFile));
}

function classImplementsTripleStore(node: ts.ClassDeclaration, sourceFile: ts.SourceFile): boolean {
  return node.heritageClauses?.some(
    (clause) => clause.token === ts.SyntaxKind.ImplementsKeyword
      && clause.types.some((type) => typeNamesTripleStore(type, sourceFile)),
  ) ?? false;
}

function constructorLinkCall(
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

function constructorAssignsPublicInner(
  node: ts.ClassDeclaration,
  constructor: ts.ConstructorDeclaration,
  innerParameter: string,
): boolean {
  const publicParameterProperty = constructor.parameters.some((parameter) =>
    ts.isIdentifier(parameter.name)
    && parameter.name.text === 'innerStore'
    && innerParameter === 'innerStore'
    && parameter.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.PublicKeyword
        || modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
    ) === true
    && !parameter.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword
        || modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    ));
  if (publicParameterProperty) return true;

  const declaredPublicInner = node.members.some((member) => {
    if (!ts.isPropertyDeclaration(member) || propertyNameText(member.name) !== 'innerStore') {
      return false;
    }
    return !member.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword
        || modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    );
  });
  if (!declaredPublicInner) return false;

  return constructor.body?.statements.some((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) {
      return false;
    }
    const assignment = statement.expression;
    return assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(assignment.left)
      && assignment.left.expression.kind === ts.SyntaxKind.ThisKeyword
      && assignment.left.name.text === 'innerStore'
      && ts.isIdentifier(assignment.right)
      && assignment.right.text === innerParameter;
  }) ?? false;
}

function discoverStorageDecorators(sourceText: string, fileName: string): DecoratorEvidence[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const decorators: DecoratorEvidence[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined
      && classImplementsTripleStore(node, sourceFile)) {
      const constructor = node.members.find(ts.isConstructorDeclaration);
      const inner = constructor?.parameters.find(
        (parameter) => ts.isIdentifier(parameter.name)
          && typeNamesTripleStore(parameter.type, sourceFile),
      );
      if (constructor !== undefined && inner !== undefined && ts.isIdentifier(inner.name)) {
        const innerParameter = inner.name.text;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        decorators.push({
          key: `${fileName}#${node.name.text}`,
          location: `${fileName}:${line}`,
          className: node.name.text,
          innerParameter,
          registered: constructorLinkCall(constructor, innerParameter),
          publicInner: constructorAssignsPublicInner(node, constructor, innerParameter),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return decorators;
}

function participationViolation(
  evidence: DecoratorEvidence,
  mode: ParticipationMode,
): string | null {
  if (mode === 'registered' && !evidence.registered) {
    return `${evidence.location} ${evidence.className}: missing linkStoreChainV1(this, ${evidence.innerParameter})`;
  }
  if (mode === 'public-inner' && !evidence.publicInner) {
    return `${evidence.location} ${evidence.className}: missing public innerStore assignment from ${evidence.innerParameter}`;
  }
  return null;
}

function listTypeScriptSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptSources(path));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(path);
    }
  }
  return files;
}

function normalizedRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function objectLiteralHasInnerStore(
  sourceText: string,
  fileName: string,
  functionName: string,
): boolean {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let foundFunction = false;
  let exposesInner = false;

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      foundFunction = true;
      const innerParameter = node.parameters.find(
        (parameter) => ts.isIdentifier(parameter.name)
          && parameter.name.text === 'innerStore'
          && typeNamesTripleStore(parameter.type, sourceFile),
      );
      if (innerParameter === undefined || node.body === undefined) return;
      const returnedNames = new Set<string>();
      const returnedObjects: ts.ObjectLiteralExpression[] = [];
      const collectReturns = (candidate: ts.Node): void => {
        if (candidate !== node.body && ts.isFunctionLike(candidate)) return;
        if (ts.isReturnStatement(candidate)) {
          if (candidate.expression !== undefined && ts.isIdentifier(candidate.expression)) {
            returnedNames.add(candidate.expression.text);
          } else if (candidate.expression !== undefined
            && ts.isObjectLiteralExpression(candidate.expression)) {
            returnedObjects.push(candidate.expression);
          }
        }
        ts.forEachChild(candidate, collectReturns);
      };
      collectReturns(node.body);
      const collectReturnedDeclarations = (candidate: ts.Node): void => {
        if (candidate !== node.body && ts.isFunctionLike(candidate)) return;
        if (ts.isVariableDeclaration(candidate)
          && ts.isIdentifier(candidate.name)
          && returnedNames.has(candidate.name.text)
          && candidate.initializer !== undefined
          && ts.isObjectLiteralExpression(candidate.initializer)) {
          returnedObjects.push(candidate.initializer);
        }
        ts.forEachChild(candidate, collectReturnedDeclarations);
      };
      collectReturnedDeclarations(node.body);
      exposesInner = returnedObjects.some((object) => object.properties.some((property) => {
        if (ts.isShorthandPropertyAssignment(property)) {
          return property.name.text === 'innerStore';
        }
        return ts.isPropertyAssignment(property)
          && propertyNameText(property.name) === 'innerStore'
          && ts.isIdentifier(property.initializer)
          && property.initializer.text === 'innerStore';
      }));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!foundFunction) throw new Error(`${fileName}: missing ${functionName}`);
  return exposesInner;
}

describe('first-party store-chain participation source contract', () => {
  it('classifies every Storage decorator and verifies its traversal evidence', () => {
    const discovered = listTypeScriptSources(STORAGE_SOURCE_ROOT)
      .flatMap((path) => discoverStorageDecorators(
        readFileSync(path, 'utf8'),
        normalizedRelativePath(STORAGE_SOURCE_ROOT, path),
      ))
      .sort((left, right) => left.key.localeCompare(right.key));

    expect(discovered.map(({ key }) => key)).toEqual(
      Object.keys(EXPECTED_STORAGE_DECORATORS).sort(),
    );
    expect(discovered.flatMap((evidence) => {
      const mode = EXPECTED_STORAGE_DECORATORS[evidence.key];
      if (mode === undefined) return [`${evidence.location} ${evidence.className}: unclassified`];
      const violation = participationViolation(evidence, mode);
      return violation === null ? [] : [violation];
    })).toEqual([]);
  });

  it('mechanically rejects a non-exported decorator that forgets participation', () => {
    const [evidence] = discoverStorageDecorators(`
      class ForgetfulDecoratorStore implements TripleStore {
        constructor(private readonly inner: TripleStore) {
          const neverCalled = () => linkStoreChainV1(this, inner);
          void neverCalled;
        }
      }
    `, 'fixture.ts');

    expect(evidence).toBeDefined();
    expect(participationViolation(evidence!, 'registered')).toBe(
      'fixture.ts:2 ForgetfulDecoratorStore: missing linkStoreChainV1(this, inner)',
    );
  });

  it('accepts both supported first-party participation modes', () => {
    const registered = discoverStorageDecorators(`
      class RegisteredStore implements TripleStore {
        constructor(private readonly inner: TripleStore) {
          linkStoreChainV1(this, inner);
        }
      }
    `, 'registered.ts')[0]!;
    const publicInner = discoverStorageDecorators(`
      class PublicInnerStore implements TripleStore {
        readonly innerStore: TripleStore;
        constructor(inner: TripleStore) {
          this.innerStore = inner;
        }
      }
    `, 'public-inner.ts')[0]!;
    const publicParameter = discoverStorageDecorators(`
      class PublicParameterStore implements TripleStore {
        constructor(readonly innerStore: TripleStore) {}
      }
    `, 'public-parameter.ts')[0]!;

    expect(participationViolation(registered, 'registered')).toBeNull();
    expect(participationViolation(publicInner, 'public-inner')).toBeNull();
    expect(participationViolation(publicParameter, 'public-inner')).toBeNull();
  });

  it('keeps the Agent object-literal forwarder traversable', () => {
    expect(objectLiteralHasInnerStore(
      readFileSync(AGENT_WRAPPER_PATH, 'utf8'),
      basename(AGENT_WRAPPER_PATH),
      AGENT_WRAPPER_NAME,
    )).toBe(true);
  });

  it('rejects an Agent-style object-literal forwarder without innerStore', () => {
    const broken = `
      function ${AGENT_WRAPPER_NAME}(innerStore: TripleStore): TripleStore {
        const unrelated = { innerStore };
        void unrelated;
        const wrapper: TripleStore = {
          listGraphs: () => innerStore.listGraphs(),
        };
        return wrapper;
      }
    `;
    expect(objectLiteralHasInnerStore(broken, 'fixture-agent.ts', AGENT_WRAPPER_NAME)).toBe(false);
  });
});
