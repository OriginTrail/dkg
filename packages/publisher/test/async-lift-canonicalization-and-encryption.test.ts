/**
 * Liveness/regression tests for two async-lift publish gaps.
 *
 *  GH #1122 — "Sync and async publish canonicalize root subjects differently".
 *            The async lift validator rewrites caller-provided root IRIs to
 *            generated `dkg:<cg>:<ns>:<scope>/<name>-<hash>` roots, so the same
 *            domain payload yields different RDF subjects than sync publish —
 *            breaking stable IRI linking for integrations.
 *            https://github.com/OriginTrail/dkg/issues/1122
 *
 *  GH #1121 — "publishAsync should support encrypted VM publishing for
 *            curated/private context graphs". The sync path resolves
 *            `encryptInlinePayload` / `encryptInlineChunked`; the async-lift
 *            PublishOptions mapping carries no encryption path, so a private-CG
 *            async publish would ship plaintext to cores.
 *            https://github.com/OriginTrail/dkg/issues/1121
 *
 * Both are `it.fails` repros: the assertion of the correct (sync-parity)
 * behaviour fails today. When fixed, drop `.fails` and close the issue.
 * Hermetic — pure functions, no chain/network.
 */
import { describe, expect, it } from 'vitest';
import { validateLiftPublishPayload } from '../src/async-lift-validation.js';
import { mapLiftRequestToPublishOptions } from '../src/async-lift-publish-options.js';
import type { LiftRequest } from '../src/lift-job-types.js';

const CALLER_ROOT = 'urn:dmaast:tenant:tenant-a';

const baseRequest: LiftRequest = {
  swmId: 'swm-main',
  shareOperationId: 'op-1122',
  roots: [CALLER_ROOT],
  contextGraphId: 'dmaast',
  namespace: 'tenants',
  scope: 'devnet',
  transitionType: 'CREATE',
  authority: { type: 'owner', proofRef: 'devnet-proof' },
};

describe('GH #1122 — async lift preserves caller-provided root IRIs (sync parity)', () => {
  it('does not rewrite a caller root IRI to a generated dkg:… subject', () => {
    const out = validateLiftPublishPayload({
      request: baseRequest,
      resolved: {
        quads: [
          { subject: CALLER_ROOT, predicate: 'https://schema.org/name', object: '"Tenant A"', graph: 'g' },
        ],
      },
    });
    // Sync publish keeps the caller IRI as the subject; async must match.
    expect(out.resolved.quads[0].subject).toBe(CALLER_ROOT);
  });
});

describe('GH #1121 — async lift carries an inline-encryption path for private CGs', () => {
  it('a private (ownerOnly) async publish maps to PublishOptions with an encryption callback', () => {
    const opts = mapLiftRequestToPublishOptions({
      request: { ...baseRequest, accessPolicy: 'ownerOnly' },
      validation: { authorityProofRef: 'devnet-proof', transitionType: 'CREATE' },
      resolved: {
        quads: [
          { subject: CALLER_ROOT, predicate: 'https://schema.org/name', object: '"Tenant A"', graph: 'g' },
        ],
        accessPolicy: 'ownerOnly',
        publisherPeerId: '12D3KooWGH1121PrivatePublisherPeerIdForTest',
      },
    });
    expect(opts.accessPolicy).toBe('ownerOnly');
    // A private publish must not ship plaintext to cores — there has to be an
    // inline-encryption path threaded through, like the sync publish() does.
    expect(opts.encryptInlinePayload).toBeDefined();
  });
});
