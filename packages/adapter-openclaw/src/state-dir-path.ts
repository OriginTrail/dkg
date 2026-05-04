import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export type ChatTurnWriterStateLayout = 'direct' | 'nested';

export function defaultStateDirForWorkspace(workspaceDir: string): string {
  return join(workspaceDir, '.dkg-adapter');
}

export function legacyStateDirForWorkspace(workspaceDir: string): string {
  return join(workspaceDir, '.openclaw');
}

export function workspaceDirForDefaultStateDir(stateDir: string): string | undefined {
  const absolute = resolve(stateDir);
  return basename(absolute) === '.dkg-adapter' ? dirname(absolute) : undefined;
}

export function watermarkPathForStateDir(
  stateDir: string,
  layout: ChatTurnWriterStateLayout = 'nested',
): string {
  return layout === 'direct'
    ? join(stateDir, 'chat-turn-watermarks.json')
    : join(stateDir, 'dkg-adapter', 'chat-turn-watermarks.json');
}

export function legacyWatermarkPathForStateDir(stateDir: string): string {
  return watermarkPathForStateDir(stateDir, 'nested');
}

export function canonicalPathForCompare(path: string): string {
  const absolute = resolve(path);
  const missingParts: string[] = [];
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missingParts.unshift(basename(existing));
    existing = parent;
  }

  let canonicalBase = existing;
  try { canonicalBase = realpathSync(existing); } catch { /* keep resolved fallback */ }
  const canonical = missingParts.reduce((acc, part) => join(acc, part), canonicalBase);
  const normalized = resolve(canonical);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function sameResolvedPath(a: string, b: string): boolean {
  return canonicalPathForCompare(a) === canonicalPathForCompare(b);
}
