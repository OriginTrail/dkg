import { isDeepStrictEqual } from 'node:util';
import { applyEdits, createScanner, findNodeAtLocation, modify, parse as parseJsonc, parseTree, type Edit, type ParseError } from 'jsonc-parser';
import { applyRegistrationEditToBody, DKG_SERVER_KEY, isPlainRecord, type McpClientConfigShape, type McpConfigDocumentAdapter, type McpDocumentEditResult, type RegistrationEdit } from './mcp-config-document.js';

function jsonAdapter(format: 'json' | 'jsonc'): McpConfigDocumentAdapter {
  function parse(source: string): Record<string, unknown> {
    if (!source.trim()) return {};
    const errors: ParseError[] = [];
    const parsed: unknown = format === 'jsonc'
      ? parseJsonc(source, errors, { allowTrailingComma: true }) : JSON.parse(source);
    if (errors.length > 0) throw new Error('Invalid JSONC');
    if (!isPlainRecord(parsed)) throw new Error('MCP config root must be an object');
    return parsed;
  }
  return {
    parse,
    applyEdit(source, edit, container) {
      const original = parse(source);
      const body = applyRegistrationEditToBody(original, edit, container);
      if (body === original) return { content: source };
      return applyJsonDocumentEdit(format, container, body, edit, source);
    },
  };
}

export const jsonDocumentAdapter = jsonAdapter('json');
export const jsoncDocumentAdapter = jsonAdapter('jsonc');

/** Remove the owned property/comma only; comments preceding siblings belong to them. */
function removeJsonEntry(raw: string, path: string[], allowTrailingComma: boolean): string {
  const tree = parseTree(raw, [], { allowTrailingComma, disallowComments: !allowTrailingComma });
  const property = tree && findNodeAtLocation(tree, path)?.parent;
  if (property?.type !== 'property') throw new Error('JSON registration property was not found');
  const edits: Edit[] = [{ offset: property.offset, length: property.length, content: '' }];
  const scanner = createScanner(raw, true);
  scanner.setPosition(property.offset + property.length);
  scanner.scan();
  if (raw.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()) === ',') {
    edits.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), content: '' });
  }
  else if (!allowTrailingComma) {
    // Strict JSON cannot retain a preceding comma when the last property goes.
    const siblings = property.parent?.children ?? [];
    const previous = siblings[siblings.indexOf(property) - 1];
    if (previous) {
      scanner.setPosition(previous.offset + previous.length);
      scanner.scan();
      if (raw.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()) !== ',') {
        throw new Error('JSON registration separator was not found');
      }
      edits.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), content: '' });
    }
  }
  // JSONC may retain a preceding trailing comma and adjacent sibling comments.
  return applyEdits(raw, edits);
}

/** Add one property without asking jsonc-parser to reformat sibling values. */
function addJsoncObjectProperty(
  raw: string,
  containerPath: string[],
  name: string,
  value: unknown,
): string | null {
  const tree = parseTree(raw, [], { allowTrailingComma: true });
  const container = tree && findNodeAtLocation(tree, containerPath);
  if (container?.type !== 'object') return null;
  const closingOffset = container.offset + container.length - 1;
  if (raw[closingOffset] !== '}') return null;
  const closingLineStart = raw.lastIndexOf('\n', closingOffset - 1) + 1;
  const closingIndent = raw.slice(closingLineStart, closingOffset);
  if (!/^[\t ]*$/.test(closingIndent)) return null;

  const properties = container.children ?? [];
  const first = properties[0];
  let propertyIndent = `${closingIndent}  `;
  if (first) {
    const firstLineStart = raw.lastIndexOf('\n', first.offset - 1) + 1;
    const candidate = raw.slice(firstLineStart, first.offset);
    if (!/^[\t ]*$/.test(candidate)) return null;
    propertyIndent = candidate;
  }

  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const encodedLines = JSON.stringify(value, null, 2).split('\n');
  const encoded = encodedLines.join(`${newline}${propertyIndent}`);
  const edits: Edit[] = [];
  let retainTrailingComma = false;
  const last = properties.at(-1);
  if (last) {
    const scanner = createScanner(raw, true);
    scanner.setPosition(last.offset + last.length);
    scanner.scan();
    retainTrailingComma = raw.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()) === ',';
    if (!retainTrailingComma) edits.push({ offset: last.offset + last.length, length: 0, content: ',' });
  }
  edits.push({
    offset: closingLineStart,
    length: 0,
    content: `${propertyIndent}${JSON.stringify(name)}: ${encoded}${retainTrailingComma ? ',' : ''}${newline}`,
  });
  return applyEdits(raw, edits);
}

/** Edit only the owned source range, preserving numeric lexemes and JSONC trivia. */
function applyJsonDocumentEdit(
  format: 'json' | 'jsonc',
  serverContainer: McpClientConfigShape['serverContainer'],
  body: Record<string, unknown>,
  edit: RegistrationEdit,
  source: string,
): McpDocumentEditResult {
  if (format === 'json' && edit.kind === 'upsert') return { content: JSON.stringify(body, null, 2) + '\n' };
  const raw = source.trim() ? source : '{}';
  const allowTrailingComma = format === 'jsonc';
  let patched: string;
  if (edit.kind === 'remove') {
    patched = removeJsonEntry(raw, [serverContainer, DKG_SERVER_KEY], allowTrailingComma);
  } else {
    const tree = parseTree(raw, [], { allowTrailingComma: true });
    const existing = tree ? findNodeAtLocation(tree, [serverContainer, DKG_SERVER_KEY]) : undefined;
    const losslessAddition = allowTrailingComma && existing === undefined
      ? addJsoncObjectProperty(raw, [serverContainer], DKG_SERVER_KEY, edit.registration)
      : null;
    patched = losslessAddition ?? applyEdits(raw, modify(raw, [serverContainer, DKG_SERVER_KEY], edit.registration, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: raw.includes('\r\n') ? '\r\n' : '\n' },
    }));
  }
  const errors: ParseError[] = [];
  const parsed = parseJsonc(patched, errors, { allowTrailingComma, disallowComments: !allowTrailingComma });
  if (errors.length > 0 || !isDeepStrictEqual(parsed, body)) {
    throw new Error(`Cannot safely edit ${format.toUpperCase()} registration`);
  }
  return { content: patched };
}
