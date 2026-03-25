/**
 * Relationship Extractor — resolves cross-file relationships after parsing.
 *
 * Phase C:
 * - Import resolution: match import sources to file URIs
 * - Inheritance: resolve extends/implements references to symbol URIs
 */

import { fileUri } from '../rdf/uri.js';
import type { ResolvedRelationship } from '../rdf/code-transformer.js';
import type { ParseResult, ParsedEntity } from './parser.js';

/** Index of all parsed files and their entities. */
export interface ParsedFileIndex {
  /** Map of normalized file path to parse result. */
  files: Map<string, ParseResult>;
  /** Map of normalized file path to all entity names exported from that file. */
  exportedSymbols: Map<string, Set<string>>;
}

/**
 * Build a file index from all parsed results.
 */
export function buildFileIndex(
  parsedFiles: Map<string, ParseResult>,
): ParsedFileIndex {
  const exportedSymbols = new Map<string, Set<string>>();

  for (const [filePath, result] of parsedFiles) {
    const symbols = new Set<string>();
    for (const entity of result.entities) {
      if (entity.isExported) {
        symbols.add(entity.name);
      }
    }
    for (const exp of result.exports) {
      symbols.add(exp.name);
    }
    exportedSymbols.set(filePath, symbols);
  }

  return { files: parsedFiles, exportedSymbols };
}

/**
 * Resolve an import source to a file path in the index.
 *
 * Handles:
 * - Relative imports (./foo, ../bar)
 * - Extension resolution (.ts, .tsx, .js, .jsx)
 * - Index file resolution (./dir -> ./dir/index.ts)
 */
function resolveImportPath(
  importSource: string,
  importingFilePath: string,
  fileIndex: Set<string>,
): string | undefined {
  // Only resolve relative imports
  if (!importSource.startsWith('.')) return undefined;

  // Compute the base directory of the importing file
  const lastSlash = importingFilePath.lastIndexOf('/');
  const dir = lastSlash > 0 ? importingFilePath.substring(0, lastSlash) : '';

  // Resolve the relative path
  const parts = (dir ? dir + '/' + importSource : importSource).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') { resolved.pop(); continue; }
    resolved.push(part);
  }
  const basePath = resolved.join('/');

  // Try various extensions and index files
  const candidates = [
    basePath,
    `${basePath}.ts`, `${basePath}.tsx`,
    `${basePath}.js`, `${basePath}.jsx`,
    `${basePath}/index.ts`, `${basePath}/index.tsx`,
    `${basePath}/index.js`, `${basePath}/index.jsx`,
  ];

  // Also handle .js -> .ts mapping (common in TS with Node16 moduleResolution)
  if (basePath.endsWith('.js')) {
    const tsBase = basePath.slice(0, -3);
    candidates.push(`${tsBase}.ts`, `${tsBase}.tsx`);
  }

  for (const candidate of candidates) {
    if (fileIndex.has(candidate)) return candidate;
  }

  return undefined;
}

/**
 * Extract all cross-file relationships from the parsed file index.
 */
export function extractRelationships(
  index: ParsedFileIndex,
  owner: string,
  repo: string,
): ResolvedRelationship[] {
  const relationships: ResolvedRelationship[] = [];
  const allPaths = new Set(index.files.keys());

  // Build a map of entity name -> [filePath, entity] for cross-file resolution
  const entityByName = new Map<string, { filePath: string; entity: ParsedEntity }[]>();
  for (const [filePath, result] of index.files) {
    for (const entity of result.entities) {
      if (!entity.isExported) continue;
      const entries = entityByName.get(entity.name) ?? [];
      entries.push({ filePath, entity });
      entityByName.set(entity.name, entries);
    }
  }

  for (const [filePath, result] of index.files) {
    const sourceFileUri = fileUri(owner, repo, filePath);

    // 1. Import resolution: file-to-file import edges
    for (const imp of result.imports) {
      const targetPath = resolveImportPath(imp.source, filePath, allPaths);
      if (targetPath) {
        const targetFileUri = fileUri(owner, repo, targetPath);
        relationships.push({
          kind: 'imports',
          sourceUri: sourceFileUri,
          targetUri: targetFileUri,
        });
      }
    }

    // 2. Inheritance/implements resolution
    for (const entity of result.entities) {
      if (!entity.extends && (!entity.implements || entity.implements.length === 0)) continue;

      const qualifiedName = entity.parentClass
        ? `${entity.parentClass}.${entity.name}`
        : entity.name;
      const entitySymbolUri = `urn:github:${owner}/${repo}/symbol/${encodeURIComponent(filePath)}#${encodeURIComponent(qualifiedName)}`;

      // Resolve extends
      if (entity.extends) {
        const targetSymbol = resolveSymbol(entity.extends, filePath, result, index, owner, repo);
        if (targetSymbol) {
          relationships.push({
            kind: 'inherits',
            sourceUri: entitySymbolUri,
            targetUri: targetSymbol,
          });
        }
      }

      // Resolve implements
      if (entity.implements) {
        for (const impl of entity.implements) {
          const targetSymbol = resolveSymbol(impl, filePath, result, index, owner, repo);
          if (targetSymbol) {
            relationships.push({
              kind: 'implements',
              sourceUri: entitySymbolUri,
              targetUri: targetSymbol,
            });
          }
        }
      }
    }
  }

  return relationships;
}

/**
 * Resolve a symbol name to a symbol URI.
 * First checks the same file, then follows imports.
 */
function resolveSymbol(
  symbolName: string,
  currentFile: string,
  currentResult: ParseResult,
  index: ParsedFileIndex,
  owner: string,
  repo: string,
): string | undefined {
  // Check same file first
  const localMatch = currentResult.entities.find(e => e.name === symbolName);
  if (localMatch) {
    return `urn:github:${owner}/${repo}/symbol/${encodeURIComponent(currentFile)}#${encodeURIComponent(symbolName)}`;
  }

  // Check imports: find which import brings this symbol in
  const allPaths = new Set(index.files.keys());
  for (const imp of currentResult.imports) {
    if (!imp.specifiers.includes(symbolName)) continue;

    // Resolve the import to a file path
    const targetPath = resolveImportPath(imp.source, currentFile, allPaths);
    if (targetPath) {
      // Check if the target file exports this symbol
      const exported = index.exportedSymbols.get(targetPath);
      if (exported?.has(symbolName)) {
        return `urn:github:${owner}/${repo}/symbol/${encodeURIComponent(targetPath)}#${encodeURIComponent(symbolName)}`;
      }
    }
  }

  return undefined;
}
