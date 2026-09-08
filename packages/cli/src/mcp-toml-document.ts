import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import TOML from '@iarna/toml';
import { DKG_SERVER_KEY, tildify, type ClientTarget } from './mcp-client-registry.js';
import { writeMcpConfigAtomic } from './mcp-config-file.js';

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
  body: Record<string, unknown>,
): string {
  const container = body[target.serverContainer] as Record<string, unknown>;
  const nested: Record<string, unknown> = {
    [target.serverContainer]: { [DKG_SERVER_KEY]: container[DKG_SERVER_KEY] ?? {} },
  };
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
  serverContainer: ClientTarget['serverContainer'],
  edit: { kind: 'upsert'; block: string } | { kind: 'remove' },
  parsedRawHasOwnedEntry: boolean,
  parsedRawHasOwnedParent: boolean,
): string | null {
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const ownedPathKey = `${serverContainer}${TOML_PATH_SEPARATOR}${DKG_SERVER_KEY}`;
  const normalisedParentPathKey = serverContainer;
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
  let hasParentTableFamily = false;

  for (let i = 0; i < lines.length; i++) {
    const headerPath = headerPaths[i];
    if (!headerPath) continue;
    if (ownsTomlTablePath(headerPath, normalisedParentPathKey)) {
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

function tomlRawHasContainer(raw: string, container: ClientTarget['serverContainer']): boolean {
  try { return raw.trim() !== '' && TOML.parse(raw)[container] !== undefined; }
  catch { return false; }
}

export function writeTomlConfigBody(
  target: ClientTarget,
  body: Record<string, unknown>,
): void {
  const raw = existsSync(target.configPath)
    ? readFileSync(target.configPath, 'utf8')
    : '';
  const ownedPath = `${target.serverContainer}.${DKG_SERVER_KEY}`;
  const removing = !Object.hasOwn(body[target.serverContainer] as Record<string, unknown>, DKG_SERVER_KEY);
  const tableEdit = removing ? { kind: 'remove' as const }
    : { kind: 'upsert' as const, block: serialiseTomlEntryOnly(target, body) };
  const rawContainer = raw.trim() ? TOML.parse(raw)[target.serverContainer] : undefined;
  let patched = replaceTomlTable(
    raw,
    target.serverContainer,
    tableEdit,
    rawContainer !== null && typeof rawContainer === 'object' && Object.hasOwn(rawContainer, DKG_SERVER_KEY),
    rawContainer !== undefined,
  );
  if (removing && patched !== null
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
