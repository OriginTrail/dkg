import { describe, expect, it } from 'vitest';
import {
  decodeKnowledgeAssetContentEnvelope,
  serializeKnowledgeAssetContentEnvelope,
} from '../src/index.js';

describe('publisher-owned Knowledge Asset content envelope', () => {
  it('round-trips one complete graph-scoped public/private commitment', () => {
    const privateMerkleRoot = `0x${'ab'.repeat(32)}` as const;
    const envelope = {
      contentScopeVersion: 2,
      kaUal: 'did:dkg:31337/0x1111111111111111111111111111111111111111/7',
      assertionVersion: '3',
      publicTripleCount: 2,
      privateMerkleRoot,
      privateTripleCount: 4,
    } as const;

    expect(serializeKnowledgeAssetContentEnvelope(envelope)).toEqual(envelope);
    expect(decodeKnowledgeAssetContentEnvelope(envelope)).toEqual(envelope);
  });

  it('rejects an incomplete graph-scoped commitment instead of filtering it', () => {
    expect(() => decodeKnowledgeAssetContentEnvelope({
      contentScopeVersion: 2,
      kaUal: 'did:dkg:31337/0x1111111111111111111111111111111111111111/7',
      assertionVersion: '3',
      publicTripleCount: 2,
    })).toThrow('privateTripleCount');
  });

  it.each([
    {
      label: 'private triples without a root',
      privateTripleCount: 1,
    },
    {
      label: 'a private root without private triples',
      privateTripleCount: 0,
      privateMerkleRoot: `0x${'ab'.repeat(32)}`,
    },
    {
      label: 'a private root that is not 32 bytes',
      privateTripleCount: 1,
      privateMerkleRoot: '0xab',
    },
  ])('rejects $label', ({ privateTripleCount, privateMerkleRoot }) => {
    expect(() => decodeKnowledgeAssetContentEnvelope({
      contentScopeVersion: 2,
      kaUal: 'did:dkg:31337/0x1111111111111111111111111111111111111111/7',
      assertionVersion: '3',
      publicTripleCount: 2,
      privateTripleCount,
      ...(privateMerkleRoot !== undefined ? { privateMerkleRoot } : {}),
    })).toThrow('private');
  });

  it('filters graph-only fields from legacy responses instead of accepting a partial v2 envelope', () => {
    expect(decodeKnowledgeAssetContentEnvelope({
      contentScopeVersion: 1,
      kaUal: 'did:dkg:legacy',
      privateTripleCount: 4,
    })).toEqual({ contentScopeVersion: 1 });

    expect(decodeKnowledgeAssetContentEnvelope({
      kaUal: 'did:dkg:legacy',
      privateTripleCount: 4,
    })).toEqual({});
  });

  it('rejects unsupported content-scope versions', () => {
    expect(() => decodeKnowledgeAssetContentEnvelope({ contentScopeVersion: 3 }))
      .toThrow('unsupported contentScopeVersion');
  });

  it('keeps descriptor-less legacy responses readable', () => {
    expect(decodeKnowledgeAssetContentEnvelope({ jobId: 'legacy-job' })).toEqual({});
  });
});
