import { isDeepStrictEqual } from 'node:util';
import type { McpConfigSourceSnapshot } from './mcp-config-file.js';
import type { McpPhysicalConfig } from './mcp-physical-config.js';
import { tomlDocumentAdapter } from './mcp-toml-document.js';
import { jsonDocumentAdapter, jsoncDocumentAdapter } from './mcp-json-document.js';
import { isPlainRecord, type DesiredRegistration, type PersistedRegistration, type RegistrationEdit, type McpConfigDocumentAdapter } from './mcp-config-document.js';
export type { DesiredRegistration, PersistedRegistration, RegistrationEdit } from './mcp-config-document.js';
import { DKG_SERVER_KEY } from './mcp-client-registry.js';

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

export function classifyRegistration(current: RegistrationRead, expected: DesiredRegistration): 'registered' | 'stale' | 'not-registered' {
  if (current.kind === 'absent') return 'not-registered';
  if (current.kind !== 'entry') return 'stale';
  return current.registration.command === expected.command
    && current.registration.args !== undefined
    && isDeepStrictEqual(current.registration.args, expected.args)
    && current.registration.dkgHome === expected.env.DKG_HOME ? 'registered' : 'stale';
}

const documentAdapters: Record<McpPhysicalConfig['shape']['format'], McpConfigDocumentAdapter> = {
  json: jsonDocumentAdapter,
  jsonc: jsoncDocumentAdapter,
  toml: tomlDocumentAdapter,
};

function readConfigBody(
  target: McpPhysicalConfig,
  source: McpConfigSourceSnapshot = target.readSource(),
): Record<string, unknown> {
  try { return documentAdapters[target.shape.format].parse(source.content ?? ''); }
  catch {
    throw new Error(`Existing file is not valid ${target.shape.format.toUpperCase()}: ${target.displayPath}. Move it aside and re-run.`);
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
export function readRegisteredServerKeys(target: McpPhysicalConfig): ServerKeyProbe {
  let body: Record<string, unknown>;
  try {
    body = readConfigBody(target);
  } catch (err) {
    // A config that does not exist IS a real answer: this client has
    // registered nothing. Anything else means the file is there and we failed.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, servers: {} };
    return { ok: false, reason: `could not read ${target.displayPath}` };
  }
  const cursor = body[target.shape.serverContainer];
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

/** Serialize the inspected source once, then persist through one transaction boundary. */
function applyRegistrationEdit(
  target: McpPhysicalConfig,
  edit: RegistrationEdit,
  source: McpConfigSourceSnapshot,
): void {
  const result = documentAdapters[target.shape.format].applyEdit(source.content ?? '', edit, target.shape.serverContainer);
  if (result.warning) {
    process.stderr.write(`[mcp-config] WARNING: ${target.shape.format.toUpperCase()} config at ${target.displayPath} ${result.warning}\n`);
  }
  target.write(result.content, source);
}

/** Inspect only: stale/null entries still count as an owned registration. */
export function inspectRegistration(target: McpPhysicalConfig): boolean {
  const container = readServerContainer(readConfigBody(target), target);
  return container !== undefined && Object.hasOwn(container, DKG_SERVER_KEY);
}

/** Remove only the owned leaf from one source snapshot. */
export function removeRegistration(target: McpPhysicalConfig): boolean {
  const source = target.readSource();
  const body = readConfigBody(target, source);
  const container = readServerContainer(body, target);
  if (container === undefined || !Object.hasOwn(container, DKG_SERVER_KEY)) return false;
  applyRegistrationEdit(target, { kind: 'remove' }, source);
  return true;
}

export function writeRegistration(
  target: McpPhysicalConfig,
  entry: DesiredRegistration,
): void {
  const source = target.readSource();
  const body = readConfigBody(target, source);

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
  const container = readServerContainer(body, target) ?? {};
  const currentEntry = container[DKG_SERVER_KEY];
  const currentEntryObj = isPlainRecord(currentEntry) ? currentEntry : {};
  const currentEnv = isPlainRecord(currentEntryObj.env) ? currentEntryObj.env : {};
  const mergedEntry: PersistedRegistration = {
    ...currentEntryObj,
    ...entry,
    env: { ...currentEnv, ...entry.env, DKG_HOME: entry.env.DKG_HOME },
  };
  applyRegistrationEdit(target, { kind: 'upsert', registration: mergedEntry }, source);
}

/** Read the owned entry for setup classification; no mutation. */
export function readRegistration(target: McpPhysicalConfig): RegistrationRead {
  return normalizeRegistration(readOwnedRegistration(readConfigBody(target), target));
}

function readOwnedRegistration(body: Record<string, unknown>, target: McpPhysicalConfig): unknown {
  return readServerContainer(body, target)?.[DKG_SERVER_KEY];
}

function readServerContainer(
  body: Record<string, unknown>,
  target: McpPhysicalConfig,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(body, target.shape.serverContainer)) return undefined;
  const container = body[target.shape.serverContainer];
  if (!isPlainRecord(container)) {
    throw new Error(`Malformed MCP server container in ${target.displayPath}`);
  }
  return container;
}
