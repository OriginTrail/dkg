import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import TOML from '@iarna/toml';
import { isDeepStrictEqual } from 'node:util';
import { tildify, type ClientTarget } from './mcp-client-registry.js';

/**
 * Resolve a dotted entry-path (`'mcpServers.dkg'`, `'servers.dkg'`,
 * `'mcp_servers.dkg'`) into its head segments + final key. Used by
 * both classify (read) and writeRegistration (write) to navigate the
 * parsed config object identically.
 */
function splitEntryPath(entryPath: ClientTarget['entryPath']): { head: string[]; leaf: string } {
  const path = entryPath;
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Invalid entryPath "${entryPath}": must be a non-empty dotted path`);
  }
  return { head: parts.slice(0, -1), leaf: parts[parts.length - 1] };
}

/**
 * Walk a parsed config object down a list of head segments, lazily
 * creating intermediate `Record<string, unknown>` containers for any
 * missing levels. Returns the parent container of the leaf key.
 *
 * Used at write time only. At read time we tolerate missing
 * intermediates (the entry just classifies as `not-registered`).
 */
function ensurePathContainer(
  body: Record<string, unknown>,
  head: string[],
): Record<string, unknown> {
  let cursor: Record<string, unknown> = body;
  for (const segment of head) {
    const next = cursor[segment];
    if (next === undefined || next === null || typeof next !== 'object') {
      const fresh: Record<string, unknown> = {};
      cursor[segment] = fresh;
      cursor = fresh;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  return cursor;
}

/**
 * Read the leaf value at a dotted entry-path; returns `undefined` if
 * any intermediate is missing or non-object. Used by `classify` so
 * staleness detection works regardless of how deep the entry is
 * nested.
 */
function readEntryAt(
  body: Record<string, unknown>,
  entryPath: ClientTarget['entryPath'],
): unknown {
  const { head, leaf } = splitEntryPath(entryPath);
  let cursor: unknown = body;
  for (const segment of head) {
    if (cursor === undefined || cursor === null || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (cursor === undefined || cursor === null || typeof cursor !== 'object') {
    return undefined;
  }
  return (cursor as Record<string, unknown>)[leaf];
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error(
      `Existing file is not valid JSON: ${tildify(path)}. Move it aside and re-run.`,
    );
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

/**
 * Read the parsed body of a per-client config, dispatching on
 * `target.format`. JSON is the most common format. TOML
 * (Codex CLI) uses `@iarna/toml`. Unsupported shapes cannot be targets.
 * Missing-file is normalised to `{}` for the live formats so
 * first-write callers don't have to special-case
 * detection-via-parent-dir candidates.
 */
function readConfigBody(target: ClientTarget): Record<string, unknown> {
  const format = target.format;
  switch (format) {
    case 'json':
      return readJson(target.configPath);
    case 'toml':
      return readToml(target.configPath);
    default:
      throw new Error(`Unknown client config format: ${String(format)}`);
  }
}

/** The launch shape of one registered MCP server, as the client stores it. */
export interface RegisteredMcpServer {
  command: string;
  /**
   * The declared launch arguments. `[]` means the key was absent — a legitimate
   * args-less server. `null` means the key was PRESENT but is not a string
   * array, which is not a launch block we can compare. The distinction matters:
   * quietly dropping a non-string element would rewrite `args: [123]` into `[]`
   * and let it match an args-less registry entry, manufacturing an install.
   */
  args: string[] | null;
  /** String-valued env entries only; non-string values are not represented. */
  env?: Record<string, string>;
}

/**
 * Outcome of inspecting one client config for registered MCP servers.
 * `ok: false` is "we could not look", never "we looked and found nothing".
 *
 * Carries the blocks rather than only their names. A server registered under a
 * slug is evidence that THAT integration is installed only if it also launches
 * what the registry entry says it should — the name alone cannot tell a real
 * installation apart from an unrelated server that happens to share it.
 */
export type ServerKeyProbe =
  | { ok: true; servers: Record<string, RegisteredMcpServer> }
  | { ok: false; reason: string };

/**
 * Names of every MCP server registered in a client's config, whatever container
 * that client uses (`mcpServers`, `servers`, `mcp_servers`) and whatever format
 * it is written in (JSON, TOML).
 *
 * `dkg mcp setup` cares about one fixed leaf (`…dkg`); integration detection
 * needs the sibling keys instead, because an installed integration registers
 * itself under its own slug. Exposed here so `dkg integration list` reads the
 * same client targets and container paths that `dkg mcp setup` writes, rather
 * than maintaining a second, narrower list that silently misses clients.
 *
 * Absence of evidence is not evidence of absence, so the two are returned as
 * different values rather than both as []. `ok: false` means we could not look
 * — the file is present but unreadable, unparseable, or malformed at the
 * container we needed. A caller that reports install state must not render
 * that as "not installed": it would tell a user an integration is missing when
 * the truth is that their config could not be read.
 */
export function readRegisteredServerKeys(target: ClientTarget): ServerKeyProbe {
  let body: Record<string, unknown>;
  try {
    body = readConfigBody(target);
  } catch (err) {
    // A config that does not exist IS a real answer: this client has
    // registered nothing. Anything else means the file is there and we failed.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, servers: {} };
    return { ok: false, reason: `could not read ${target.displayPath}` };
  }
  const { head } = splitEntryPath(target.entryPath);
  let cursor: unknown = body;
  for (const segment of head) {
    if (cursor === null || typeof cursor !== 'object') return { ok: true, servers: {} };
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  // Missing container: readable config, nothing registered.
  if (cursor === undefined) return { ok: true, servers: {} };
  // Present but not a KEYED object: malformed exactly where we needed to read.
  // An array counts — `typeof [] === 'object'`, so without the explicit check it
  // fell through to Object.entries([]) and reported "readable, nothing
  // registered": a confident claim about a container we cannot interpret. The
  // entry-level filter below already rejected arrays; the container needed the
  // same treatment.
  if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
    return { ok: false, reason: `malformed server container in ${target.displayPath}` };
  }
  // Only entries that could actually launch count as registrations. `classify`
  // above already treats `{ dkg: null }` as not-registered (deliberately —
  // pre-F7 it read as `stale` and claimed there was a value to refresh). A
  // value that is null, scalar, an array, or an object carrying no `command`
  // is the same non-registration: nothing there can start. Counting one would
  // be a false positive, the opposite failure from the unreadable-config case.
  const servers: Record<string, RegisteredMcpServer> = {};
  for (const [name, value] of Object.entries(cursor as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const block = value as Record<string, unknown>;
    if (typeof block.command !== 'string') continue;
    const env: Record<string, string> = {};
    if (block.env !== null && typeof block.env === 'object' && !Array.isArray(block.env)) {
      for (const [k, val] of Object.entries(block.env as Record<string, unknown>)) {
        if (typeof val === 'string') env[k] = val;
      }
    }
    let args: string[] | null;
    if (block.args === undefined) {
      args = []; // absent: a legitimate args-less server
    } else if (Array.isArray(block.args) && block.args.every((a) => typeof a === 'string')) {
      args = block.args as string[];
    } else {
      args = null; // present but not a string array — not comparable
    }
    servers[name] = { command: block.command, args, env };
  }
  return { ok: true, servers };
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

type RegistrationEdit = { kind: 'upsert' } | { kind: 'remove' };

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
  writeFileSync(
    target.configPath,
    patched ?? TOML.stringify(body as TOML.JsonMap),
  );
}

/**
 * Serialize a parsed body to disk, dispatching on `target.format`.
 * Mirrors `readConfigBody`'s dispatch shape. JSON output keeps the
 * pre-refactor formatting (2-space indent, trailing newline)
 * byte-for-byte. TOML patches only the owned MCP table.
 *
 * FIX 26 merge: format-agnostic. The merge in `writeRegistration`
 * operates on the parsed body object before it reaches this writer,
 * so the per-format spread/stringify path here never sees the merge
 * logic.
 */
function writeConfigBody(target: ClientTarget, body: Record<string, unknown>, edit: RegistrationEdit): void {
  const format = target.format;
  const dir = dirname(target.configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  switch (format) {
    case 'json':
      writeFileSync(target.configPath, JSON.stringify(body, null, 2) + '\n');
      return;
    case 'toml':
      writeTomlConfigBody(target, body, edit);
      return;
    default:
      throw new Error(`Unknown client config format: ${String(format)}`);
  }
}

/** Resolve the owned leaf and its mutable container from a fresh config read. */
function registrationLocation(target: ClientTarget): {
  body: Record<string, unknown>; container: Record<string, unknown>; leaf: string;
} | undefined {
  const body = readConfigBody(target);
  const { head, leaf } = splitEntryPath(target.entryPath);
  let cursor: unknown = body;
  for (const segment of head) {
    if (cursor === undefined) return undefined;
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
      throw new Error(`Malformed MCP server container in ${target.displayPath}`);
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (cursor === undefined) return undefined;
  if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
    throw new Error(`Malformed MCP server container in ${target.displayPath}`);
  }
  if (!Object.hasOwn(cursor, leaf)) return undefined;
  return { body, container: cursor as Record<string, unknown>, leaf };
}

/** Inspect only: stale/null entries still count as an owned registration. */
export function inspectRegistration(target: ClientTarget): boolean {
  return registrationLocation(target) !== undefined;
}

/** Re-read, then remove only the owned leaf; retain unrelated config and empty parent containers. */
export function removeRegistration(target: ClientTarget): boolean {
  const location = registrationLocation(target);
  if (!location) return false;
  delete location.container[location.leaf];
  writeConfigBody(target, location.body, { kind: 'remove' });
  return true;
}

export function writeRegistration(
  target: ClientTarget,
  entry: Record<string, unknown>,
): void {
  const body = readConfigBody(target);

  // Codex Round-15 Fix 22 + Round-19 Fix 26: when refreshing an
  // existing entry, MERGE the entire existing entry — not just
  // env — with the expected entry. Round-15 Fix 22 added env-merge
  // (NODE_OPTIONS, HTTPS_PROXY, etc. preserved) but the rest of
  // the entry was still being replaced wholesale, which clobbered
  // top-level keys clients use to anchor MCP servers (e.g. `cwd`
  // for workspace-scoped servers, custom keys like `restartPolicy`).
  //
  // Spread order: existing entry first, then expected entry, then
  // explicit env merge. The fields THIS COMMAND owns are
  // `command`, `args`, and `env.DKG_HOME` — those override
  // existing values via the second spread + explicit env override.
  // Everything else passes through from the existing entry
  // unchanged: arbitrary top-level keys (cwd, restartPolicy, …)
  // and arbitrary env keys (NODE_OPTIONS, HTTPS_PROXY, …).
  const { head, leaf } = splitEntryPath(target.entryPath);
  const container = ensurePathContainer(body, head);
  const currentEntry = container[leaf];
  const currentEntryObj =
    currentEntry && typeof currentEntry === 'object'
      ? (currentEntry as Record<string, unknown>)
      : {};
  const currentEnv =
    currentEntryObj.env && typeof currentEntryObj.env === 'object'
      ? (currentEntryObj.env as Record<string, unknown>)
      : {};
  const expectedEnv =
    entry.env && typeof entry.env === 'object'
      ? (entry.env as Record<string, unknown>)
      : {};
  const mergedEntry: Record<string, unknown> = {
    ...currentEntryObj,
    ...entry,
    env: { ...currentEnv, ...expectedEnv },
  };
  container[leaf] = mergedEntry;
  writeConfigBody(target, body, { kind: 'upsert' });
}

/** Read the owned entry for setup classification; no mutation. */
export function readRegistration(target: ClientTarget): unknown {
  return readEntryAt(readConfigBody(target), target.entryPath);
}
