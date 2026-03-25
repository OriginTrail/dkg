/**
 * Parser Registry — maps file extensions to the appropriate language parser.
 */

import { extname } from 'node:path';
import type { LanguageParser } from './parser.js';
import { TypeScriptParser } from './typescript-parser.js';
import { TreeSitterParser } from './tree-sitter-parser.js';

const tsParser = new TypeScriptParser();

const EXTENSION_PARSER: Record<string, LanguageParser> = {
  '.ts': tsParser,
  '.tsx': tsParser,
  '.js': tsParser,
  '.jsx': tsParser,
  '.mjs': tsParser,
  '.cjs': tsParser,
  '.py': new TreeSitterParser('python'),
  '.go': new TreeSitterParser('go'),
  '.rs': new TreeSitterParser('rust'),
  '.java': new TreeSitterParser('java'),
  '.sol': new TreeSitterParser('solidity'),
};

/** Get a parser for the given file path, or undefined if unsupported. */
export function getParser(filePath: string): LanguageParser | undefined {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_PARSER[ext];
}

/** Check whether a file path has a supported parser. */
export function isParseable(filePath: string): boolean {
  return getParser(filePath) !== undefined;
}

/** List of extensions that have parsers available. */
export const PARSEABLE_EXTENSIONS = new Set(Object.keys(EXTENSION_PARSER));
