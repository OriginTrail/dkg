/**
 * TypeScript/JavaScript parser using the TypeScript Compiler API.
 *
 * Uses ts.createSourceFile for single-file AST parsing (no type checking).
 * Extracts classes, interfaces, functions, methods, type aliases, enums,
 * constants, imports, and exports.
 */

import ts from 'typescript';
import type { LanguageParser, ParseResult, ParsedEntity, ParsedImport, ParsedExport } from './parser.js';

export class TypeScriptParser implements LanguageParser {
  async parse(source: string, filePath: string): Promise<ParseResult> {
    const scriptKind = this.getScriptKind(filePath);
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);

    const entities: ParsedEntity[] = [];
    const imports: ParsedImport[] = [];
    const exports: ParsedExport[] = [];

    this.visit(sourceFile, sourceFile, entities, imports, exports, undefined);

    return { entities, imports, exports };
  }

  private getScriptKind(filePath: string): ts.ScriptKind {
    if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
    if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
    if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) return ts.ScriptKind.JS;
    return ts.ScriptKind.TS;
  }

  private visit(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    entities: ParsedEntity[],
    imports: ParsedImport[],
    exports: ParsedExport[],
    parentClassName: string | undefined,
  ): void {
    if (ts.isClassDeclaration(node)) {
      this.extractClass(node, sourceFile, entities, exports);
      // Visit class members with parent context
      const className = node.name?.text;
      ts.forEachChild(node, child => this.visit(child, sourceFile, entities, imports, exports, className));
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      this.extractInterface(node, sourceFile, entities, exports);
    } else if (ts.isFunctionDeclaration(node)) {
      this.extractFunction(node, sourceFile, entities, exports);
    } else if (ts.isMethodDeclaration(node) && parentClassName) {
      this.extractMethod(node, sourceFile, entities, parentClassName);
    } else if (ts.isConstructorDeclaration(node) && parentClassName) {
      this.extractConstructor(node, sourceFile, entities, parentClassName);
    } else if (ts.isTypeAliasDeclaration(node)) {
      this.extractTypeAlias(node, sourceFile, entities, exports);
    } else if (ts.isEnumDeclaration(node)) {
      this.extractEnum(node, sourceFile, entities, exports);
    } else if (ts.isVariableStatement(node)) {
      this.extractVariables(node, sourceFile, entities, exports);
    } else if (ts.isImportDeclaration(node)) {
      this.extractImport(node, sourceFile, imports);
    } else if (ts.isExportDeclaration(node)) {
      this.extractExportDecl(node, sourceFile, exports);
    } else if (ts.isExportAssignment(node)) {
      this.extractExportAssignment(node, sourceFile, exports);
    }

    // Don't recurse into class children here (handled above)
    if (!ts.isClassDeclaration(node)) {
      ts.forEachChild(node, child => this.visit(child, sourceFile, entities, imports, exports, parentClassName));
    }
  }

  private extractClass(
    node: ts.ClassDeclaration,
    sourceFile: ts.SourceFile,
    entities: ParsedEntity[],
    exports: ParsedExport[],
  ): void {
    const name = node.name?.text;
    if (!name) return;

    const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    const isExported = hasExportModifier(node);
    const decorators = getDecorators(node);

    const entity: ParsedEntity = {
      kind: 'class',
      name,
      startLine,
      endLine,
      isExported,
    };

    // extends
    if (node.heritageClauses) {
      for (const clause of node.heritageClauses) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.length > 0) {
          entity.extends = clause.types[0].expression.getText(sourceFile);
        }
        if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
          entity.implements = clause.types.map(t => t.expression.getText(sourceFile));
        }
      }
    }

    if (decorators.length > 0) entity.decorators = decorators;

    entities.push(entity);

    if (isExported) {
      exports.push({ name, kind: 'class', line: startLine });
    }
  }

  private extractInterface(
    node: ts.InterfaceDeclaration,
    sourceFile: ts.SourceFile,
    entities: ParsedEntity[],
    exports: ParsedExport[],
  ): void {
    const name = node.name.text;
    const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    const isExported = hasExportModifier(node);

    const entity: ParsedEntity = {
      kind: 'interface',
      name,
      startLine,
      endLine,
      isExported,
    };

    if (node.heritageClauses) {
      for (const clause of node.heritageClauses) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.length > 0) {
          entity.extends = clause.types[0].expression.getText(sourceFile);
        }
      }
    }

    entities.push(entity);

    if (isExported) {
      exports.push({ name, kind: 'interface', line: startLine });
    }
  }

  private extractFunction(
    node: ts.FunctionDeclaration,
    sourceFile: ts.SourceFile,
    entities: ParsedEntity[],
    exports: ParsedExport[],
  ): void {
    const name = node.name?.text;
    if (!name) return;

    const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    const isExported = hasExportModifier(node);
    const isAsync = hasAsyncModifier(node);
    const decorators = getDecorators(node);

    const entity: ParsedEntity = {
      kind: 'function',
      name,
      startLine,
      endLine,
      isExported,
      isAsync,
      parameters: node.parameters.map(p => p.name.getText(sourceFile)),
    };

    if (node.type) {
      entity.returnType = node.type.getText(sourceFile);
    }

    entity.signature = `${isAsync ? 'async ' : ''}function ${name}(${node.parameters.map(p => p.getText(sourceFile)).join(', ')})${node.type ? ': ' + node.type.getText(sourceFile) : ''}`;

    if (decorators.length > 0) entity.decorators = decorators;

    entities.push(entity);

    if (isExported) {
      exports.push({ name, kind: 'function', line: startLine });
    }
  }

  private extractMethod(
    node: ts.MethodDeclaration,
    sourceFile: ts.SourceFile,
    entities: ParsedEntity[],
    parentClass: string,
  ): void {
    const name = node.name.getText(sourceFile);
    const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    const isAsync = hasAsyncModifier(node);
    const visibility = getVisibility(node);
    const decorators = getDecorators(node);

    const entity: ParsedEntity = {
      kind: 'method',
      name,
      startLine,
      endLine,
      parentClass,
      isAsync,
      visibility,
      parameters: node.parameters.map(p => p.name.getText(sourceFile)),
    };

    if (node.type) {
      entity.returnType = node.type.getText(sourceFile);
    }

    entity.signature = `${visibility ? visibility + ' ' : ''}${isAsync ? 'async ' : ''}${name}(${node.parameters.map(p => p.getText(sourceFile)).join(', ')})${node.type ? ': ' + node.type.getText(sourceFile) : ''}`;

    if (decorators.length > 0) entity.decorators = decorators;

    entities.push(entity);
  }

  private extractConstructor(
    node: ts.ConstructorDeclaration,
    sourceFile: ts.SourceFile,
    entities: ParsedEntity[],
    parentClass: string,
  ): void {
    const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

    entities.push({
      kind: 'method',
      name: 'constructor',
      startLine,
      endLine,
      parentClass,
      parameters: node.parameters.map(p => p.name.getText(sourceFile)),
      signature: `constructor(${node.parameters.map(p => p.getText(sourceFile)).join(', ')})`,
    });
  }

  private extractTypeAlias(
    node: ts.TypeAliasDeclaration,
    sourceFile: ts.SourceFile,
    entities: ParsedEntity[],
    exports: ParsedExport[],
  ): void {
    const name = node.name.text;
    const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    const isExported = hasExportModifier(node);

    entities.push({
      kind: 'type',
      name,
      startLine,
      endLine,
      isExported,
    });

    if (isExported) {
      exports.push({ name, kind: 'type', line: startLine });
    }
  }

  private extractEnum(
    node: ts.EnumDeclaration,
    sourceFile: ts.SourceFile,
    entities: ParsedEntity[],
    exports: ParsedExport[],
  ): void {
    const name = node.name.text;
    const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    const isExported = hasExportModifier(node);

    entities.push({
      kind: 'enum',
      name,
      startLine,
      endLine,
      isExported,
    });

    if (isExported) {
      exports.push({ name, kind: 'enum', line: startLine });
    }
  }

  private extractVariables(
    node: ts.VariableStatement,
    sourceFile: ts.SourceFile,
    entities: ParsedEntity[],
    exports: ParsedExport[],
  ): void {
    const isExported = hasExportModifier(node);
    const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;

    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;

      const name = decl.name.text;
      const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

      // Only extract exported or const declarations (skip local vars)
      if (!isExported && !isConst) continue;

      // Check if it's an arrow function assigned to a const
      if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
        const fn = decl.initializer;
        const isAsync = hasAsyncModifier(fn);
        const params = fn.parameters;

        const entity: ParsedEntity = {
          kind: 'function',
          name,
          startLine,
          endLine,
          isExported,
          isAsync,
          parameters: params.map(p => p.name.getText(sourceFile)),
        };

        if (ts.isArrowFunction(fn) && fn.type) {
          entity.returnType = fn.type.getText(sourceFile);
        }

        entities.push(entity);
      } else {
        entities.push({
          kind: isConst ? 'constant' : 'variable',
          name,
          startLine,
          endLine,
          isExported,
        });
      }

      if (isExported) {
        exports.push({ name, kind: isConst ? 'constant' : 'variable', line: startLine });
      }
    }
  }

  private extractImport(
    node: ts.ImportDeclaration,
    sourceFile: ts.SourceFile,
    imports: ParsedImport[],
  ): void {
    const moduleSpecifier = node.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) return;

    const source = moduleSpecifier.text;
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const isTypeOnly = node.importClause?.isTypeOnly ?? false;
    const specifiers: string[] = [];

    if (node.importClause) {
      // Default import
      if (node.importClause.name) {
        specifiers.push(node.importClause.name.text);
      }

      // Named imports
      if (node.importClause.namedBindings) {
        if (ts.isNamedImports(node.importClause.namedBindings)) {
          for (const element of node.importClause.namedBindings.elements) {
            specifiers.push(element.name.text);
          }
        } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
          specifiers.push(`* as ${node.importClause.namedBindings.name.text}`);
        }
      }
    }

    imports.push({ source, specifiers, line, isTypeOnly });
  }

  private extractExportDecl(
    node: ts.ExportDeclaration,
    sourceFile: ts.SourceFile,
    exports: ParsedExport[],
  ): void {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        exports.push({
          name: element.name.text,
          kind: 're-export',
          line,
        });
      }
    }
  }

  private extractExportAssignment(
    node: ts.ExportAssignment,
    sourceFile: ts.SourceFile,
    exports: ParsedExport[],
  ): void {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    exports.push({
      name: 'default',
      kind: 'default',
      line,
      isDefault: true,
    });
  }
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function hasAsyncModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

function getVisibility(node: ts.Node): string | undefined {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!modifiers) return undefined;
  if (modifiers.some(m => m.kind === ts.SyntaxKind.PrivateKeyword)) return 'private';
  if (modifiers.some(m => m.kind === ts.SyntaxKind.ProtectedKeyword)) return 'protected';
  if (modifiers.some(m => m.kind === ts.SyntaxKind.PublicKeyword)) return 'public';
  return undefined;
}

function getDecorators(node: ts.Node): string[] {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  if (!decorators) return [];
  return decorators.map(d => d.expression.getText());
}
