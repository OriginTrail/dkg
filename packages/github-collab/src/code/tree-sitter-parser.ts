/**
 * Tree-sitter based parser for non-TypeScript languages.
 *
 * Uses web-tree-sitter (WASM runtime) with prebuilt grammars from tree-sitter-wasms.
 * Supports Python, Go, Rust, Java, and Solidity.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { LanguageParser, ParseResult, ParsedEntity, ParsedImport, ParsedExport } from './parser.js';

// We use `any` for tree-sitter types because the module uses `declare module`
// with namespace-level exports and the exact types are hard to thread through
// the lazy-init pattern. The actual runtime objects are fully typed by tree-sitter.

let ParserClass: any = null;
let initPromise: Promise<void> | null = null;

const languageCache = new Map<string, any>();

async function ensureInit(): Promise<void> {
  if (ParserClass) return;
  if (initPromise) { await initPromise; return; }
  initPromise = (async () => {
    const mod = await import('web-tree-sitter');
    // web-tree-sitter@0.22.x: default export is the Parser class itself
    // web-tree-sitter@0.26.x: named exports Parser, Language, etc.
    const P = (mod as any).default ?? (mod as any).Parser ?? mod;
    await P.init();
    ParserClass = P;
  })();
  await initPromise;
}

async function getLanguage(langName: string): Promise<any> {
  const cached = languageCache.get(langName);
  if (cached) return cached;

  await ensureInit();

  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${langName}.wasm`);

  // After init(), Language is available as a static property on the Parser class
  const lang = await ParserClass.Language.load(wasmPath);
  languageCache.set(langName, lang);
  return lang;
}

function createParser(lang: any): any {
  const p = new ParserClass();
  p.setLanguage(lang);
  return p;
}

/** Supported tree-sitter language configurations. */
type SupportedLanguage = 'python' | 'go' | 'rust' | 'java' | 'solidity';

interface LanguageConfig {
  grammarName: string;
  extractors: {
    entities: (root: any) => ParsedEntity[];
    imports: (root: any) => ParsedImport[];
    exports: (root: any) => ParsedExport[];
  };
}

// --- Language-specific extraction logic ---

/** Recursively find all nodes matching given types. */
function findAll(node: any, types: string[]): any[] {
  const results: any[] = [];
  const cursor = node.walk();

  const visitChildren = (): void => {
    if (cursor.gotoFirstChild()) {
      do {
        if (types.includes(cursor.currentNode.type)) {
          results.push(cursor.currentNode);
        }
        visitChildren();
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };
  visitChildren();

  return results;
}

function nameFromField(node: any, field: string): string | undefined {
  return node.childForFieldName(field)?.text;
}

// --- Python ---

function pythonEntities(root: any): ParsedEntity[] {
  const entities: ParsedEntity[] = [];

  for (const node of findAll(root, ['function_definition', 'class_definition'])) {
    const name = nameFromField(node, 'name');
    if (!name) continue;

    if (node.type === 'class_definition') {
      const entity: ParsedEntity = {
        kind: 'class',
        name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      };
      const superclasses = node.childForFieldName('superclasses');
      if (superclasses) {
        const first = superclasses.namedChildren[0];
        if (first) entity.extends = first.text;
      }
      entities.push(entity);
    } else {
      const params = node.childForFieldName('parameters');
      const paramNames: string[] = params
        ? params.namedChildren
            .filter((p: any) => p.type === 'identifier' || p.type === 'typed_parameter' || p.type === 'default_parameter')
            .map((p: any) => {
              const n = p.childForFieldName('name');
              return n ? n.text : p.text;
            })
            .filter((n: string) => n !== 'self' && n !== 'cls')
        : [];

      const returnType = node.childForFieldName('return_type')?.text;

      // Check if method (inside class body)
      const isMethod = node.parent?.type === 'block' && node.parent.parent?.type === 'class_definition';
      const parentClassName = isMethod ? nameFromField(node.parent!.parent!, 'name') : undefined;

      entities.push({
        kind: isMethod ? 'method' : 'function',
        name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        parameters: paramNames,
        returnType,
        parentClass: parentClassName,
      });
    }
  }

  return entities;
}

function pythonImports(root: any): ParsedImport[] {
  const imports: ParsedImport[] = [];

  for (const node of findAll(root, ['import_statement', 'import_from_statement'])) {
    if (node.type === 'import_statement') {
      const module = node.childForFieldName('name');
      if (module) {
        imports.push({
          source: module.text,
          specifiers: [module.text],
          line: node.startPosition.row + 1,
        });
      }
    } else {
      const module = node.childForFieldName('module_name');
      const names = node.namedChildren.filter((c: any) => c.type === 'dotted_name' || c.type === 'aliased_import');
      const specifiers = names
        .filter((n: any) => n !== module)
        .map((n: any) => n.type === 'aliased_import' ? (nameFromField(n, 'name') ?? n.text) : n.text);

      imports.push({
        source: module?.text ?? '',
        specifiers,
        line: node.startPosition.row + 1,
      });
    }
  }

  return imports;
}

function pythonExports(_root: any): ParsedExport[] {
  return [];
}

// --- Go ---

function goEntities(root: any): ParsedEntity[] {
  const entities: ParsedEntity[] = [];

  for (const node of findAll(root, ['function_declaration', 'method_declaration', 'type_declaration'])) {
    if (node.type === 'function_declaration') {
      const name = nameFromField(node, 'name');
      if (!name) continue;
      const params = node.childForFieldName('parameters');
      const paramNames: string[] = params ? params.namedChildren
        .filter((p: any) => p.type === 'parameter_declaration')
        .map((p: any) => p.namedChildren[0]?.text ?? p.text) : [];
      const result = node.childForFieldName('result');

      entities.push({
        kind: 'function',
        name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        parameters: paramNames,
        returnType: result?.text,
        visibility: name[0] === name[0].toUpperCase() ? 'public' : 'private',
        isExported: name[0] === name[0].toUpperCase(),
      });
    } else if (node.type === 'method_declaration') {
      const name = nameFromField(node, 'name');
      const receiver = node.childForFieldName('receiver');
      if (!name) continue;

      const receiverType = receiver?.namedChildren[0]?.namedChildren
        ?.find((c: any) => c.type === 'type_identifier')?.text;

      entities.push({
        kind: 'method',
        name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        parentClass: receiverType,
        visibility: name[0] === name[0].toUpperCase() ? 'public' : 'private',
        isExported: name[0] === name[0].toUpperCase(),
      });
    } else if (node.type === 'type_declaration') {
      for (const spec of node.namedChildren.filter((c: any) => c.type === 'type_spec')) {
        const name = nameFromField(spec, 'name');
        if (!name) continue;
        const typeNode = spec.childForFieldName('type');
        const kind = typeNode?.type === 'struct_type' ? 'struct'
          : typeNode?.type === 'interface_type' ? 'interface'
          : 'type';

        entities.push({
          kind: kind as ParsedEntity['kind'],
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          visibility: name[0] === name[0].toUpperCase() ? 'public' : 'private',
          isExported: name[0] === name[0].toUpperCase(),
        });
      }
    }
  }

  return entities;
}

function goImports(root: any): ParsedImport[] {
  const imports: ParsedImport[] = [];

  for (const node of findAll(root, ['import_declaration'])) {
    for (const spec of node.namedChildren) {
      if (spec.type === 'import_spec') {
        const path = spec.childForFieldName('path')?.text?.replace(/"/g, '') ?? '';
        imports.push({
          source: path,
          specifiers: [path.split('/').pop() ?? path],
          line: spec.startPosition.row + 1,
        });
      } else if (spec.type === 'import_spec_list') {
        for (const s of spec.namedChildren.filter((c: any) => c.type === 'import_spec')) {
          const path = s.childForFieldName('path')?.text?.replace(/"/g, '') ?? '';
          imports.push({
            source: path,
            specifiers: [path.split('/').pop() ?? path],
            line: s.startPosition.row + 1,
          });
        }
      }
    }
  }

  return imports;
}

function goExports(_root: any): ParsedExport[] {
  return [];
}

// --- Rust ---

function rustEntities(root: any): ParsedEntity[] {
  const entities: ParsedEntity[] = [];

  for (const node of findAll(root, [
    'function_item', 'struct_item', 'enum_item', 'trait_item', 'impl_item', 'type_item',
  ])) {
    const name = nameFromField(node, 'name');
    if (!name && node.type !== 'impl_item') continue;

    const isPublic = node.children.some((c: any) => c.type === 'visibility_modifier');

    switch (node.type) {
      case 'function_item': {
        const params = node.childForFieldName('parameters');
        const paramNames: string[] = params ? params.namedChildren
          .filter((p: any) => p.type === 'parameter')
          .map((p: any) => p.childForFieldName('pattern')?.text ?? p.text) : [];
        const returnType = node.childForFieldName('return_type')?.text;

        entities.push({
          kind: 'function',
          name: name!,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          parameters: paramNames,
          returnType,
          visibility: isPublic ? 'public' : 'private',
          isExported: isPublic,
        });
        break;
      }
      case 'struct_item':
        entities.push({
          kind: 'struct',
          name: name!,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          visibility: isPublic ? 'public' : 'private',
          isExported: isPublic,
        });
        break;
      case 'enum_item':
        entities.push({
          kind: 'enum',
          name: name!,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          visibility: isPublic ? 'public' : 'private',
          isExported: isPublic,
        });
        break;
      case 'trait_item':
        entities.push({
          kind: 'interface',
          name: name!,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          visibility: isPublic ? 'public' : 'private',
          isExported: isPublic,
        });
        break;
      case 'impl_item': {
        const typeName = node.childForFieldName('type')?.text ?? name;
        const body = node.childForFieldName('body');
        if (body && typeName) {
          for (const fn of body.namedChildren.filter((c: any) => c.type === 'function_item')) {
            const fnName = nameFromField(fn, 'name');
            if (!fnName) continue;
            const fnPublic = fn.children.some((c: any) => c.type === 'visibility_modifier');
            entities.push({
              kind: 'method',
              name: fnName,
              startLine: fn.startPosition.row + 1,
              endLine: fn.endPosition.row + 1,
              parentClass: typeName,
              visibility: fnPublic ? 'public' : 'private',
              isExported: fnPublic,
            });
          }
        }
        break;
      }
      case 'type_item':
        entities.push({
          kind: 'type',
          name: name!,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          visibility: isPublic ? 'public' : 'private',
          isExported: isPublic,
        });
        break;
    }
  }

  return entities;
}

function rustImports(root: any): ParsedImport[] {
  const imports: ParsedImport[] = [];

  for (const node of findAll(root, ['use_declaration'])) {
    const arg = node.namedChildren.find((c: any) => c.type === 'use_as_clause' || c.type === 'scoped_identifier' || c.type === 'scoped_use_list' || c.type === 'identifier');
    if (arg) {
      imports.push({
        source: arg.text,
        specifiers: [arg.text.split('::').pop() ?? arg.text],
        line: node.startPosition.row + 1,
      });
    }
  }

  return imports;
}

function rustExports(_root: any): ParsedExport[] {
  return [];
}

// --- Java ---

function javaEntities(root: any): ParsedEntity[] {
  const entities: ParsedEntity[] = [];

  for (const node of findAll(root, [
    'class_declaration', 'interface_declaration', 'method_declaration',
    'constructor_declaration', 'enum_declaration',
  ])) {
    const name = nameFromField(node, 'name');
    if (!name) continue;

    const modifiers = node.namedChildren.filter((c: any) => c.type === 'modifiers');
    const modText = modifiers.map((m: any) => m.text).join(' ');
    const visibility = modText.includes('public') ? 'public'
      : modText.includes('private') ? 'private'
      : modText.includes('protected') ? 'protected'
      : undefined;

    switch (node.type) {
      case 'class_declaration': {
        const entity: ParsedEntity = {
          kind: 'class',
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          visibility,
          isExported: visibility === 'public',
        };
        const superclass = node.childForFieldName('superclass');
        if (superclass) entity.extends = superclass.text;
        const interfaces = node.childForFieldName('interfaces');
        if (interfaces) {
          entity.implements = interfaces.namedChildren
            .filter((c: any) => c.type === 'type_identifier' || c.type === 'generic_type')
            .map((c: any) => c.text);
        }
        entities.push(entity);
        break;
      }
      case 'interface_declaration':
        entities.push({
          kind: 'interface',
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          visibility,
          isExported: visibility === 'public',
        });
        break;
      case 'method_declaration': {
        const parentClass = node.parent?.type === 'class_body'
          ? nameFromField(node.parent.parent!, 'name')
          : undefined;
        const returnType = node.childForFieldName('type')?.text;
        const params = node.childForFieldName('parameters');
        const paramNames: string[] = params ? params.namedChildren
          .filter((p: any) => p.type === 'formal_parameter')
          .map((p: any) => nameFromField(p, 'name') ?? p.text) : [];

        entities.push({
          kind: 'method',
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          parentClass,
          visibility,
          returnType,
          parameters: paramNames,
        });
        break;
      }
      case 'constructor_declaration': {
        const parentClass = node.parent?.type === 'class_body'
          ? nameFromField(node.parent.parent!, 'name')
          : undefined;
        entities.push({
          kind: 'method',
          name: 'constructor',
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          parentClass,
          visibility,
        });
        break;
      }
      case 'enum_declaration':
        entities.push({
          kind: 'enum',
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          visibility,
          isExported: visibility === 'public',
        });
        break;
    }
  }

  return entities;
}

function javaImports(root: any): ParsedImport[] {
  const imports: ParsedImport[] = [];

  for (const node of findAll(root, ['import_declaration'])) {
    const scope = node.namedChildren.find((c: any) => c.type === 'scoped_identifier');
    if (scope) {
      const source = scope.text;
      imports.push({
        source,
        specifiers: [source.split('.').pop() ?? source],
        line: node.startPosition.row + 1,
      });
    }
  }

  return imports;
}

function javaExports(_root: any): ParsedExport[] {
  return [];
}

// --- Solidity ---

function solidityEntities(root: any): ParsedEntity[] {
  const entities: ParsedEntity[] = [];

  for (const node of findAll(root, [
    'contract_declaration', 'interface_declaration', 'library_declaration',
    'function_definition', 'event_definition', 'struct_declaration', 'enum_declaration',
    'modifier_definition',
  ])) {
    const name = nameFromField(node, 'name');
    if (!name) continue;

    switch (node.type) {
      case 'contract_declaration':
      case 'library_declaration': {
        const entity: ParsedEntity = {
          kind: 'class',
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: true,
        };
        const inheritance = node.childForFieldName('inheritance');
        if (inheritance && inheritance.namedChildren.length > 0) {
          entity.extends = inheritance.namedChildren[0].text;
          if (inheritance.namedChildren.length > 1) {
            entity.implements = inheritance.namedChildren.slice(1).map((c: any) => c.text);
          }
        }
        entities.push(entity);
        break;
      }
      case 'interface_declaration':
        entities.push({
          kind: 'interface',
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: true,
        });
        break;
      case 'function_definition': {
        const parentClass = findContractParent(node);
        const visibility = node.namedChildren
          .find((c: any) => ['public', 'external', 'internal', 'private'].includes(c.text))?.text;

        entities.push({
          kind: parentClass ? 'method' : 'function',
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          parentClass,
          visibility,
        });
        break;
      }
      case 'event_definition':
        entities.push({
          kind: 'function',
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
        break;
      case 'struct_declaration':
        entities.push({
          kind: 'struct',
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
        break;
      case 'enum_declaration':
        entities.push({
          kind: 'enum',
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
        break;
      case 'modifier_definition':
        entities.push({
          kind: 'function',
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
        break;
    }
  }

  return entities;
}

function findContractParent(node: any): string | undefined {
  let parent = node.parent;
  while (parent) {
    if (['contract_declaration', 'library_declaration', 'interface_declaration'].includes(parent.type)) {
      return nameFromField(parent, 'name');
    }
    parent = parent.parent;
  }
  return undefined;
}

function solidityImports(root: any): ParsedImport[] {
  const imports: ParsedImport[] = [];

  for (const node of findAll(root, ['import_directive'])) {
    const source = node.namedChildren.find((c: any) => c.type === 'string')?.text?.replace(/['"]/g, '') ?? '';
    const specifiers: string[] = [];

    for (const child of node.namedChildren) {
      if (child.type === 'import_clause') {
        for (const spec of child.namedChildren) {
          const n = nameFromField(spec, 'name') ?? spec.text;
          specifiers.push(n);
        }
      }
    }

    if (specifiers.length === 0 && source) {
      specifiers.push(source.split('/').pop()?.replace('.sol', '') ?? source);
    }

    imports.push({ source, specifiers, line: node.startPosition.row + 1 });
  }

  return imports;
}

function solidityExports(_root: any): ParsedExport[] {
  return [];
}

// --- Language Configs ---

const LANGUAGE_CONFIGS: Record<SupportedLanguage, LanguageConfig> = {
  python: {
    grammarName: 'python',
    extractors: { entities: pythonEntities, imports: pythonImports, exports: pythonExports },
  },
  go: {
    grammarName: 'go',
    extractors: { entities: goEntities, imports: goImports, exports: goExports },
  },
  rust: {
    grammarName: 'rust',
    extractors: { entities: rustEntities, imports: rustImports, exports: rustExports },
  },
  java: {
    grammarName: 'java',
    extractors: { entities: javaEntities, imports: javaImports, exports: javaExports },
  },
  solidity: {
    grammarName: 'solidity',
    extractors: { entities: solidityEntities, imports: solidityImports, exports: solidityExports },
  },
};

export class TreeSitterParser implements LanguageParser {
  private readonly language: SupportedLanguage;

  constructor(language: SupportedLanguage) {
    this.language = language;
  }

  async parse(source: string, _filePath: string): Promise<ParseResult> {
    const config = LANGUAGE_CONFIGS[this.language];
    const lang = await getLanguage(config.grammarName);
    const parser = createParser(lang);

    try {
      const tree = parser.parse(source);
      if (!tree) {
        return { entities: [], imports: [], exports: [] };
      }

      try {
        const root = tree.rootNode;
        return {
          entities: config.extractors.entities(root),
          imports: config.extractors.imports(root),
          exports: config.extractors.exports(root),
        };
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  }
}
