import { closeSync, existsSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import type { McpConfigPersistenceStrategy } from './mcp-config-metadata.js';

/** The exact source document an edit was derived from. */
export interface McpConfigSourceSnapshot {
  readonly destination: string;
  readonly content: string | undefined;
}

/** Resolve existing links, including parents of a first-time config path. */
export function resolveMcpConfigDestination(configPath: string): string {
  // lstat also sees dangling links. Resolving one fails before any write,
  // preserving the user's link instead of renaming a regular file over it.
  const absolute = resolve(configPath);
  if (lstatSync(absolute, { throwIfNoEntry: false })) return realpathSync(absolute);
  return join(resolveMcpConfigDestination(dirname(absolute)), basename(absolute));
}

/** Capture both file identity and bytes before parsing or editing a config. */
export function snapshotMcpConfigSource(configPath: string): McpConfigSourceSnapshot {
  const destination = resolveMcpConfigDestination(configPath);
  return {
    destination,
    content: existsSync(destination) ? readFileSync(destination, 'utf8') : undefined,
  };
}

function assertSourceUnchanged(configPath: string, expected: McpConfigSourceSnapshot): void {
  const current = snapshotMcpConfigSource(configPath);
  if (current.destination !== expected.destination || current.content !== expected.content) {
    throw new Error(`MCP config changed while it was being edited: ${configPath}. Re-run the command to apply the edit to the latest version.`);
  }
}

/** Replace a complete client config without exposing a truncated file to readers. */
export function writeMcpConfigAtomic(
  configPath: string,
  content: string,
  persistence: McpConfigPersistenceStrategy,
  expectedSource: McpConfigSourceSnapshot,
  validateDestination: () => void = () => {},
): void {
  validateDestination();
  assertSourceUnchanged(configPath, expectedSource);
  const destination = expectedSource.destination;
  const original = existsSync(destination) ? statSync(destination) : undefined;
  const mode = original ? original.mode & 0o7777 : 0o600;
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  const replacement = { configPath, destination, temporary, original, mode };
  // Capability checks belong to the selected strategy and run before the
  // transaction creates a temporary file.
  persistence.preflight(replacement);
  try {
    // Hold the new inode open while its existing access metadata is copied.
    // The descriptor stays writable even if the target ACL/owner forbids reopening it.
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      persistence.prepare({ ...replacement, fd });
      ftruncateSync(fd, 0);
      writeFileSync(fd, content, 'utf8');
      persistence.secure({ ...replacement, fd });
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // A client may rewrite its config while this replacement is being
    // prepared. Never publish an edit derived from stale bytes over that work.
    validateDestination();
    assertSourceUnchanged(configPath, expectedSource);
    persistence.publish(replacement);
  } finally {
    rmSync(temporary, { force: true });
  }
}
