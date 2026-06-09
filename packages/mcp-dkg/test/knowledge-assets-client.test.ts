import { describe, it, expect } from 'vitest';
import { DkgClient } from '../src/client.js';
import { makeConfig } from './harness.js';

// ── OT-RFC-43 §10.5 — knowledge-assets client precondition guards ───────────
//
// NO MOCKS. This file used to drive a fake `fetcher` that returned
// `{ ok: true }` for ANY request and inspected the captured body to pin the
// happy-path serialization (e.g. "`clearAfter` nests under `options`"). That
// fake-daemon pattern is exactly the false-confidence we are removing: it
// pinned the OUTGOING shape but could never notice the daemon renaming a
// field or rejecting the body. The happy-path body serialization is now
// validated end-to-end against a REAL daemon in
// `mcp-tool-surface.integration.test.ts` (the "finalized-publish option
// plumbing survives a real round-trip" case) and
// `mcp-daemon-contract.integration.test.ts`.
//
// What remains here is the CLIENT-SIDE precondition contract: the client
// REJECTS a malformed call before any network I/O. We assert that against a
// REAL `DkgClient` (no fetcher override). The validation throws
// synchronously before `fetch` is reached, so no daemon is needed — and if a
// guard regressed, the call would fall through to a real fetch against the
// (unconfigured, nothing-listening) default API and throw a CONNECTION error
// instead of the documented validation message, failing the matcher. That
// "fall-through → connection error, not the validation message" is the
// mock-free tripwire that proves the guard still short-circuits.
//
// Regression for the review on PR #978: these options were dropped, so
// external-signer / publish-control flows were unreachable through the MCP
// KA surface.
describe('DkgClient knowledge-assets — client-side precondition guards (no mocks)', () => {
  const client = () => new DkgClient({ config: makeConfig() });

  it('knowledgeAssetPublish rejects numeric publisher identity overrides before HTTP', async () => {
    await expect(
      client().knowledgeAssetPublish({
        contextGraphId: 'cg-1',
        name: 'f',
        publisherNodeIdentityIdOverride: Number.MAX_SAFE_INTEGER + 1,
      } as never),
    ).rejects.toThrow(/decimal string/);
  });

  it('knowledgeAssetPublish rejects malformed decimal-string publisher identity overrides', async () => {
    await expect(
      client().knowledgeAssetPublish({
        contextGraphId: 'cg-1',
        name: 'f',
        publisherNodeIdentityIdOverride: 'abc',
      }),
    ).rejects.toThrow(/decimal string/);
    await expect(
      client().knowledgeAssetPublish({
        contextGraphId: 'cg-1',
        name: 'f',
        publisherNodeIdentityIdOverride: '-1',
      }),
    ).rejects.toThrow(/decimal string/);
  });

  it('knowledgeAssetPublish rejects unknown finalized-publish option keys', async () => {
    await expect(
      client().knowledgeAssetPublish({
        contextGraphId: 'cg-1',
        name: 'f',
        publishEpoch: 3,
      } as never),
    ).rejects.toThrow(/Unsupported finalized publish option\(s\): publishEpoch/);
  });

  it('knowledgeAssetFinalize rejects mutually exclusive authorship fields before HTTP', async () => {
    await expect(
      client().knowledgeAssetFinalize({
        contextGraphId: 'cg-1',
        name: 'f',
        authorAgentAddress: '0xauthor',
        preSignedAuthorAttestation: { address: '0xauthor', reservedKaId: '1', signature: { r: '0xr', vs: '0xvs' } },
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('createKnowledgeAsset rejects null alsoPublishVm before HTTP', async () => {
    await expect(
      client().createKnowledgeAsset({
        contextGraphId: 'cg-1',
        name: 'f',
        alsoPublishVm: null,
      } as never),
    ).rejects.toThrow(/alsoPublishVm must be a boolean or publish-options object/);
  });

  it('createKnowledgeAsset rejects unknown alsoPublishVm option objects', async () => {
    await expect(
      client().createKnowledgeAsset({
        contextGraphId: 'cg-1',
        name: 'f',
        alsoPublishVm: { unknown: true },
      } as never),
    ).rejects.toThrow(/Unsupported finalized publish option\(s\): unknown/);
    await expect(
      client().createKnowledgeAsset({
        contextGraphId: 'cg-1',
        name: 'f',
        alsoPublishVm: { publishEpoch: 3 },
      } as never),
    ).rejects.toThrow(/Unsupported finalized publish option\(s\): publishEpoch/);
  });

  it('createKnowledgeAsset rejects finalize-only fields without quads before HTTP', async () => {
    await expect(
      client().createKnowledgeAsset({
        contextGraphId: 'cg-1',
        name: 'f',
        authorAgentAddress: '0xauthor',
      }),
    ).rejects.toThrow(/require non-empty quads/);
  });
});
