import { describe, expect, it } from 'vitest';
import { mapLiftRequestToPublishOptions, prepareAsyncPublishPayload, type LiftPublishMappingInput } from '../src/async-lift-publish-options.js';

describe('mapLiftRequestToPublishOptions', () => {
  function baseInput(): LiftPublishMappingInput {
    return {
      request: {
        swmId: 'swm-1',
        shareOperationId: 'op-1',
        roots: ['urn:local:/rihana'],
        contextGraphId: 'music-social',
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      },
      validation: {
        authorityProofRef: 'proof:owner:1',
        priorVersion: undefined,
        transitionType: 'CREATE',
      },
      resolved: {
        quads: [
          {
            subject: 'did:dkg:music-social:rihana',
            predicate: 'http://schema.org/name',
            object: '"Rihana"',
            graph: 'did:dkg:context-graph:music-social/_data',
          },
        ],
      },
    };
  }

  it('maps validated lift inputs onto canonical publish options', () => {
    const options = mapLiftRequestToPublishOptions({
      ...baseInput(),
      resolved: {
        ...baseInput().resolved,
        publisherPeerId: '12D3KooWPublisher',
        targetGraphUri: 'did:dkg:context-graph:music-social/_data',
        targetMetaGraphUri: 'did:dkg:context-graph:music-social/_meta',
        entityProofs: true,
      },
    });

    expect(options.contextGraphId).toBe('music-social');
    expect(options.publisherPeerId).toBe('12D3KooWPublisher');
    expect(options.accessPolicy).toBe('public');
    expect(options.entityProofs).toBe(true);
    expect(options.targetGraphUri).toBe('did:dkg:context-graph:music-social/_data');
    expect(options.targetMetaGraphUri).toBe('did:dkg:context-graph:music-social/_meta');
  });

  it('forwards the request subGraphName into canonical publish options', () => {
    const options = mapLiftRequestToPublishOptions({
      ...baseInput(),
      request: {
        ...baseInput().request,
        subGraphName: 'research',
      },
      resolved: {
        ...baseInput().resolved,
        publisherPeerId: '12D3KooWPublisher',
      },
    });

    expect(options.subGraphName).toBe('research');
  });

  it('defaults to ownerOnly when private quads are present', () => {
    const options = mapLiftRequestToPublishOptions({
      ...baseInput(),
      resolved: {
        ...baseInput().resolved,
        publisherPeerId: '12D3KooWPublisher',
        privateQuads: [
          {
            subject: 'did:dkg:music-social:rihana',
            predicate: 'http://schema.org/secret',
            object: '"top-secret"',
            graph: 'did:dkg:context-graph:music-social/_private',
          },
        ],
      },
    });

    expect(options.accessPolicy).toBe('ownerOnly');
    expect(options.privateQuads).toHaveLength(1);
  });

  it('normalizes allowList peers and forwards explicit access policy', () => {
    const options = mapLiftRequestToPublishOptions({
      ...baseInput(),
      resolved: {
        ...baseInput().resolved,
        publisherPeerId: '12D3KooWPublisher',
        accessPolicy: 'allowList',
        allowedPeers: [' peer-a ', 'peer-b', 'peer-a'],
      },
    });

    expect(options.accessPolicy).toBe('allowList');
    expect(options.allowedPeers).toEqual(['peer-a', 'peer-b']);
  });

  it('preserves private quads with explicit allowList handoff options', () => {
    const input = {
      ...baseInput(),
      resolved: {
        ...baseInput().resolved,
        publisherPeerId: ' 12D3KooWPublisher ',
        privateQuads: [
          {
            subject: 'did:dkg:music-social:rihana',
            predicate: 'http://schema.org/secret',
            object: '"top-secret"',
            graph: 'did:dkg:context-graph:music-social/_private',
          },
        ],
        accessPolicy: 'allowList',
        allowedPeers: [' peer-a ', 'peer-b', 'peer-a'],
      },
    } satisfies LiftPublishMappingInput;

    const prepared = prepareAsyncPublishPayload(input);

    expect(prepared.privateQuads).toEqual(input.resolved.privateQuads);
    expect(prepared.publishOptions.privateQuads).toEqual(input.resolved.privateQuads);
    expect(prepared.publishOptions.publisherPeerId).toBe('12D3KooWPublisher');
    expect(prepared.publishOptions.accessPolicy).toBe('allowList');
    expect(prepared.publishOptions.allowedPeers).toEqual(['peer-a', 'peer-b']);
  });

  it('requires publisherPeerId for non-public access', () => {
    expect(() =>
      mapLiftRequestToPublishOptions({
        ...baseInput(),
        resolved: {
          ...baseInput().resolved,
          accessPolicy: 'ownerOnly',
        },
      }),
    ).toThrow('Lift publish mapping requires publisherPeerId when accessPolicy is ownerOnly');
  });

  it('rejects allowList without allowed peers', () => {
    expect(() =>
      mapLiftRequestToPublishOptions({
        ...baseInput(),
        resolved: {
          ...baseInput().resolved,
          publisherPeerId: '12D3KooWPublisher',
          accessPolicy: 'allowList',
        },
      }),
    ).toThrow('Lift publish mapping requires non-empty allowedPeers for allowList access');
  });

  it('rejects allowed peers without allowList access', () => {
    expect(() =>
      mapLiftRequestToPublishOptions({
        ...baseInput(),
        resolved: {
          ...baseInput().resolved,
          allowedPeers: ['peer-a'],
        },
      }),
    ).toThrow('Lift publish mapping only allows allowedPeers when accessPolicy is allowList');
  });

  it('requires a validated authority proof ref even though it is not forwarded into PublishOptions', () => {
    expect(() =>
      mapLiftRequestToPublishOptions({
        ...baseInput(),
        validation: {
          authorityProofRef: '   ',
          priorVersion: undefined,
          transitionType: 'CREATE',
        },
      }),
    ).toThrow('Lift publish mapping requires a non-empty authorityProofRef');
  });

  it('requires validation priorVersion to match the request priorVersion', () => {
    expect(() =>
      mapLiftRequestToPublishOptions({
        ...baseInput(),
        request: {
          ...baseInput().request,
          priorVersion: 'did:dkg:mock:31337/0xabc/7',
        },
        validation: {
          authorityProofRef: 'proof:owner:1',
          priorVersion: 'did:dkg:mock:31337/0xdef/8',
          transitionType: 'CREATE',
        },
      }),
    ).toThrow('Lift publish mapping requires validation.priorVersion to match request.priorVersion');
  });

  it('normalizes authorityProofRef before storing it in the prepared payload', () => {
    const prepared = prepareAsyncPublishPayload({
      ...baseInput(),
      validation: {
        authorityProofRef: '  proof:owner:1  ',
        priorVersion: undefined,
        transitionType: 'CREATE',
      },
      resolved: {
        ...baseInput().resolved,
        publisherPeerId: '12D3KooWPublisher',
      },
    });

    expect(prepared.authorityProofRef).toBe('proof:owner:1');
  });

  it('requires validation transitionType to match the request transitionType', () => {
    expect(() =>
      prepareAsyncPublishPayload({
        ...baseInput(),
        request: {
          ...baseInput().request,
          transitionType: 'MUTATE',
        },
        validation: {
          authorityProofRef: 'proof:owner:1',
          priorVersion: undefined,
          transitionType: 'CREATE',
        },
      }),
    ).toThrow('Lift publish mapping requires validation.transitionType to match request.transitionType');
  });

  it('packages the internal async-to-publish handoff contract', () => {
    const input = {
      ...baseInput(),
      request: {
        ...baseInput().request,
        transitionType: 'MUTATE',
        priorVersion: 'did:dkg:mock:31337/0xabc/7',
      },
      validation: {
        authorityProofRef: 'proof:owner:1',
        priorVersion: 'did:dkg:mock:31337/0xabc/7',
        transitionType: 'MUTATE',
      },
      resolved: {
        ...baseInput().resolved,
        publisherPeerId: '12D3KooWPublisher',
        privateQuads: [
          {
            subject: 'did:dkg:music-social:rihana',
            predicate: 'http://schema.org/secret',
            object: '"top-secret"',
            graph: 'did:dkg:context-graph:music-social/_private',
          },
        ],
      },
    } satisfies LiftPublishMappingInput;

    const prepared = prepareAsyncPublishPayload(input);

    expect(prepared.contextGraphId).toBe('music-social');
    expect(prepared.scope).toBe('person-profile');
    expect(prepared.transitionType).toBe('MUTATE');
    expect(prepared.authority).toEqual({ type: 'owner', proofRef: 'proof:owner:1' });
    expect(prepared.authorityProofRef).toBe('proof:owner:1');
    expect(prepared.priorVersion).toBe('did:dkg:mock:31337/0xabc/7');
    expect(prepared.quads).toEqual(input.resolved.quads);
    expect(prepared.privateQuads).toEqual(input.resolved.privateQuads);
    expect(prepared.publishOptions.contextGraphId).toBe('music-social');
    expect(prepared.publishOptions.publisherPeerId).toBe('12D3KooWPublisher');
    expect(prepared.publishOptions.accessPolicy).toBe('ownerOnly');
    expect(prepared.publishOptions.privateQuads).toEqual(input.resolved.privateQuads);
  });

  it('accepts trimmed priorVersion consistently across validation and mapping semantics', () => {
    const options = mapLiftRequestToPublishOptions({
      ...baseInput(),
      request: {
        ...baseInput().request,
        transitionType: 'MUTATE',
        priorVersion: '  did:dkg:mock:31337/0xabc/7  ',
      },
      validation: {
        authorityProofRef: 'proof:owner:1',
        priorVersion: 'did:dkg:mock:31337/0xabc/7',
        transitionType: 'MUTATE',
      },
      resolved: {
        ...baseInput().resolved,
        publisherPeerId: '12D3KooWPublisher',
      },
    });

    expect(options.contextGraphId).toBe('music-social');
  });

  it('threads request.seal byte-for-byte into PublishOptions.precomputedAttestation', () => {
    // This is the linchpin of the agent-side seal model: a seal
    // computed and signed by the AGENT (any wallet — not necessarily
    // the publisher's) must land in the publisher's
    // `precomputedAttestation` slot WITHOUT modification, so the
    // existing SEAL INTEGRITY PREFLIGHT validates it as-is. Hex →
    // bytes is the only conversion this layer applies.
    const customAuthor = '0xAaaAAaaaAaaaaaAAAaAaaaaaAAAaaaaAaAaAAaaA' as `0x${string}`;
    const merkleRootHex = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
    const sigR = ('0x' + 'bb'.repeat(32)) as `0x${string}`;
    const sigVs = ('0x' + 'cc'.repeat(32)) as `0x${string}`;

    const options = mapLiftRequestToPublishOptions({
      ...baseInput(),
      request: {
        ...baseInput().request,
        seal: {
          merkleRoot: merkleRootHex,
          authorAddress: customAuthor,
          signature: { r: sigR, vs: sigVs },
          schemeVersion: 1,
        },
      },
      resolved: {
        ...baseInput().resolved,
        publisherPeerId: '12D3KooWPublisher',
      },
    });

    expect(options.precomputedAttestation).toBeDefined();
    const seal = options.precomputedAttestation!;
    expect(seal.authorAddress).toBe(customAuthor);
    expect(seal.schemeVersion).toBe(1);
    expect(seal.expectedMerkleRoot).toEqual(new Uint8Array(32).fill(0xaa));
    expect(seal.signature.r).toEqual(new Uint8Array(32).fill(0xbb));
    expect(seal.signature.vs).toEqual(new Uint8Array(32).fill(0xcc));
  });

  it('rejects malformed hex in seal.merkleRoot instead of silently zeroing bytes', () => {
    // Codex caught a real bug: the old `parseInt(pair, 16)` produced
    // `NaN` for non-hex characters, which `Uint8Array` then coerced to
    // `0` — silently corrupting the attestation bytes rather than
    // failing the job. The fix routes through a validating decoder
    // (`ethers.getBytes`) so non-hex content throws at the boundary.
    const customAuthor = '0xAaaAAaaaAaaaaaAAAaAaaaaaAAAaAAAaAAAaaaaa' as `0x${string}`;
    expect(() =>
      mapLiftRequestToPublishOptions({
        ...baseInput(),
        request: {
          ...baseInput().request,
          seal: {
            merkleRoot: ('0x' + 'zz'.repeat(32)) as `0x${string}`,
            authorAddress: customAuthor,
            signature: {
              r: ('0x' + 'bb'.repeat(32)) as `0x${string}`,
              vs: ('0x' + 'cc'.repeat(32)) as `0x${string}`,
            },
            schemeVersion: 1,
          },
        },
        resolved: {
          ...baseInput().resolved,
          publisherPeerId: '12D3KooWPublisher',
        },
      }),
    ).toThrow();
  });

  it('rejects wrong-length seal.merkleRoot (must be 32 bytes)', () => {
    // Defensive length validation: a malformed seal that decodes
    // cleanly as hex but has the wrong byte count would slip past
    // `ethers.getBytes` alone. Bind expected lengths explicitly so
    // the attestation can't be silently truncated/padded.
    const customAuthor = '0xAaaAAaaaAaaaaaAAAaAaaaaaAAAaAAAaAAAaaaaa' as `0x${string}`;
    expect(() =>
      mapLiftRequestToPublishOptions({
        ...baseInput(),
        request: {
          ...baseInput().request,
          seal: {
            merkleRoot: ('0x' + 'aa'.repeat(16)) as `0x${string}`, // 16 bytes, not 32
            authorAddress: customAuthor,
            signature: {
              r: ('0x' + 'bb'.repeat(32)) as `0x${string}`,
              vs: ('0x' + 'cc'.repeat(32)) as `0x${string}`,
            },
            schemeVersion: 1,
          },
        },
        resolved: {
          ...baseInput().resolved,
          publisherPeerId: '12D3KooWPublisher',
        },
      }),
    ).toThrow(/merkleRoot|32 bytes/);
  });

  it('rejects wrong-length seal.signature.r (must be 32 bytes)', () => {
    const customAuthor = '0xAaaAAaaaAaaaaaAAAaAaaaaaAAAaAAAaAAAaaaaa' as `0x${string}`;
    expect(() =>
      mapLiftRequestToPublishOptions({
        ...baseInput(),
        request: {
          ...baseInput().request,
          seal: {
            merkleRoot: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
            authorAddress: customAuthor,
            signature: {
              r: ('0x' + 'bb'.repeat(16)) as `0x${string}`, // 16 bytes
              vs: ('0x' + 'cc'.repeat(32)) as `0x${string}`,
            },
            schemeVersion: 1,
          },
        },
        resolved: {
          ...baseInput().resolved,
          publisherPeerId: '12D3KooWPublisher',
        },
      }),
    ).toThrow(/signature\.r|32 bytes/);
  });

  it('forwards request.entityProofs to PublishOptions.entityProofs (overrides resolved.entityProofs)', () => {
    // Caller intent at enqueue (`request`) > per-process resolution defaults (`resolved`).
    const options = mapLiftRequestToPublishOptions({
      ...baseInput(),
      request: {
        ...baseInput().request,
        entityProofs: true,
      },
      resolved: {
        ...baseInput().resolved,
        publisherPeerId: '12D3KooWPublisher',
        // Even if resolution layer set false, request layer wins.
        entityProofs: false,
      },
    });

    expect(options.entityProofs).toBe(true);
  });

  it('falls back to resolved.entityProofs when request.entityProofs is undefined', () => {
    const options = mapLiftRequestToPublishOptions({
      ...baseInput(),
      resolved: {
        ...baseInput().resolved,
        publisherPeerId: '12D3KooWPublisher',
        entityProofs: true,
      },
    });

    expect(options.entityProofs).toBe(true);
  });

  it('parses request.publisherNodeIdentityIdOverride (stringified bigint) into PublishOptions (bigint)', () => {
    // BigInt persisted as `${bigint}` for JSON safety; mapper parses back.
    const options = mapLiftRequestToPublishOptions({
      ...baseInput(),
      request: {
        ...baseInput().request,
        publisherNodeIdentityIdOverride: '42',
      },
      resolved: {
        ...baseInput().resolved,
        publisherPeerId: '12D3KooWPublisher',
      },
    });

    expect(options.publisherNodeIdentityIdOverride).toBe(42n);
  });

  it('preserves publisherNodeIdentityIdOverride === 0n (RFC-001 §4 mode d "no attribution")', () => {
    // `'0'` is meaningful (no attribution), not "absent". The mapper
    // distinguishes `'0'` from `undefined` using a strict `!== undefined`
    // check rather than truthy coercion.
    const options = mapLiftRequestToPublishOptions({
      ...baseInput(),
      request: {
        ...baseInput().request,
        publisherNodeIdentityIdOverride: '0',
      },
      resolved: {
        ...baseInput().resolved,
        publisherPeerId: '12D3KooWPublisher',
      },
    });

    expect(options.publisherNodeIdentityIdOverride).toBe(0n);
  });

  it('omits publisherNodeIdentityIdOverride from PublishOptions when request value is undefined', () => {
    // When the caller never set the override, the field stays absent
    // from `PublishOptions` so the publisher uses its persistent
    // identity (pre-RFC-001 single-tenant semantics).
    const options = mapLiftRequestToPublishOptions({
      ...baseInput(),
      resolved: {
        ...baseInput().resolved,
        publisherPeerId: '12D3KooWPublisher',
      },
    });

    expect(options.publisherNodeIdentityIdOverride).toBeUndefined();
  });

  it('does NOT set precomputedAttestation when request.seal is absent', () => {
    const options = mapLiftRequestToPublishOptions({
      ...baseInput(),
      resolved: {
        ...baseInput().resolved,
        publisherPeerId: '12D3KooWPublisher',
      },
    });
    expect(options.precomputedAttestation).toBeUndefined();
  });
});
