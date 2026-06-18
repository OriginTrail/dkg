import { describe, it, expect } from 'vitest';
import { partitionPublishAsyncQuads } from '../src/dkg-agent-helpers.js';
import { PRIVATE_DATA_ANCHOR } from '../src/dkg-agent-constants.js';

// Codex #1132 review / GH #1122: after canonicalRootIri became identity,
// `stampCanonicalAnchorsInWorkspace` self-disabled, so the private-data anchor
// must be stamped at partition time for EVERY root that has private staging —
// including MIXED public+private roots (previously only private-only roots were
// anchored, so mixed roots' private data disappeared from EPCIS/Kafka readers
// that bridge public→private via `<root> dkg:privateDataAnchor "true"`).

const NAME = 'http://schema.org/name';
const SECRET = 'http://example.org/secret';
const anchored = (quads: { subject: string; predicate: string }[], root: string) =>
  quads.some((q) => q.subject === root && q.predicate === PRIVATE_DATA_ANCHOR);

describe('partitionPublishAsyncQuads — privateDataAnchor coverage', () => {
  it('stamps the anchor on a MIXED public+private root', () => {
    const root = 'https://example.org/mixed';
    const out = partitionPublishAsyncQuads(
      [{ subject: root, predicate: NAME, object: '"public"', graph: '' }],
      [{ subject: root, predicate: SECRET, object: '"private"', graph: '' }],
    );
    expect(anchored(out.publicQuads, root)).toBe(true);
  });

  it('still stamps the anchor on a private-ONLY root (back-compat)', () => {
    const root = 'https://example.org/private-only';
    const out = partitionPublishAsyncQuads(
      [],
      [{ subject: root, predicate: SECRET, object: '"private"', graph: '' }],
    );
    expect(anchored(out.publicQuads, root)).toBe(true);
  });

  it('does NOT stamp the anchor on a public-only root', () => {
    const root = 'https://example.org/public-only';
    const out = partitionPublishAsyncQuads(
      [{ subject: root, predicate: NAME, object: '"public"', graph: '' }],
      [],
    );
    expect(anchored(out.publicQuads, root)).toBe(false);
  });

  it('does not double-anchor a mixed root', () => {
    const root = 'https://example.org/mixed-2';
    const out = partitionPublishAsyncQuads(
      [{ subject: root, predicate: NAME, object: '"public"', graph: '' }],
      [{ subject: root, predicate: SECRET, object: '"private"', graph: '' }],
    );
    const count = out.publicQuads.filter(
      (q) => q.subject === root && q.predicate === PRIVATE_DATA_ANCHOR,
    ).length;
    expect(count).toBe(1);
  });
});
