import { describe, it, expect } from 'vitest';
import {
  buildEndorsementQuads,
  DKG_ENDORSES,
  DKG_ENDORSED_AT,
  DKG_ENDORSED_BY,
  DKG_ENDORSEMENT_CLASS,
  DKG_ENDORSEMENT_NONCE,
  DKG_ENDORSEMENT_SIGNATURE,
  RDF_TYPE,
} from '../src/endorse.js';

describe('buildEndorsementQuads', () => {
  it('produces correct endorsement triples keyed on the per-event endorsement subject', () => {
    const quads = buildEndorsementQuads(
      '0xAbc123',
      'did:dkg:base:84532/0xDef.../42',
      'ml-research',
    );

    // the endorsement now has
    // its own per-event resource (a deterministic URN) carrying the
    // UAL, endorser, timestamp, nonce, and signature tuple. The
    // agent URI is the OBJECT of `endorsedBy`, not the subject, so
    // two endorsements by the same agent can't collide on the proof
    // fields.
    expect(quads).toHaveLength(6);

    const typeQuad = quads.find((q) => q.predicate === RDF_TYPE);
    expect(typeQuad).toBeDefined();
    expect(typeQuad!.object).toBe(`<${DKG_ENDORSEMENT_CLASS}>`);

    const endorseQuad = quads.find((q) => q.predicate === DKG_ENDORSES);
    expect(endorseQuad).toBeDefined();
    expect(endorseQuad!.subject).toMatch(/^urn:dkg:endorsement:[0-9a-f]{64}$/);
    expect(endorseQuad!.object).toBe('did:dkg:base:84532/0xDef.../42');
    expect(endorseQuad!.graph).toBe('did:dkg:context-graph:ml-research');

    const byQuad = quads.find((q) => q.predicate === DKG_ENDORSED_BY);
    expect(byQuad).toBeDefined();
    // the agent is the object of `endorsedBy`, not the subject
    // of `endorses`. This is what keeps proof quads paired.
    expect(byQuad!.subject).toBe(endorseQuad!.subject);
    expect(byQuad!.object).toBe('did:dkg:agent:0xAbc123');
    expect(byQuad!.graph).toBe('did:dkg:context-graph:ml-research');

    const timestampQuad = quads.find((q) => q.predicate === DKG_ENDORSED_AT);
    expect(timestampQuad).toBeDefined();
    expect(timestampQuad!.subject).toBe(endorseQuad!.subject);
    expect(timestampQuad!.object).toMatch(/^\"\d{4}-\d{2}-\d{2}T/);
    expect(timestampQuad!.graph).toBe('did:dkg:context-graph:ml-research');

    // All six quads must share the SAME endorsement subject — this
    // is the whole point of r19-3.
    for (const q of quads) {
      expect(q.subject).toBe(endorseQuad!.subject);
    }
  });

  it('uses agent DID format for the endorsedBy object', () => {
    const quads = buildEndorsementQuads('0xDEF456', 'ual:test', 'cg-1');
    const byQuad = quads.find((q) => q.predicate === DKG_ENDORSED_BY);
    expect(byQuad!.object).toBe('did:dkg:agent:0xDEF456');
  });

  it('uses context graph data URI for graph', () => {
    const quads = buildEndorsementQuads('0x1', 'ual:1', 'my-project');
    for (const q of quads) {
      expect(q.graph).toBe('did:dkg:context-graph:my-project');
    }
  });

  // The core bug the bot
  // flagged: before the fix, two endorsements by the same agent
  // in the same context graph piled FOUR timestamps, FOUR nonces,
  // and FOUR signatures on a single `did:dkg:agent:<address>`
  // subject with no way to pair them. These tests lock the fix.
  it('two endorsements by the SAME agent in the SAME context graph produce DISTINCT endorsement subjects', () => {
    const q1 = buildEndorsementQuads('0xSameAgent', 'ual:asset-1', 'cg');
    const q2 = buildEndorsementQuads('0xSameAgent', 'ual:asset-2', 'cg');
    const e1 = q1.find((q) => q.predicate === DKG_ENDORSES)!.subject;
    const e2 = q2.find((q) => q.predicate === DKG_ENDORSES)!.subject;
    expect(e1).not.toBe(e2);
    expect(e1).toMatch(/^urn:dkg:endorsement:[0-9a-f]{64}$/);
    expect(e2).toMatch(/^urn:dkg:endorsement:[0-9a-f]{64}$/);

    // Both tuples remain internally consistent — each endorsement's
    // proof fields hang off its own subject, never mixed.
    const merged = [...q1, ...q2];
    const sig1 = merged.find(
      (q) => q.subject === e1 && q.predicate === DKG_ENDORSEMENT_SIGNATURE,
    );
    const sig2 = merged.find(
      (q) => q.subject === e2 && q.predicate === DKG_ENDORSEMENT_SIGNATURE,
    );
    expect(sig1).toBeDefined();
    expect(sig2).toBeDefined();
    expect(sig1!.object).not.toBe(sig2!.object);

    const nonce1 = merged.find(
      (q) => q.subject === e1 && q.predicate === DKG_ENDORSEMENT_NONCE,
    );
    const nonce2 = merged.find(
      (q) => q.subject === e2 && q.predicate === DKG_ENDORSEMENT_NONCE,
    );
    expect(nonce1!.object).not.toBe(nonce2!.object);
  });

  it('the endorsement URN is DETERMINISTIC — same inputs regenerate byte-identical quads', () => {
    // Idempotence: retries (same agent, UAL, CG, ts, nonce) must
    // produce the same quads so duplicate publishes don't accumulate
    // multiple endorsement resources for what is logically one
    // endorsement event.
    const now = new Date('2025-01-01T00:00:00.000Z');
    const nonce = '0x' + 'ab'.repeat(16);
    const opts = { now, nonce };
    const q1 = buildEndorsementQuads('0xAgent', 'ual:1', 'cg', opts);
    const q2 = buildEndorsementQuads('0xAgent', 'ual:1', 'cg', opts);
    expect(q1).toEqual(q2);

    // And changing ANY component of the canonical tuple (UAL, ts,
    // nonce, CG, agent) yields a different endorsement subject.
    const q3 = buildEndorsementQuads('0xAgent', 'ual:2', 'cg', opts);
    const e1 = q1.find((q) => q.predicate === DKG_ENDORSES)!.subject;
    const e3 = q3.find((q) => q.predicate === DKG_ENDORSES)!.subject;
    expect(e1).not.toBe(e3);
  });

  it('every quad in a single endorsement emission shares one subject', () => {
    // Shape invariant: verifiers expect to reconstruct the canonical
    // digest from six quads hanging off a SINGLE endorsement subject.
    // If a future refactor ever split a subset onto a different URI,
    // downstream signature verification would silently break — this
    // test pins the invariant.
    const quads = buildEndorsementQuads('0xAgent', 'ual:1', 'cg');
    const subjects = new Set(quads.map((q) => q.subject));
    expect(subjects.size).toBe(1);
    expect([...subjects][0]).toMatch(/^urn:dkg:endorsement:[0-9a-f]{64}$/);

    // All six predicates MUST appear exactly once each.
    const predicates = quads.map((q) => q.predicate).sort();
    expect(predicates).toEqual([
      DKG_ENDORSES,
      DKG_ENDORSED_AT,
      DKG_ENDORSED_BY,
      DKG_ENDORSEMENT_NONCE,
      DKG_ENDORSEMENT_SIGNATURE,
      RDF_TYPE,
    ].sort());
  });
});
