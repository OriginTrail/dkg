/**
 * Language Parser interfaces for code entity extraction.
 *
 * Parsers extract structural entities (classes, functions, imports, exports)
 * from source code. Results are converted to RDF quads by the code transformer.
 */

export interface ParsedEntity {
  kind: 'class' | 'interface' | 'function' | 'method' | 'struct' | 'enum' | 'type' | 'constant' | 'variable';
  name: string;
  startLine: number;
  endLine: number;
  signature?: string;
  visibility?: string;
  parentClass?: string;
  parameters?: string[];
  returnType?: string;
  decorators?: string[];
  isAsync?: boolean;
  isExported?: boolean;
  extends?: string;
  implements?: string[];
}

export interface ParsedImport {
  source: string;
  specifiers: string[];
  line: number;
  isTypeOnly?: boolean;
}

export interface ParsedExport {
  name: string;
  kind: string;
  line: number;
  isDefault?: boolean;
}

export interface ParseResult {
  entities: ParsedEntity[];
  imports: ParsedImport[];
  exports: ParsedExport[];
}

export interface LanguageParser {
  parse(source: string, filePath: string): Promise<ParseResult>;
}
