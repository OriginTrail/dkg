import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, createScanner, findNodeAtLocation, modify, parse as parseJsonc, parseTree, type Edit, type ParseError } from 'jsonc-parser';
import { writeMcpConfigAtomic, type RegistrationEdit } from './mcp-config-file.js';
import { splitEntryPath, ensurePathContainer, readEntryAt } from './mcp-config-path.js';
import { TomlRegistrationDocument } from './mcp-toml-document.js';
import { tildify, type ClientTarget } from './mcp-client-registry.js';

function readJson(path: string, format: 'json' | 'jsonc' = 'json'): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return {};
  try {
    const errors: ParseError[] = [];
    const parsed = format === 'jsonc'
      ? parseJsonc(raw, errors, { allowTrailingComma: true })
      : JSON.parse(raw);
    if (errors.length > 0) throw new Error('Invalid JSONC');
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error(
      `Existing file is not valid ${format.toUpperCase()}: ${tildify(path)}. Move it aside and re-run.`,
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
    case 'jsonc':
      return readJson(target.configPath, format);
    case 'toml':
      return new TomlRegistrationDocument(target).read();
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

/** Edit only the owned source range, preserving numeric lexemes and JSONC trivia. */
function writeJsonDocumentBody(target: ClientTarget, body: Record<string, unknown>, edit: RegistrationEdit): void {
  const raw = existsSync(target.configPath) ? readFileSync(target.configPath, 'utf8') : '{}';
  const allowTrailingComma = target.format === 'jsonc';
  const patched = edit.kind === 'remove' ? removeJsonEntry(raw, target.entryPath.split('.'), allowTrailingComma)
    : applyEdits(raw, modify(raw, target.entryPath.split('.'), readEntryAt(body, target.entryPath), {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: raw.includes('\r\n') ? '\r\n' : '\n' },
  }));
  const errors: ParseError[] = [];
  const parsed = parseJsonc(patched, errors, { allowTrailingComma, disallowComments: !allowTrailingComma });
  if (errors.length > 0 || !isDeepStrictEqual(parsed, body)) {
    throw new Error(`Cannot safely edit ${target.format.toUpperCase()} registration in ${target.displayPath}`);
  }
  writeMcpConfigAtomic(target.configPath, patched);
}

/**
 * Serialize a parsed body to disk, dispatching on `target.format`.
 * Mirrors `readConfigBody`'s dispatch shape. JSON setup keeps the existing
 * 2-space indent and trailing newline; removal edits only the owned property.
 * TOML patches only the owned MCP table.
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
      if (edit.kind === 'remove') writeJsonDocumentBody(target, body, edit);
      else writeMcpConfigAtomic(target.configPath, JSON.stringify(body, null, 2) + '\n');
      return;
    case 'jsonc':
      writeJsonDocumentBody(target, body, edit);
      return;
    case 'toml':
      new TomlRegistrationDocument(target).write(body, edit);
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
