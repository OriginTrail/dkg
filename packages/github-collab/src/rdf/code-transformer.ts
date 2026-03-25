/**
 * Code Transformer — converts GitHub git tree entries and parsed code entities to RDF quads.
 *
 * Phase A: File tree indexing (ghcode:File, ghcode:Directory).
 * Phase B: Code entity indexing (ghcode:Class, ghcode:Function, ghcode:Import, etc.).
 * Phase C: Relationship linking (ghcode:imports, ghcode:inherits, ghcode:implements).
 */

import {
  GH, RDF,
  type Quad,
  repoUri, fileUri, directoryUri,
  tripleUri, tripleStr, tripleInt, tripleDateTime, tripleBool,
} from './uri.js';
import { extname } from 'node:path';
import type { ParseResult, ParsedEntity, ParsedImport, ParsedExport } from '../code/parser.js';

/** Language detection from file extension. */
const EXTENSION_LANGUAGE: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.sol': 'Solidity',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.json': 'JSON',
  '.yaml': 'YAML', '.yml': 'YAML',
  '.toml': 'TOML',
  '.md': 'Markdown',
  '.css': 'CSS', '.scss': 'SCSS',
  '.html': 'HTML',
  '.sh': 'Shell', '.bash': 'Shell',
  '.sql': 'SQL',
  '.graphql': 'GraphQL', '.gql': 'GraphQL',
  '.proto': 'Protobuf',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.kt': 'Kotlin', '.kts': 'Kotlin',
  '.c': 'C', '.h': 'C',
  '.cpp': 'C++', '.hpp': 'C++', '.cc': 'C++',
  '.cs': 'C#',
};

export function detectLanguage(filePath: string): string | undefined {
  return EXTENSION_LANGUAGE[extname(filePath).toLowerCase()];
}

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
  url?: string;
}

/**
 * Transform a list of git tree entries into RDF quads.
 *
 * For each blob (file): creates a ghcode:File with path, size, language, directory link, repo link.
 * For each tree (directory): creates a ghcode:Directory with path, parent directory link, repo link.
 */
export function transformFileTree(
  entries: GitTreeEntry[],
  owner: string,
  repo: string,
  graph: string,
): Quad[] {
  const quads: Quad[] = [];
  const repoId = repoUri(owner, repo);
  const now = new Date().toISOString();

  // Collect all directory paths (both explicit tree entries and implicit parent dirs)
  const dirPaths = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'tree') {
      dirPaths.add(entry.path);
    }
  }
  // Also add implicit parent directories from file paths
  for (const entry of entries) {
    if (entry.type === 'blob') {
      const parts = entry.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirPaths.add(parts.slice(0, i).join('/'));
      }
    }
  }

  // Emit directory quads
  for (const dirPath of dirPaths) {
    const uri = directoryUri(owner, repo, dirPath);
    quads.push(
      tripleUri(uri, `${RDF}type`, `${GH}Directory`, graph),
      tripleStr(uri, `${GH}dirPath`, dirPath, graph),
      tripleUri(uri, `${GH}inRepo`, repoId, graph),
    );

    // Link to parent directory
    const lastSlash = dirPath.lastIndexOf('/');
    if (lastSlash > 0) {
      const parentPath = dirPath.substring(0, lastSlash);
      quads.push(tripleUri(uri, `${GH}parentDir`, directoryUri(owner, repo, parentPath), graph));
    }
  }

  // Emit file quads
  for (const entry of entries) {
    if (entry.type !== 'blob') continue;

    const uri = fileUri(owner, repo, entry.path);
    quads.push(
      tripleUri(uri, `${RDF}type`, `${GH}File`, graph),
      tripleStr(uri, `${GH}filePath`, entry.path, graph),
      tripleUri(uri, `${GH}inRepo`, repoId, graph),
      tripleDateTime(uri, `${GH}snapshotAt`, now, graph),
    );

    if (typeof entry.size === 'number') {
      quads.push(tripleInt(uri, `${GH}fileSize`, entry.size, graph));
    }

    const lang = detectLanguage(entry.path);
    if (lang) {
      quads.push(tripleStr(uri, `${GH}language`, lang, graph));
    }

    // Link to containing directory
    const lastSlash = entry.path.lastIndexOf('/');
    if (lastSlash > 0) {
      const dirPath = entry.path.substring(0, lastSlash);
      quads.push(tripleUri(uri, `${GH}inDirectory`, directoryUri(owner, repo, dirPath), graph));
    }
  }

  return quads;
}

// --- Phase B: Code Entity Transformation ---

/** Mint a symbol URI: urn:github:owner/repo/symbol/encodedFilePath#symbolName */
function symbolUri(owner: string, repo: string, filePath: string, symbolName: string): string {
  return `urn:github:${owner}/${repo}/symbol/${encodeURIComponent(filePath)}#${encodeURIComponent(symbolName)}`;
}

/** Map ParsedEntity.kind to an RDF type URI. */
const ENTITY_KIND_TO_TYPE: Record<ParsedEntity['kind'], string> = {
  class: `${GH}Class`,
  interface: `${GH}Interface`,
  function: `${GH}Function`,
  method: `${GH}Method`,
  struct: `${GH}Struct`,
  enum: `${GH}Enum`,
  type: `${GH}TypeAlias`,
  constant: `${GH}Constant`,
  variable: `${GH}Variable`,
};

/**
 * Transform parsed code entities (classes, functions, imports, exports) to RDF quads.
 */
export function transformCodeEntities(
  parseResult: ParseResult,
  filePath: string,
  owner: string,
  repo: string,
  graph: string,
): Quad[] {
  const quads: Quad[] = [];
  const fileId = fileUri(owner, repo, filePath);

  // Entities (classes, functions, etc.)
  for (const entity of parseResult.entities) {
    const qualifiedName = entity.parentClass
      ? `${entity.parentClass}.${entity.name}`
      : entity.name;
    const uri = symbolUri(owner, repo, filePath, qualifiedName);
    const rdfType = ENTITY_KIND_TO_TYPE[entity.kind];

    quads.push(
      tripleUri(uri, `${RDF}type`, rdfType, graph),
      tripleStr(uri, `${GH}name`, entity.name, graph),
      tripleUri(uri, `${GH}definedInFile`, fileId, graph),
      tripleInt(uri, `${GH}startLine`, entity.startLine, graph),
      tripleInt(uri, `${GH}endLine`, entity.endLine, graph),
    );

    if (entity.signature) {
      quads.push(tripleStr(uri, `${GH}signature`, entity.signature, graph));
    }
    if (entity.visibility) {
      quads.push(tripleStr(uri, `${GH}visibility`, entity.visibility, graph));
    }
    if (entity.parentClass) {
      quads.push(tripleStr(uri, `${GH}parentClass`, entity.parentClass, graph));
    }
    if (entity.isAsync) {
      quads.push(tripleBool(uri, `${GH}async`, true, graph));
    }
    if (entity.isExported) {
      quads.push(tripleBool(uri, `${GH}exported`, true, graph));
    }
    if (entity.returnType) {
      quads.push(tripleStr(uri, `${GH}returnType`, entity.returnType, graph));
    }
    if (entity.extends) {
      quads.push(tripleStr(uri, `${GH}extendsName`, entity.extends, graph));
    }
    if (entity.implements && entity.implements.length > 0) {
      for (const impl of entity.implements) {
        quads.push(tripleStr(uri, `${GH}implementsName`, impl, graph));
      }
    }
    if (entity.decorators && entity.decorators.length > 0) {
      for (const dec of entity.decorators) {
        quads.push(tripleStr(uri, `${GH}decorator`, dec, graph));
      }
    }
    if (entity.parameters && entity.parameters.length > 0) {
      for (const param of entity.parameters) {
        quads.push(tripleStr(uri, `${GH}parameter`, param, graph));
      }
    }
  }

  // Imports
  for (let i = 0; i < parseResult.imports.length; i++) {
    const imp = parseResult.imports[i];
    const uri = `${fileId}#import-${i}`;

    quads.push(
      tripleUri(uri, `${RDF}type`, `${GH}Import`, graph),
      tripleStr(uri, `${GH}importSource`, imp.source, graph),
      tripleUri(uri, `${GH}inFile`, fileId, graph),
      tripleInt(uri, `${GH}startLine`, imp.line, graph),
    );

    for (const spec of imp.specifiers) {
      quads.push(tripleStr(uri, `${GH}importedName`, spec, graph));
    }

    if (imp.isTypeOnly) {
      quads.push(tripleBool(uri, `${GH}typeOnly`, true, graph));
    }
  }

  // Exports
  for (let i = 0; i < parseResult.exports.length; i++) {
    const exp = parseResult.exports[i];
    const uri = `${fileId}#export-${i}`;

    quads.push(
      tripleUri(uri, `${RDF}type`, `${GH}Export`, graph),
      tripleStr(uri, `${GH}exportedName`, exp.name, graph),
      tripleStr(uri, `${GH}exportKind`, exp.kind, graph),
      tripleUri(uri, `${GH}inFile`, fileId, graph),
      tripleInt(uri, `${GH}startLine`, exp.line, graph),
    );

    if (exp.isDefault) {
      quads.push(tripleBool(uri, `${GH}defaultExport`, true, graph));
    }
  }

  return quads;
}

// --- Phase C: Relationship Transformation ---

export interface ResolvedRelationship {
  kind: 'imports' | 'inherits' | 'implements';
  sourceUri: string;
  targetUri: string;
}

/**
 * Transform resolved relationships to RDF quads.
 */
export function transformRelationships(
  relationships: ResolvedRelationship[],
  graph: string,
): Quad[] {
  const quads: Quad[] = [];

  for (const rel of relationships) {
    const predicate = rel.kind === 'imports' ? `${GH}imports`
      : rel.kind === 'inherits' ? `${GH}inherits`
      : `${GH}implements`;

    quads.push(tripleUri(rel.sourceUri, predicate, rel.targetUri, graph));
  }

  return quads;
}
