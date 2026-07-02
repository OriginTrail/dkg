import { describe, expect, it } from 'vitest';
import { mapLiftRequestToPublishOptions, prepareAsyncPublishPayload, isFailClosedInlineEncrypt, type LiftPublishMappingInput } from '../src/async-lift-publish-options.js';

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
    ).toThrow('Lift publish mapping requires validation.transitionType to match request metadata transitionType');
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
          // §F2 — packed (uint160(author) << 96) | number, persisted as a
          // stringified bigint, must round-trip into precomputedAttestation.
          reservedKaId: `${(BigInt(customAuthor) << 96n) | 42n}` as `${bigint}`,
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
    // §F2 — the publisher mints exactly this id (ensureReservedKaId reuses it).
    expect(seal.reservedKaId).toBe((BigInt(customAuthor) << 96n) | 42n);
  });

  it('reads reservedKaId as 0n for a legacy seal persisted before §F2 binding', () => {
    // Backward-compat: a lift job enqueued before async reservedKaId binding has
    // no `reservedKaId` field. The mapper must read it as 0n (the legacy
    // namespace-mismatched value the on-chain mint rejects) rather than throwing
    // on `BigInt(undefined)`.
    const merkleRootHex = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
    const options = mapLiftRequestToPublishOptions({
      ...baseInput(),
      request: {
        ...baseInput().request,
        seal: {
          merkleRoot: merkleRootHex,
          authorAddress: '0xAaaAAaaaAaaaaaAAAaAaaaaaAAAaaaaAaAaAAaaA' as `0x${string}`,
          signature: {
            r: ('0x' + 'bb'.repeat(32)) as `0x${string}`,
            vs: ('0x' + 'cc'.repeat(32)) as `0x${string}`,
          },
          schemeVersion: 1,
          // no reservedKaId — pre-§F2 seal shape
        },
      },
      resolved: { ...baseInput().resolved, publisherPeerId: '12D3KooWPublisher' },
    });

    expect(options.precomputedAttestation?.reservedKaId).toBe(0n);
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

  it('forwards request.publishEpochs to PublishOptions', () => {
    const options = mapLiftRequestToPublishOptions({
      ...baseInput(),
      request: {
        ...baseInput().request,
        publishEpochs: 7,
      },
      resolved: {
        ...baseInput().resolved,
        publisherPeerId: '12D3KooWPublisher',
      },
    });

    expect(options.publishEpochs).toBe(7);
  });

  it('rejects invalid request.publishEpochs before building PublishOptions', () => {
    expect(() =>
      mapLiftRequestToPublishOptions({
        ...baseInput(),
        request: {
          ...baseInput().request,
          publishEpochs: 0,
        },
        resolved: {
          ...baseInput().resolved,
          publisherPeerId: '12D3KooWPublisher',
        },
      }),
    ).toThrow(/request\.publishEpochs.*positive uint32 integer/);
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

// GH #1121 follow-up — the inline-encryption callback precedence/forcing that
// `async-lift-publisher-impl` depends on, asserted at the `prepareAsyncPublishPayload`
// seam the impl actually calls (not just the lower-level mapper). The impl threads
// `prepared.publishOptions` straight into `publishExecutor`/`publisher.publish`, so
// whatever lands here is exactly what the publisher's `useEncryptedInline` gate sees.
describe('prepareAsyncPublishPayload — inline-encryption callback handoff to publisher.publish', () => {
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

  it('forwards the agent-resolved real encryption factory into publishOptions (NOT the fail-closed default) for a non-public publish', () => {
    // KoOvD: the impl hands `prepared.publishOptions` to `publishExecutor`, which
    // calls `publisher.publish`. If the mapper ever shadowed the real factory with
    // the throwing fail-closed default, every private async publish would throw at
    // encryption time. Pin that the REAL closure reaches the publish boundary.
    const realInline = async (b: Uint8Array): Promise<Uint8Array> => new Uint8Array([...b, 0xff]);
    const realChunked = async (): Promise<void> => { /* member key fan-out */ };
    const prepared = prepareAsyncPublishPayload({
      ...baseInput(),
      request: { ...baseInput().request, accessPolicy: 'ownerOnly' },
      resolved: {
        ...baseInput().resolved,
        accessPolicy: 'ownerOnly',
        publisherPeerId: '12D3KooWPublisher',
        encryptInlinePayload: realInline,
        encryptInlineChunked: realChunked,
      },
    });
    expect(prepared.publishOptions.accessPolicy).toBe('ownerOnly');
    expect(prepared.publishOptions.encryptInlinePayload).toBe(realInline);
    expect(prepared.publishOptions.encryptInlineChunked).toBe(realChunked);
    expect(isFailClosedInlineEncrypt(prepared.publishOptions.encryptInlinePayload)).toBe(false);
  });

  it('hands the fail-closed default to publisher.publish for a non-public publish with NO resolved factory (so it throws rather than leaking plaintext)', () => {
    // When no factory is wired, the publish boundary must receive the throwing
    // fail-closed marker — never `undefined`, which would silently ship plaintext.
    const prepared = prepareAsyncPublishPayload({
      ...baseInput(),
      request: { ...baseInput().request, accessPolicy: 'ownerOnly' },
      resolved: {
        ...baseInput().resolved,
        accessPolicy: 'ownerOnly',
        publisherPeerId: '12D3KooWPublisher',
      },
    });
    expect(prepared.publishOptions.encryptInlinePayload).toBeDefined();
    expect(isFailClosedInlineEncrypt(prepared.publishOptions.encryptInlinePayload)).toBe(true);
  });

  it('hands publisher.publish NO inline-encryption callbacks for a public publish, even when the resolver supplies them', () => {
    // KoOvA at the handoff boundary: a stray resolver/default callback must not
    // reach the publisher for a public CG, or its `useEncryptedInline` gate would
    // encrypt public content at rest. Both inline callbacks must be undefined.
    const strayInline = async (b: Uint8Array): Promise<Uint8Array> => new Uint8Array([...b, 0xff]);
    const strayChunked = async (): Promise<void> => { /* would fan out members */ };
    const prepared = prepareAsyncPublishPayload({
      ...baseInput(),
      request: { ...baseInput().request, accessPolicy: 'public' },
      resolved: {
        ...baseInput().resolved,
        accessPolicy: 'public',
        encryptInlinePayload: strayInline,
        encryptInlineChunked: strayChunked,
      },
    });
    expect(prepared.publishOptions.accessPolicy).toBe('public');
    expect(prepared.publishOptions.encryptInlinePayload).toBeUndefined();
    expect(prepared.publishOptions.encryptInlineChunked).toBeUndefined();
  });
});
