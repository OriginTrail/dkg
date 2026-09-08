import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, createScanner, findNodeAtLocation, modify, parse as parseJsonc, parseTree, type Edit, type ParseError } from 'jsonc-parser';
import { writeMcpConfigAtomic } from './mcp-config-file.js';
import { readToml, writeTomlConfigBody } from './mcp-toml-document.js';
import { DKG_SERVER_KEY, tildify, type ClientTarget } from './mcp-client-registry.js';

/** Parsed config objects have named fields; arrays/scalars are never mergeable records. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export interface McpRegistration {
  command?: string;
  args?: string[];
  dkgHome?: string;
}
export type RegistrationRead =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'entry'; registration: McpRegistration };

function normalizeRegistration(value: unknown): RegistrationRead {
  if (value === undefined || value === null) return { kind: 'absent' };
  if (!isPlainRecord(value)
      || (value.command !== undefined && typeof value.command !== 'string')
      || (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every(arg => typeof arg === 'string')))
      || (value.env !== undefined && !isPlainRecord(value.env))) return { kind: 'invalid' };
  const env = isPlainRecord(value.env) ? value.env : undefined;
  if (env?.DKG_HOME !== undefined && typeof env.DKG_HOME !== 'string') return { kind: 'invalid' };
  return { kind: 'entry', registration: {
    command: typeof value.command === 'string' ? value.command : undefined,
    args: Array.isArray(value.args) ? value.args : undefined,
    dkgHome: typeof env?.DKG_HOME === 'string' ? env.DKG_HOME : undefined,
  } };
}

export function classifyRegistration(current: RegistrationRead, expected: Record<string, unknown>): 'registered' | 'stale' | 'not-registered' {
  if (current.kind === 'absent') return 'not-registered';
  const wanted = normalizeRegistration(expected);
  if (current.kind !== 'entry' || wanted.kind !== 'entry') return 'stale';
  return current.registration.command === wanted.registration.command
    && current.registration.args !== undefined
    && isDeepStrictEqual(current.registration.args, wanted.registration.args)
    && current.registration.dkgHome === wanted.registration.dkgHome ? 'registered' : 'stale';
}

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
  const cursor = body[target.serverContainer];
  // Missing container: readable config, nothing registered.
  if (cursor === undefined) return { ok: true, servers: {} };
  // Present but not a KEYED object: malformed exactly where we needed to read.
  // An array counts — `typeof [] === 'object'`, so without the explicit check it
  // fell through to Object.entries([]) and reported "readable, nothing
  // registered": a confident claim about a container we cannot interpret. The
  // entry-level filter below already rejected arrays; the container needed the
  // same treatment.
  if (!isPlainRecord(cursor)) {
    return { ok: false, reason: `malformed server container in ${target.displayPath}` };
  }
  // Only entries that could actually launch count as registrations. `classify`
  // above already treats `{ dkg: null }` as not-registered (deliberately —
  // pre-F7 it read as `stale` and claimed there was a value to refresh). A
  // value that is null, scalar, an array, or an object carrying no `command`
  // is the same non-registration: nothing there can start. Counting one would
  // be a false positive, the opposite failure from the unreadable-config case.
  const servers: Record<string, RegisteredMcpServer> = {};
  for (const [name, value] of Object.entries(cursor)) {
    if (!isPlainRecord(value)) continue;
    const block = value;
    if (typeof block.command !== 'string') continue;
    const env: Record<string, string> = {};
    if (isPlainRecord(block.env)) {
      for (const [k, val] of Object.entries(block.env)) {
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
function writeJsonDocumentBody(target: ClientTarget, body: Record<string, unknown>): void {
  const raw = existsSync(target.configPath) ? readFileSync(target.configPath, 'utf8') : '{}';
  const allowTrailingComma = target.format === 'jsonc';
  const patched = !Object.hasOwn(body[target.serverContainer] as Record<string, unknown>, DKG_SERVER_KEY) ? removeJsonEntry(raw, [target.serverContainer, DKG_SERVER_KEY], allowTrailingComma)
    : applyEdits(raw, modify(raw, [target.serverContainer, DKG_SERVER_KEY], readOwnedRegistration(body, target), {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: raw.includes('\r\n') ? '\r\n' : '\n' },
  }));
  const errors: ParseError[] = [];
  const parsed = parseJsonc(patched, errors, { allowTrailingComma, disallowComments: !allowTrailingComma });
  if (errors.length > 0 || !isDeepStrictEqual(parsed, body)) {
    throw new Error(`Cannot safely edit ${target.format.toUpperCase()} registration in ${target.displayPath}`);
  }
  writeMcpConfigAtomic(target.configPath, patched, target.location);
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
function writeConfigBody(target: ClientTarget, body: Record<string, unknown>): void {
  const format = target.format;
  const dir = dirname(target.configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  switch (format) {
    case 'json':
      if (!Object.hasOwn(body[target.serverContainer] as Record<string, unknown>, DKG_SERVER_KEY)) writeJsonDocumentBody(target, body);
      else writeMcpConfigAtomic(target.configPath, JSON.stringify(body, null, 2) + '\n', target.location);
      return;
    case 'jsonc':
      writeJsonDocumentBody(target, body);
      return;
    case 'toml':
      writeTomlConfigBody(target, body);
      return;
    default:
      throw new Error(`Unknown client config format: ${String(format)}`);
  }
}

/** Resolve the owned leaf and its mutable container from a fresh config read. */
function registrationLocation(target: ClientTarget): {
  body: Record<string, unknown>; container: Record<string, unknown>;
} | undefined {
  const body = readConfigBody(target);
  const cursor = body[target.serverContainer];
  if (cursor === undefined) return undefined;
  if (!isPlainRecord(cursor)) {
    throw new Error(`Malformed MCP server container in ${target.displayPath}`);
  }
  if (!Object.hasOwn(cursor, DKG_SERVER_KEY)) return undefined;
  return { body, container: cursor };
}

/** Inspect only: stale/null entries still count as an owned registration. */
export function inspectRegistration(target: ClientTarget): boolean {
  return registrationLocation(target) !== undefined;
}

/** Re-read, then remove only the owned leaf; retain unrelated config and empty parent containers. */
export function removeRegistration(target: ClientTarget): boolean {
  const location = registrationLocation(target);
  if (!location) return false;
  delete location.container[DKG_SERVER_KEY];
  writeConfigBody(target, location.body);
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
  const currentContainer = body[target.serverContainer];
  const container = isPlainRecord(currentContainer) ? currentContainer : {};
  body[target.serverContainer] = container;
  const currentEntry = container[DKG_SERVER_KEY];
  const currentEntryObj = isPlainRecord(currentEntry) ? currentEntry : {};
  const currentEnv = isPlainRecord(currentEntryObj.env) ? currentEntryObj.env : {};
  const expectedEnv = isPlainRecord(entry.env) ? entry.env : {};
  const mergedEntry: Record<string, unknown> = {
    ...currentEntryObj,
    ...entry,
    env: { ...currentEnv, ...expectedEnv },
  };
  container[DKG_SERVER_KEY] = mergedEntry;
  writeConfigBody(target, body);
}

/** Read the owned entry for setup classification; no mutation. */
export function readRegistration(target: ClientTarget): RegistrationRead {
  return normalizeRegistration(readOwnedRegistration(readConfigBody(target), target));
}

function readOwnedRegistration(body: Record<string, unknown>, target: ClientTarget): unknown {
  const container = body[target.serverContainer];
  return isPlainRecord(container)
    ? container[DKG_SERVER_KEY]
    : undefined;
}
