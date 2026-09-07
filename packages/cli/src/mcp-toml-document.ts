import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import TOML from '@iarna/toml';
import { tildify, type ClientTarget } from './mcp-client-registry.js';
import { splitEntryPath, ensurePathContainer, readEntryAt } from './mcp-config-path.js';
import { writeMcpConfigAtomic, type RegistrationEdit } from './mcp-config-file.js';

/** TOML syntax, source preservation and parser-validated fallback live behind this adapter. */
export class TomlRegistrationDocument {
  constructor(private readonly target: ClientTarget) {}

  read(): Record<string, unknown> {
    return readToml(this.target.configPath);
  }

  write(body: Record<string, unknown>, edit: RegistrationEdit): void {
    writeTomlConfigBody(this.target, body, edit);
  }
}

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
function readToml(path: string): Record<string, unknown> {
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
  body: Record<string, unknown>,
): string {
  const nested: Record<string, unknown> = {};
  const { head, leaf } = splitEntryPath(target.entryPath);
  const container = ensurePathContainer(nested, head);
  container[leaf] = readEntryAt(body, target.entryPath) ?? {};
  return TOML.stringify(nested as TOML.JsonMap);
}

interface TomlLine {
  text: string;
  eol: string;
}

function splitTomlLines(raw: string): TomlLine[] {
  const lines: TomlLine[] = [];
  const re = /(.*?)(\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    if (match[0] === '') break;
    lines.push({ text: match[1], eol: match[2] });
  }
  return lines;
}

function splitTomlKeyPath(path: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of path) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
      continue;
    }
    if (ch === '.') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.map((part) => {
    if (
      part.length >= 2 &&
      ((part.startsWith('"') && part.endsWith('"')) ||
        (part.startsWith("'") && part.endsWith("'")))
    ) {
      return part.slice(1, -1);
    }
    return part;
  });
}

const TOML_PATH_SEPARATOR = '\0';

function normaliseTomlHeaderPath(path: string): string {
  return splitTomlKeyPath(path).join(TOML_PATH_SEPARATOR);
}

function normaliseTomlOwnedPath(path: string): string {
  return path.split('.').filter(Boolean).join(TOML_PATH_SEPARATOR);
}

function tomlParentPath(path: string): string | null {
  const parts = path.split('.').filter(Boolean);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join('.');
}

function tomlTableHeaderPath(line: string): string | null {
  const arrayMatch = line.match(/^\s*\[\[\s*(.+?)\s*\]\]\s*(?:#.*)?$/);
  if (arrayMatch) return normaliseTomlHeaderPath(arrayMatch[1]);
  const tableMatch = line.match(/^\s*\[\s*(.+?)\s*\]\s*(?:#.*)?$/);
  if (tableMatch) return normaliseTomlHeaderPath(tableMatch[1]);
  return null;
}

function ownsTomlTablePath(path: string, ownedPath: string): boolean {
  return path === ownedPath || path.startsWith(`${ownedPath}${TOML_PATH_SEPARATOR}`);
}

type TomlMultilineDelimiter = '"""' | "'''";

function advanceTomlMultilineDelimiter(
  line: string,
  state: TomlMultilineDelimiter | null,
): TomlMultilineDelimiter | null {
  let i = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  while (i < line.length) {
    if (state) {
      // In a multiline basic string, an escaped quote cannot begin the
      // closing delimiter. Literal multiline strings have no escapes.
      if (state === '"""' && line[i] === '\\') {
        i += 2;
      } else if (line.startsWith(state, i)) {
        i += state.length;
        state = null;
      } else {
        i++;
      }
      continue;
    }

    const ch = line[i];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        quote = null;
      }
      i++;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (ch === '#') break;
    if (line.startsWith('"""', i)) {
      state = '"""';
      i += 3;
      continue;
    }
    if (line.startsWith("'''", i)) {
      state = "'''";
      i += 3;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    i++;
  }

  return state;
}

function tomlTableHeaderPaths(lines: TomlLine[]): Array<string | null> {
  let multilineDelimiter: TomlMultilineDelimiter | null = null;
  return lines.map((line) => {
    const headerPath = multilineDelimiter ? null : tomlTableHeaderPath(line.text);
    multilineDelimiter = advanceTomlMultilineDelimiter(line.text, multilineDelimiter);
    return headerPath;
  });
}

function isTomlCommentOrBlank(line: TomlLine): boolean {
  const trimmed = line.text.trim();
  return trimmed === '' || trimmed.startsWith('#');
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
  ownedPath: string,
  edit: { kind: 'upsert'; block: string } | { kind: 'remove' },
  parsedRawHasOwnedEntry: boolean,
  parsedRawHasOwnedParent: boolean,
): string | null {
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const ownedPathKey = normaliseTomlOwnedPath(ownedPath);
  const parentPathKey = tomlParentPath(ownedPath);
  const normalisedParentPathKey = parentPathKey
    ? normaliseTomlOwnedPath(parentPathKey)
    : null;
  const replacementBlock = edit.kind === 'remove' ? '' : normaliseNewlines(
    edit.block.endsWith('\n') || edit.block.endsWith('\r')
      ? edit.block
      : edit.block + newline,
    newline,
  );
  const lines = splitTomlLines(raw);
  const headerPaths = tomlTableHeaderPaths(lines);
  const ranges: { start: number; end: number }[] = [];
  let hasRootTable = false;
  let hasParentTableFamily = normalisedParentPathKey === null;

  for (let i = 0; i < lines.length; i++) {
    const headerPath = headerPaths[i];
    if (!headerPath) continue;
    if (
      normalisedParentPathKey &&
      ownsTomlTablePath(headerPath, normalisedParentPathKey)
    ) {
      hasParentTableFamily = true;
    }
    if (!ownsTomlTablePath(headerPath, ownedPathKey)) continue;
    if (headerPath === ownedPathKey) hasRootTable = true;
    let end = i + 1;
    while (end < lines.length && headerPaths[end] === null) {
      end++;
    }
    let replaceEnd = end;
    while (replaceEnd > i + 1 && isTomlCommentOrBlank(lines[replaceEnd - 1])) {
      replaceEnd--;
    }
    ranges.push({ start: i, end: replaceEnd });
    i = end - 1;
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

  let inserted = false;
  let rangeIndex = 0;
  let out = '';
  for (let i = 0; i < lines.length;) {
    const range = ranges[rangeIndex];
    if (range && i === range.start) {
      if (!inserted) {
        out += replacementBlock;
        inserted = true;
      }
      i = range.end;
      rangeIndex++;
      continue;
    }
    out += lines[i].text + lines[i].eol;
    i++;
  }
  return out;
}

function readPathAt(body: Record<string, unknown>, path: string | undefined): unknown {
  if (!path) return undefined;
  let cursor: unknown = body;
  for (const segment of path.split('.').filter(Boolean)) {
    if (cursor === undefined || cursor === null || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function tomlRawHasEntry(raw: string, entryPath: ClientTarget['entryPath']): boolean {
  if (!raw.trim()) return false;
  try {
    const parsed = TOML.parse(raw) as Record<string, unknown>;
    return readEntryAt(parsed, entryPath) !== undefined;
  } catch {
    return false;
  }
}

function tomlRawHasPath(raw: string, path: string | undefined): boolean {
  if (!raw.trim()) return false;
  try {
    const parsed = TOML.parse(raw) as Record<string, unknown>;
    return readPathAt(parsed, path) !== undefined;
  } catch {
    return false;
  }
}

function writeTomlConfigBody(
  target: ClientTarget,
  body: Record<string, unknown>,
  edit: RegistrationEdit,
): void {
  const raw = existsSync(target.configPath)
    ? readFileSync(target.configPath, 'utf8')
    : '';
  const ownedPath = target.entryPath;
  const ownedParentPath = tomlParentPath(ownedPath) ?? undefined;
  const tableEdit = edit.kind === 'remove' ? edit
    : { kind: 'upsert' as const, block: serialiseTomlEntryOnly(target, body) };
  let patched = replaceTomlTable(
    raw,
    ownedPath,
    tableEdit,
    tomlRawHasEntry(raw, target.entryPath),
    tomlRawHasPath(raw, ownedParentPath),
  );
  if (edit.kind === 'remove' && patched !== null && ownedParentPath
      && !tomlRawHasPath(patched, ownedParentPath)) {
    // Keep the empty server container when its last child table was removed.
    const parentOnly: Record<string, unknown> = {};
    ensurePathContainer(parentOnly, splitEntryPath(target.entryPath).head);
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
  );
}
