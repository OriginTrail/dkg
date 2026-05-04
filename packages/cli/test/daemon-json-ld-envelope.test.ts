/**
 * Unit tests for `wrapJsonLdContent` — the small helper that produces the
 * `{ public }` / `{ private }` envelope shape DKGAgent.publish() expects.
 *
 * The helper is the privacy boundary for any route that publishes a
 * JSON-LD KA. Keeping it tiny and well-tested means slice-02/07 (and any
 * future route that publishes a KA) can adopt it without re-deriving
 * envelope semantics.
 */

import { describe, expect, it } from 'vitest';
import { wrapJsonLdContent } from '../src/daemon/json-ld-envelope.js';

describe('wrapJsonLdContent', () => {
  it('wraps the document in { private: ... } when options.private is true', () => {
    const doc = { '@id': 'urn:test:1', 'foo:bar': 'baz' };

    const envelope = wrapJsonLdContent(doc, { private: true });

    expect(envelope).toEqual({ private: doc });
    expect(envelope).not.toHaveProperty('public');
  });

  it('wraps the document in { public: ... } when options.private is false', () => {
    const doc = { '@id': 'urn:test:2', 'foo:bar': 'qux' };

    const envelope = wrapJsonLdContent(doc, { private: false });

    expect(envelope).toEqual({ public: doc });
    expect(envelope).not.toHaveProperty('private');
  });

  it('preserves the document by reference (no copy)', () => {
    // The helper is a thin wrapper — it must NOT clone the document. A
    // copy would silently break callers that rely on identity (e.g. for
    // post-publish hooks that mutate the original).
    const doc = { '@id': 'urn:test:3' };

    const privateEnv = wrapJsonLdContent(doc, { private: true }) as { private: object };
    const publicEnv = wrapJsonLdContent(doc, { private: false }) as { public: object };

    expect(privateEnv.private).toBe(doc);
    expect(publicEnv.public).toBe(doc);
  });

  it('accepts an array of JSON-LD documents (graph form)', () => {
    // JsonLdDocument is `Record<string, unknown> | Record<string, unknown>[]`
    // so an array of objects must round-trip through the envelope unchanged.
    const docs = [{ '@id': 'urn:a' }, { '@id': 'urn:b' }];

    const envelope = wrapJsonLdContent(docs, { private: true }) as { private: unknown };

    expect(envelope.private).toBe(docs);
  });
});
