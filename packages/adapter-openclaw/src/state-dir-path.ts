import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

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
