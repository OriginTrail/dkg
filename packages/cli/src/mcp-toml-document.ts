import { isDeepStrictEqual } from 'node:util';
import TOML from '@iarna/toml';
import {
  parse as parseTomlCst,
  type ArrayTableCstNode,
  type ExpressionCstNode,
  type KeyCstNode,
  type KeyvalCstNode,
  type StdTableCstNode,
  type TableCstNode,
  type TomlCstNode,
  type ValCstNode,
} from '@toml-tools/parser';
import { applyRegistrationEditToBody, DKG_SERVER_KEY, type McpClientConfigShape, type McpConfigDocumentAdapter, type McpDocumentEditResult, type PersistedRegistration, type RegistrationEdit } from './mcp-config-document.js';

export const tomlDocumentAdapter: McpConfigDocumentAdapter = {
  parse: source => source.trim() ? TOML.parse(source) : {},
  applyEdit(source, edit, container) {
    const original = tomlDocumentAdapter.parse(source);
    const body = applyRegistrationEditToBody(original, edit, container);
    if (body === original) return { content: source };
    return applyTomlConfigEdit(container, body, edit, source, original[container]);
  },
};

function serialiseTomlEntryOnly(
  serverContainer: McpClientConfigShape['serverContainer'],
  registration: PersistedRegistration,
): string {
  const nested: Record<string, unknown> = {
    [serverContainer]: { [DKG_SERVER_KEY]: registration },
  };
  return TOML.stringify(nested as TOML.JsonMap);
}

type SourceToken = KeyCstNode['children']['IKey'][number];
type RangedSourceToken = SourceToken & { endOffset: number };

interface TomlTableSection {
  path: string[];
  expressionIndex: number;
  start: number;
}

function checkedToken(token: SourceToken | undefined, context: string): RangedSourceToken {
  const endOffset = token?.endOffset;
  if (!token || typeof token.image !== 'string'
      || !Number.isInteger(token.startOffset) || typeof endOffset !== 'number'
      || !Number.isInteger(endOffset)
      || token.startOffset < 0 || endOffset < token.startOffset) {
    throw new Error(`TOML parser returned a missing source range for ${context}`);
  }
  return token as RangedSourceToken;
}

function valueEnd(value: ValCstNode): number {
  const scalar = [
    value.children.IString?.[0],
    value.children.IBoolean?.[0],
    value.children.IDateTime?.[0],
    value.children.IFloat?.[0],
    value.children.IInteger?.[0],
  ].find((token) => token !== undefined);
  if (scalar) return checkedToken(scalar, 'scalar value').endOffset + 1;
  const array = value.children.array?.[0];
  if (array) return checkedToken(array.children.RSquare?.at(-1), 'array value').endOffset + 1;
  const inlineTable = value.children.inlineTable?.[0];
  if (inlineTable) return checkedToken(inlineTable.children.RCurly?.at(-1), 'inline-table value').endOffset + 1;
  throw new Error('TOML parser returned a value without a source range');
}

function keyvalEnd(keyval: KeyvalCstNode): number {
  const value = keyval.children.val?.[0];
  if (!value) throw new Error('TOML parser returned an incomplete key/value expression');
  return valueEnd(value);
}

function tableHeader(table: TableCstNode): StdTableCstNode | ArrayTableCstNode {
  const header = table.children.stdTable?.[0] ?? table.children.arrayTable?.[0];
  if (!header) throw new Error('TOML parser returned an incomplete table header');
  return header;
}

function tableHeaderStart(header: StdTableCstNode | ArrayTableCstNode): number {
  return checkedToken(header.children.LSquare?.[0], 'table header').startOffset;
}

function tableHeaderEnd(header: StdTableCstNode | ArrayTableCstNode): number {
  return checkedToken(header.children.RSquare?.at(-1), 'table header').endOffset + 1;
}

/** Read only the documented grammar alternatives used by editable expressions. */
function expressionEnd(expression: ExpressionCstNode): number {
  const keyval = expression.children.keyval?.[0];
  if (keyval) return keyvalEnd(keyval);
  const table = expression.children.table?.[0];
  if (table) return tableHeaderEnd(tableHeader(table));
  throw new Error('TOML parser returned an expression without a source range');
}

function endOfSourceLine(raw: string, offset: number): number {
  let cursor = offset;
  while (cursor < raw.length && raw[cursor] !== '\n' && raw[cursor] !== '\r') cursor++;
  if (raw[cursor] === '\r' && raw[cursor + 1] === '\n') return cursor + 2;
  return cursor < raw.length ? cursor + 1 : cursor;
}

/** Decode quoted/unquoted TOML keys with the semantic parser, not local grammar. */
function decodeTomlKey(keyImage: string): string {
  const parsed = TOML.parse(`${keyImage} = 0`);
  const keys = Object.keys(parsed);
  if (keys.length !== 1) throw new Error('TOML parser returned an invalid table key');
  return keys[0]!;
}

function tablePath(key: KeyCstNode): string[] {
  return key.children.IKey.map(token => decodeTomlKey(token.image));
}

function tableSections(document: TomlCstNode): TomlTableSection[] {
  const sections: TomlTableSection[] = [];
  for (const [expressionIndex, expression] of (document.children.expression ?? []).entries()) {
    const table = expression.children.table?.[0];
    if (!table) continue;
    const header = tableHeader(table);
    const key = header?.children.key?.[0];
    if (!key) throw new Error('TOML parser returned an incomplete table header');
    sections.push({
      path: tablePath(key),
      expressionIndex,
      start: tableHeaderStart(header),
    });
  }
  return sections;
}

function pathStartsWith(path: string[], prefix: string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => path[index] === part);
}

function normaliseNewlines(text: string, newline: string): string {
  return text.replace(/\r\n|\n|\r/g, newline);
}

function appendTomlTable(raw: string, replacement: string, newline: string): string {
  if (!raw.trim()) return replacement;
  let out = raw;
  if (!out.endsWith('\n') && !out.endsWith('\r')) out += newline;
  if (!out.endsWith(`${newline}${newline}`)) out += newline;
  return out + replacement;
}

function replaceTomlTable(
  raw: string,
  serverContainer: McpClientConfigShape['serverContainer'],
  edit: { kind: 'upsert'; block: string } | { kind: 'remove' },
  parsedRawHasOwnedEntry: boolean,
  parsedRawHasOwnedParent: boolean,
): string | null {
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const ownedPath = [serverContainer, DKG_SERVER_KEY];
  const parentPath = [serverContainer];
  const replacementBlock = edit.kind === 'remove' ? '' : normaliseNewlines(
    edit.block.endsWith('\n') || edit.block.endsWith('\r')
      ? edit.block
      : edit.block + newline,
    newline,
  );
  const document = parseTomlCst(raw) as TomlCstNode;
  const expressions = document.children.expression ?? [];
  const sections = tableSections(document);
  const hasRootTable = sections.some(section => section.path.length === ownedPath.length
    && pathStartsWith(section.path, ownedPath));
  const hasParentTableFamily = sections.some(section => pathStartsWith(section.path, parentPath));
  const ranges: { start: number; end: number }[] = [];

  for (const [index, section] of sections.entries()) {
    if (!pathStartsWith(section.path, ownedPath)) continue;
    const nextSection = sections[index + 1];
    const nextIsOwned = nextSection && pathStartsWith(nextSection.path, ownedPath);
    const sectionExpressionEnd = nextSection?.expressionIndex ?? expressions.length;
    const substantiveExpressions = expressions
      .slice(section.expressionIndex, sectionExpressionEnd)
      .filter(expression => expression.children.table?.length || expression.children.keyval?.length);
    const lastSubstantive = substantiveExpressions.at(-1);
    if (!lastSubstantive) throw new Error('TOML parser returned an empty table section');
    ranges.push({
      start: section.start,
      // Trivia between adjacent owned tables is owned too. Before a sibling,
      // retain standalone comments/blank lines that may document that sibling.
      end: nextIsOwned ? nextSection.start : endOfSourceLine(raw, expressionEnd(lastSubstantive)),
    });
  }

  if (parsedRawHasOwnedEntry && !hasRootTable) {
    return null;
  }

  if (parsedRawHasOwnedParent && !hasParentTableFamily && ranges.length === 0) {
    return null;
  }

  if (ranges.length === 0) {
    return edit.kind === 'upsert' ? appendTomlTable(raw, replacementBlock, newline) : raw;
  }

  const mergedRanges: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const previous = mergedRanges.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else mergedRanges.push({ ...range });
  }

  let out = '';
  let cursor = 0;
  for (const [index, range] of mergedRanges.entries()) {
    out += raw.slice(cursor, range.start);
    if (index === 0) out += replacementBlock;
    cursor = range.end;
  }
  return out + raw.slice(cursor);
}

function tomlRawHasContainer(raw: string, container: McpClientConfigShape['serverContainer']): boolean {
  try { return raw.trim() !== '' && TOML.parse(raw)[container] !== undefined; }
  catch { return false; }
}

function applyTomlConfigEdit(
  serverContainer: McpClientConfigShape['serverContainer'],
  body: Record<string, unknown>,
  edit: RegistrationEdit,
  raw: string,
  rawContainer: unknown,
): McpDocumentEditResult {
  const ownedPath = `${serverContainer}.${DKG_SERVER_KEY}`;
  const tableEdit = edit.kind === 'remove' ? edit
    : { kind: 'upsert' as const, block: serialiseTomlEntryOnly(serverContainer, edit.registration) };
  let patched = replaceTomlTable(
    raw,
    serverContainer,
    tableEdit,
    rawContainer !== null && typeof rawContainer === 'object' && Object.hasOwn(rawContainer, DKG_SERVER_KEY),
    rawContainer !== undefined,
  );
  if (edit.kind === 'remove' && patched !== null
      && !tomlRawHasContainer(patched, serverContainer)) {
    // Keep the empty server container when its last child table was removed.
    const parentOnly = { [serverContainer]: {} };
    patched = appendTomlTable(patched, TOML.stringify(parentOnly as TOML.JsonMap),
      raw.includes('\r\n') ? '\r\n' : '\n');
  }
  // The parser is authoritative: a formatting-preserving patch must describe
  // exactly the intended edit, including all unrelated string/table values.
  if (patched !== null) {
    try {
      if (!isDeepStrictEqual(TOML.parse(patched), body)) patched = null;
    } catch {
      patched = null;
    }
  }
  return {
    content: patched ?? TOML.stringify(body as TOML.JsonMap),
    ...(patched === null ? {
      warning: `uses a TOML shape that cannot be patched safely for ${ownedPath}; ` +
        'rewriting the TOML file to avoid invalid or duplicate definitions. ' +
        'Comments/formatting outside this entry may not be preserved.',
    } : {}),
  };
}
