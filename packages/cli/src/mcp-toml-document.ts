import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import TOML from '@iarna/toml';
import { parse as parseTomlCst, type ExpressionCstNode, type KeyCstNode, type TomlCstNode } from '@toml-tools/parser';
import { DKG_SERVER_KEY, tildify, type ClientTarget } from './mcp-client-registry.js';
import { writeMcpConfigAtomic } from './mcp-config-file.js';
import type { DesiredRegistration, RegistrationEdit } from './mcp-client-config.js';

/**
 * PR #443 round-5 Codex Review: mirror `readJson`'s friendly-recovery
 * wrapping for the TOML branch. `@iarna/toml`'s parse error includes
 * line/column info but no path and no suggested next-step; an
 * operator hitting a malformed `~/.codex/config.toml` would see the
 * raw library message and abort the entire `dkg mcp setup` flow with
 * no clear recovery path. Wrap with the same shape JSON uses so the
 * operator-facing error names the file and the move-it-aside
 * recovery procedure.
 */
export function readToml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  // `@iarna/toml`'s parser returns `{}` for an all-whitespace file
  // already, but normalising empty-string up front mirrors readJson
  // and skips the parse call for the common parent-dir-only-detected
  // first-write case.
  if (!raw.trim()) return {};
  try {
    const parsed = TOML.parse(raw);
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(
      `Existing file is not valid TOML: ${tildify(path)}. Move it aside and re-run.`,
    );
  }
}

function serialiseTomlEntryOnly(
  target: ClientTarget,
  registration: DesiredRegistration,
): string {
  const nested: Record<string, unknown> = {
    [target.serverContainer]: { [DKG_SERVER_KEY]: registration },
  };
  return TOML.stringify(nested as TOML.JsonMap);
}

interface SourceToken {
  image: string;
  startOffset: number;
  endOffset: number;
}

interface TomlTableSection {
  path: string[];
  expressionIndex: number;
  start: number;
}

function isSourceToken(value: unknown): value is SourceToken {
  return value !== null && typeof value === 'object'
    && typeof (value as SourceToken).image === 'string'
    && typeof (value as SourceToken).startOffset === 'number'
    && typeof (value as SourceToken).endOffset === 'number';
}

/** Walk a parser-owned CST node; source ranges always come from its tokens. */
function sourceTokens(value: unknown): SourceToken[] {
  if (isSourceToken(value)) return [value];
  if (value === null || typeof value !== 'object') return [];
  const children = (value as { children?: Record<string, unknown[]> }).children;
  if (!children) return [];
  return Object.values(children).flatMap(items => (items ?? []).flatMap(sourceTokens));
}

function expressionEnd(expression: ExpressionCstNode): number {
  const tokens = sourceTokens(expression);
  return Math.max(...tokens.map(token => token.endOffset + 1));
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
    const header = table.children.stdTable?.[0] ?? table.children.arrayTable?.[0];
    const key = header?.children.key?.[0];
    if (!header || !key) throw new Error('TOML parser returned an incomplete table header');
    const tokens = sourceTokens(header);
    sections.push({
      path: tablePath(key),
      expressionIndex,
      start: Math.min(...tokens.map(token => token.startOffset)),
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
  serverContainer: ClientTarget['serverContainer'],
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

function tomlRawHasContainer(raw: string, container: ClientTarget['serverContainer']): boolean {
  try { return raw.trim() !== '' && TOML.parse(raw)[container] !== undefined; }
  catch { return false; }
}

export function writeTomlConfigEdit(
  target: ClientTarget,
  body: Record<string, unknown>,
  edit: RegistrationEdit,
): void {
  const raw = existsSync(target.configPath)
    ? readFileSync(target.configPath, 'utf8')
    : '';
  const ownedPath = `${target.serverContainer}.${DKG_SERVER_KEY}`;
  const tableEdit = edit.kind === 'remove' ? edit
    : { kind: 'upsert' as const, block: serialiseTomlEntryOnly(target, edit.registration) };
  const rawContainer = raw.trim() ? TOML.parse(raw)[target.serverContainer] : undefined;
  let patched = replaceTomlTable(
    raw,
    target.serverContainer,
    tableEdit,
    rawContainer !== null && typeof rawContainer === 'object' && Object.hasOwn(rawContainer, DKG_SERVER_KEY),
    rawContainer !== undefined,
  );
  if (edit.kind === 'remove' && patched !== null
      && !tomlRawHasContainer(patched, target.serverContainer)) {
    // Keep the empty server container when its last child table was removed.
    const parentOnly = { [target.serverContainer]: {} };
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
  if (patched === null) {
    process.stderr.write(
      `[mcp-config] WARNING: ${target.name} config at ${tildify(target.configPath)} ` +
        `uses a TOML shape that cannot be patched safely for ${ownedPath}; ` +
        'rewriting the TOML file to avoid invalid or duplicate definitions. ' +
        'Comments/formatting outside this entry may not be preserved.\n',
    );
  }
  writeMcpConfigAtomic(
    target.configPath,
    patched ?? TOML.stringify(body as TOML.JsonMap),
    target.location,
  );
}
