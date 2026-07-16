/**
 * Regression test for GH #1122 — "Sync and async publish canonicalize root
 * subjects differently". https://github.com/OriginTrail/dkg/issues/1122
 *
 * Fix: the async lift now PRESERVES caller-provided root IRIs (identity),
 * matching the synchronous publish path (`canonicalPublishPayload` →
 * `skolemizeByEntity`, which keeps the caller `rootEntity`). It no longer
 * rewrites them to a generated `dkg:<cg>:<ns>:<scope>/<name>-<hash>` form.
 */
import { describe, expect, it } from 'vitest';
import { validateLiftPublishPayload, canonicalRootIri } from '../src/async-lift-validation.js';
import type { LiftRequest } from '../src/lift-job-types.js';

const CALLER_ROOT = 'urn:dmaast:tenant:tenant-a';
const CALLER_DEVICE = 'urn:dmaast:device:tenant-a:device-a';

const request: LiftRequest = {
  swmId: 'swm-main',
  shareOperationId: 'op-1122',
  roots: [CALLER_ROOT, CALLER_DEVICE],
  contextGraphId: 'dmaast',
  namespace: 'tenants',
  scope: 'devnet',
  transitionType: 'CREATE',
  authority: { type: 'owner', proofRef: 'devnet-proof' },
};

describe('GH #1122 — async lift preserves caller root IRIs (sync parity)', () => {
  it('canonicalRootIri is identity (no dkg:<cg>:… rewrite)', () => {
    expect(canonicalRootIri(request, CALLER_ROOT)).toBe(CALLER_ROOT);
    expect(canonicalRootIri(request, CALLER_DEVICE)).toBe(CALLER_DEVICE);
  });

  it('validated quads keep caller IRIs as subjects and IRI objects', () => {
    const out = validateLiftPublishPayload({
      request,
      resolved: {
        quads: [
          { subject: CALLER_ROOT, predicate: 'https://schema.org/name', object: '"Tenant A"', graph: 'g' },
          // device → tenant link by IRI (the exact shape #1122 says must stay connected)
          { subject: CALLER_DEVICE, predicate: 'https://schema.org/parentOrganization', object: CALLER_ROOT, graph: 'g' },
        ],
      },
    });
    const tenant = out.resolved.quads.find((q) => q.predicate === 'https://schema.org/name');
    const link = out.resolved.quads.find((q) => q.predicate === 'https://schema.org/parentOrganization');
    expect(tenant?.subject).toBe(CALLER_ROOT);
    expect(link?.subject).toBe(CALLER_DEVICE);
    // the IRI object (the cross-entity link) must also stay the caller IRI
    expect(link?.object).toBe(CALLER_ROOT);
    // validation metadata reports the caller roots, not generated dkg:… roots
    expect(out.validation.canonicalRoots).toContain(CALLER_ROOT);
    expect(out.validation.canonicalRoots.every((r) => !r.startsWith('dkg:'))).toBe(true);
  });
});
