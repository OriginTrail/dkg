import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, sep } from 'node:path';

/** Resolve kernel traversal order and retain the parents of every alias used. */
export async function durablePathTraversal(path: string): Promise<{ resolved: string; aliasParents: string[] }> {
  const expected = await realpath(path), root = parse(path).root;
  // A fully canonical spelling cannot contain a traversed symlink. Keep the
  // ordinary per-file barrier at one realpath rather than rescanning ancestors.
  if (path === expected) return { resolved: expected, aliasParents: [] };
  let current = root, pending = path.slice(root.length).split(sep), links = 0;
  const aliases = new Set<string>();
  while (pending.length) {
    const part = pending.shift()!;
    if (!part || part === '.') continue;
    if (part === '..') { current = dirname(current); continue; }
    const candidate = join(current, part), entry = await lstat(candidate);
    if (!entry.isSymbolicLink()) { current = await realpath(candidate); continue; }
    if (++links > 64) throw Object.assign(new Error('Durability path has too many symlink traversals'), { code: 'ELOOP' });
    aliases.add(current);
    const target = await readlink(candidate), targetRoot = parse(target).root;
    if (isAbsolute(target)) current = targetRoot;
    pending = [...target.slice(targetRoot.length).split(sep), ...pending];
  }
  if (current !== expected) throw Object.assign(new Error('Durability path changed during resolution'), { code: 'ESTALE' });
  return { resolved: expected, aliasParents: [...aliases] };
}
