import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { ChangelogStore } from '../src/changelog-store.js';
import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import { SharedMemoryLiteralBlobStore } from '../src/shared-memory-literal-blob-store.js';
import type { TripleStore } from '../src/triple-store.js';

/**
 * `assertManagedBackendReadableV1` is called with optional chaining, so an
 * absent implementation reads as PERMISSION. Every wrapper between a
 * cache-owning reader and the managed adapter must therefore forward it, and
 * nothing in the type system enforces that — the member is optional on
 * `TripleStore` precisely so unleased stores need not implement it.
 *
 * These are the two halves of that enforcement: behavioural proof for the
 * decorators that exist, and a structural sweep that fails when a NEW one is
 * added without forwarding. Without the second, this defect returns silently
 * the next time someone writes a decorator.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const collectSourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });

/** A store that WRAPS another store, as opposed to one that owns a backend. */
const isDecorator = (source: string): boolean =>
  /implements\s+TripleStore/.test(source) && /(inner|innerStore)\s*:\s*TripleStore/.test(source);

/**
 * A DECLARATION, not a mention.
 *
 * This distinction is load-bearing and was not academic: the first version of
 * this sweep tested `source.includes('assertManagedBackendReadableV1')`, which
 * passed `GraphSetIndexStore` on the strength of its own CALL to the method
 * while the class had no implementation at all — the exact gap being tested.
 */
const declaresReadGate = (source: string): boolean =>
  /^\s+assertManagedBackendReadableV1\s*\(/m.test(source);

describe('managed read gate is forwarded by every TripleStore decorator', () => {
  it('every decorator in packages/storage/src declares the forward', () => {
    const offenders = collectSourceFiles(SRC)
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
      .filter(({ source }) => isDecorator(source))
      .filter(({ source }) => !declaresReadGate(source))
      .map(({ file }) => file.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });

  it('the sweep actually finds the decorators (it is not vacuously empty)', () => {
    // A structural test whose selector silently matches nothing is the purest
    // form of a check that cannot fail.
    const decorators = collectSourceFiles(SRC)
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
      .filter(({ source }) => isDecorator(source))
      .map(({ file }) => file.slice(SRC.length + 1).replace(/\\/g, '/'));

    expect(decorators).toEqual(
      expect.arrayContaining([
        'changelog-store.ts',
        'graph-set-index-store.ts',
        'shared-memory-literal-blob-store.ts',
      ]),
    );
  });

  describe('behavioural forwarding', () => {
    const inner = () => {
      const store = {
        assertManagedBackendReadableV1: vi.fn(),
        listGraphs: async () => [],
        query: async () => ({ type: 'boolean' as const, value: true }),
        insert: async () => undefined,
        delete: async () => undefined,
        close: async () => undefined,
      };
      return store as unknown as TripleStore & {
        assertManagedBackendReadableV1: ReturnType<typeof vi.fn>;
      };
    };

    it('GraphSetIndexStore forwards to its inner store', () => {
      const target = inner();
      new GraphSetIndexStore(target).assertManagedBackendReadableV1!('probe');
      expect(target.assertManagedBackendReadableV1).toHaveBeenCalledWith('probe');
    });

    it('ChangelogStore forwards even when enabled', () => {
      // Enabled is the interesting case: the sibling lane getter DENIES when
      // enabled, and copying that shape here would suppress a refusal.
      const target = inner();
      new ChangelogStore(target, { enabled: true }).assertManagedBackendReadableV1!('probe');
      expect(target.assertManagedBackendReadableV1).toHaveBeenCalledWith('probe');
    });

    it('SharedMemoryLiteralBlobStore forwards to its inner store', () => {
      const target = inner();
      new SharedMemoryLiteralBlobStore(target, {
        blobDir: join(SRC, '..', 'test', '.tmp-unused'),
        thresholdBytes: 1_000_000,
      }).assertManagedBackendReadableV1!('probe');
      expect(target.assertManagedBackendReadableV1).toHaveBeenCalledWith('probe');
    });

    it('a decorator over an UNLEASED inner store stays silent', () => {
      // The capability is absent on stores with no lease; forwarding must not
      // invent a refusal, or every non-managed composition would start throwing.
      const bare = { listGraphs: async () => [] } as unknown as TripleStore;
      expect(() =>
        new GraphSetIndexStore(bare).assertManagedBackendReadableV1!('probe'),
      ).not.toThrow();
    });
  });
});
