import { closeSync, existsSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import type { McpConfigPersistenceStrategy } from './mcp-config-metadata.js';

/** The exact source document an edit was derived from. */
const MCP_CONFIG_SOURCE_SNAPSHOT: unique symbol = Symbol('McpConfigSourceSnapshot');

export interface McpConfigSourceSnapshot {
  readonly [MCP_CONFIG_SOURCE_SNAPSHOT]: true;
  readonly destination: string;
  readonly content: string | undefined;
  /** Revalidate every selected path binding and the source bytes. */
  assertCurrent(): void;
}

/** Resolve existing links, including parents of a first-time config path. */
export function resolveMcpConfigDestination(configPath: string): string {
  // lstat also sees dangling links. Resolving one fails before any write,
  // preserving the user's link instead of renaming a regular file over it.
  const absolute = resolve(configPath);
  if (lstatSync(absolute, { throwIfNoEntry: false })) return realpathSync(absolute);
  return join(resolveMcpConfigDestination(dirname(absolute)), basename(absolute));
}

/** Capture path bindings and bytes as one required transaction snapshot. */
export function snapshotMcpConfigSource(
  configPath: string,
  paths: readonly Readonly<{ configPath: string; displayPath: string }>[],
): McpConfigSourceSnapshot {
  if (paths.length === 0) throw new Error('An MCP config transaction requires a path binding');
  const destination = resolveMcpConfigDestination(configPath);
  const assertBindingsCurrent = (): void => {
    for (const path of paths) {
      if (resolveMcpConfigDestination(path.configPath) !== destination) {
        throw new Error(`MCP config path changed since inspection: ${path.displayPath}. Re-run the command to confirm the current destination.`);
      }
    }
  };
  assertBindingsCurrent();
  const content = existsSync(destination) ? readFileSync(destination, 'utf8') : undefined;
  assertBindingsCurrent();
  return Object.freeze({
    [MCP_CONFIG_SOURCE_SNAPSHOT]: true as const,
    destination,
    content,
    assertCurrent: () => {
      assertBindingsCurrent();
      const currentContent = existsSync(destination)
        ? readFileSync(destination, 'utf8')
        : undefined;
      if (currentContent !== content) {
        throw new Error(`MCP config changed while it was being edited: ${configPath}. Re-run the command to apply the edit to the latest version.`);
      }
    },
  });
}

/** Replace a complete client config without exposing a truncated file to readers. */
export function writeMcpConfigAtomic(
  configPath: string,
  content: string,
  persistence: McpConfigPersistenceStrategy,
  expectedSource: McpConfigSourceSnapshot,
): void {
  expectedSource.assertCurrent();
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
    expectedSource.assertCurrent();
    persistence.publish(replacement);
  } finally {
    rmSync(temporary, { force: true });
  }
}
