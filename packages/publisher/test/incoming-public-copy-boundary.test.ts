import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

// Rewriting a copy to the store's form is right only where a node takes a
// received copy in as its own. A check of a hash against bytes as given (a
// peer's advertised digest, a stored snapshot) must hash them untouched, so
// every user of the rewrite is pinned here and adding one is a reviewed change.
const ALLOWED_USERS: Record<string, readonly string[]> = {
  canonicalizeRdfObjectTerm: [
    'packages/publisher/src/incoming-public-copy.ts',
    'packages/rdf-utils/src/index.ts',
  ],
  acceptIncomingPublicQuads: [
    'packages/agent/src/gossip-publish-handler.ts',
    'packages/publisher/src/graph-scoped-ack-persistence.ts',
    'packages/publisher/src/incoming-public-copy.ts',
    'packages/publisher/src/index.ts',
    'packages/publisher/src/workspace-handler.ts',
  ],
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });
}

const packageSources = readdirSync(join(REPO_ROOT, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const src = join(REPO_ROOT, 'packages', entry.name, 'src');
    try {
      return sourceFiles(src);
    } catch {
      return [];
    }
  });

describe('incoming public copy boundary', () => {
  it.each(Object.entries(ALLOWED_USERS))('only the pinned source files use %s', (name, allowed) => {
    const users = packageSources
      .filter((file) => readFileSync(file, 'utf8').includes(name))
      .map((file) => relative(REPO_ROOT, file).split(sep).join('/'))
      .sort();

    expect(users).toEqual([...allowed].sort());
  });
});
