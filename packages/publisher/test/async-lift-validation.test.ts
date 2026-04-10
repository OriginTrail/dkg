import { describe, expect, it } from 'vitest';
import { validateLiftPublishPayload, type LiftValidationInput } from '../src/index.js';
import { sha256 } from '@origintrail-official/dkg-core';

describe('validateLiftPublishPayload', () => {
  function baseInput(): LiftValidationInput {
    return {
      request: {
        swmId: 'swm-main',
        shareOperationId: 'swm-1',
        roots: ['urn:local:/rihana'],
        contextGraphId: 'music-social',
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      },
      resolved: {
        quads: [
          {
            subject: 'urn:local:/rihana',
            predicate: 'http://schema.org/name',
            object: '"Rihana"',
            graph: '',
          },
          {
            subject: 'urn:local:/rihana/.well-known/genid/child-1',
            predicate: 'http://schema.org/value',
            object: '"Nested"',
            graph: '',
          },
          {
            subject: 'urn:local:/rihana',
            predicate: 'http://schema.org/friend',
            object: 'urn:local:/rihana',
            graph: '',
          },
        ],
        privateQuads: [
          {
            subject: 'urn:local:/rihana',
            predicate: 'http://schema.org/secret',
            object: '"hidden"',
            graph: '',
          },
        ],
        publisherPeerId: 'peer-1',
      },
    };
  }

  function canonicalRoot(root: string): string {
    const digest = sha256(new TextEncoder().encode(root));
    const suffix = Array.from(digest)
      .slice(0, 6)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return `dkg:music-social:aloha:person-profile/rihana-${suffix}`;
  }

  it('validates and canonicalizes resolved lift payloads', () => {
    const validated = validateLiftPublishPayload(baseInput());
    const expectedCanonicalRoot = canonicalRoot('urn:local:/rihana');

    expect(validated.validation).toEqual({
      canonicalRoots: [expectedCanonicalRoot],
      canonicalRootMap: {
        'urn:local:/rihana': expectedCanonicalRoot,
      },
      swmQuadCount: 4,
      authorityProofRef: 'proof:owner:1',
      transitionType: 'CREATE',
      priorVersion: undefined,
    });

    expect(validated.resolved.quads.map((quad) => quad.subject)).toEqual([
      expectedCanonicalRoot,
      `${expectedCanonicalRoot}/.well-known/genid/child-1`,
      expectedCanonicalRoot,
    ]);
    expect(validated.resolved.quads[2]?.object).toBe(expectedCanonicalRoot);
    expect(validated.resolved.privateQuads?.[0]?.subject).toBe(expectedCanonicalRoot);
  });

  it('rejects missing authority proof refs', () => {
    expect(() =>
      validateLiftPublishPayload({
        ...baseInput(),
        request: {
          ...baseInput().request,
          authority: { type: 'owner', proofRef: '   ' },
        },
      }),
    ).toThrow('Lift validation requires a non-empty authority proof reference');
  });

  it('rejects CREATE transitions with a priorVersion', () => {
    expect(() =>
      validateLiftPublishPayload({
        ...baseInput(),
        request: {
          ...baseInput().request,
          priorVersion: 'did:dkg:mock:31337/0xabc/7',
        },
      }),
    ).toThrow('Lift validation rejects priorVersion for CREATE transitions');
  });

  it('requires priorVersion for MUTATE and REVOKE transitions', () => {
    expect(() =>
      validateLiftPublishPayload({
        ...baseInput(),
        request: {
          ...baseInput().request,
          transitionType: 'MUTATE',
        },
      }),
    ).toThrow('Lift validation requires priorVersion for MUTATE transitions');
  });

  it('rejects blank priorVersion for MUTATE transitions', () => {
    expect(() =>
      validateLiftPublishPayload({
        ...baseInput(),
        request: {
          ...baseInput().request,
          transitionType: 'MUTATE',
          priorVersion: '   ',
        },
      }),
    ).toThrow('Lift validation requires priorVersion for MUTATE transitions');
  });

  it('rejects empty resolved shared-memory slices', () => {
    expect(() =>
      validateLiftPublishPayload({
        ...baseInput(),
        resolved: {
          quads: [],
        },
      }),
    ).toThrow('Lift validation requires at least one resolved shared-memory quad');
  });

  it('rejects resolved subjects outside the requested roots', () => {
    expect(() =>
      validateLiftPublishPayload({
        ...baseInput(),
        resolved: {
          ...baseInput().resolved,
          quads: [
            {
              subject: 'urn:local:/intruder',
              predicate: 'http://schema.org/name',
              object: '"Nope"',
              graph: '',
            },
          ],
        },
      }),
    ).toThrow('Lift validation found subject outside requested roots: urn:local:/intruder');
  });

  it('keeps canonical roots distinct for roots with the same tail', () => {
    const validated = validateLiftPublishPayload({
      ...baseInput(),
      request: {
        ...baseInput().request,
        roots: ['urn:local:/rihana', 'did:other:rihana'],
      },
      resolved: {
        ...baseInput().resolved,
        quads: [
          {
            subject: 'urn:local:/rihana',
            predicate: 'http://schema.org/name',
            object: '"One"',
            graph: '',
          },
          {
            subject: 'did:other:rihana',
            predicate: 'http://schema.org/name',
            object: '"Two"',
            graph: '',
          },
        ],
        privateQuads: undefined,
      },
    });

    expect(new Set(validated.validation.canonicalRoots).size).toBe(2);
  });
});
