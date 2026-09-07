import type { ClientTarget } from './mcp-client-registry.js';

/**
 * Resolve a dotted entry-path (`'mcpServers.dkg'`, `'servers.dkg'`,
 * `'mcp_servers.dkg'`) into its head segments + final key. Used by
 * both classify (read) and writeRegistration (write) to navigate the
 * parsed config object identically.
 */
export function splitEntryPath(entryPath: ClientTarget['entryPath']): { head: string[]; leaf: string } {
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
export function ensurePathContainer(
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
export function readEntryAt(
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
