// Pins the agent ↔ publisher canonicalization parity contract — one function, two callers.

import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  canonicalPublishPayload,
} from '../src/canonical-publish-payload.js';
import {
  computeFlatKCRootV10,
  computePrivateRootV10,
} from '../src/merkle.js';
import { autoPartition } from '../src/auto-partition.js';

const q = (s: string, p: string, o: string) => ({
  subject: s,
  predicate: p,
  object: o,
  graph: '',
});

describe('canonicalPublishPayload — shared canonicalization for agent ↔ publisher', () => {
  it('produces a 32-byte kcMerkleRoot for a single public triple', () => {
    const quads = [q('http://example.org/foo', 'http://schema.org/name', '"Bar"')];

    const result = canonicalPublishPayload(quads);

    expect(result.kcMerkleRoot).toBeInstanceOf(Uint8Array);
    expect(result.kcMerkleRoot.length).toBe(32);
  });

  it('is deterministic — two calls with identical input produce identical merkle', () => {
    const quads = [
      q('http://example.org/bike-1', 'http://schema.org/manufacturer', '"Acme"'),
      q('http://example.org/bike-1', 'http://schema.org/serialNumber', '"SN-001"'),
    ];

    const a = canonicalPublishPayload(quads);
    const b = canonicalPublishPayload(quads);

    expect(ethers.hexlify(a.kcMerkleRoot)).toBe(ethers.hexlify(b.kcMerkleRoot));
  });

  it('produces the same kcMerkleRoot as the publisher pipeline composed manually', () => {
    // This is the parity test: the shared helper MUST produce the
    // same bytes as what `publisher.publish` computes inline. Any
    // divergence here means the agent-signed merkle will not match
    // the publisher's at process-time, and the seal will be invalid.
    const publicQuads = [
      q('http://example.org/bike-2', 'http://schema.org/manufacturer', '"Acme"'),
      q('http://example.org/bike-2', 'http://schema.org/serialNumber', '"SN-002"'),
    ];
    const privateQuads = [
      q('http://example.org/bike-2', 'http://schema.org/internalNotes', '"private"'),
    ];

    // Mirror publisher.publish() lines ~1544-1596 by hand.
    const kaMap = autoPartition(publicQuads);
    const skolemizedPublic = [...kaMap.values()].flat();
    const privateRoots: Uint8Array[] = [];
    for (const [rootEntity] of kaMap) {
      const entityPrivate = privateQuads.filter(
        (qq) => qq.subject === rootEntity || qq.subject.startsWith(rootEntity + '/.well-known/genid/'),
      );
      if (entityPrivate.length > 0) {
        const root = computePrivateRootV10(entityPrivate);
        if (root) privateRoots.push(root);
      }
    }
    const expectedMerkle = computeFlatKCRootV10(skolemizedPublic, privateRoots);

    const result = canonicalPublishPayload(publicQuads, privateQuads);

    expect(ethers.hexlify(result.kcMerkleRoot)).toBe(ethers.hexlify(expectedMerkle));
    expect(result.skolemizedPublicQuads.length).toBe(skolemizedPublic.length);
    expect(result.privateRoots.length).toBe(privateRoots.length);
  });

  it('returns per-root manifest entries with public + private triple counts', () => {
    const quads = [
      q('http://example.org/bike-3', 'http://schema.org/name', '"BikeThree"'),
      q('http://example.org/bike-4', 'http://schema.org/name', '"BikeFour"'),
    ];
    const privateQuads = [
      q('http://example.org/bike-3', 'http://schema.org/secret', '"hush"'),
    ];

    const result = canonicalPublishPayload(quads, privateQuads);

    expect(result.manifestEntries).toHaveLength(2);
    const byRoot = new Map(result.manifestEntries.map((m) => [m.rootEntity, m]));
    expect(byRoot.get('http://example.org/bike-3')?.privateTripleCount).toBe(1);
    expect(byRoot.get('http://example.org/bike-3')?.privateMerkleRoot).toBeDefined();
    expect(byRoot.get('http://example.org/bike-4')?.privateTripleCount).toBe(0);
    expect(byRoot.get('http://example.org/bike-4')?.privateMerkleRoot).toBeUndefined();
  });

  it('handles public-only payload (no private quads)', () => {
    const quads = [q('http://example.org/foo', 'http://schema.org/name', '"Bar"')];

    const result = canonicalPublishPayload(quads);

    expect(result.privateRoots).toEqual([]);
    expect(result.manifestEntries[0].privateMerkleRoot).toBeUndefined();
  });
});
