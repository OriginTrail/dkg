import { describe, it, expect } from 'vitest';
import { buildSyncRequestEnvelope, type SyncRequestEnvelope } from '../src/sync/auth/request-build.js';

/**
 * Phase C — `sinceBatchId` rides the sync request envelope UNSIGNED.
 *
 * The whole backward-compatibility argument rests on `sinceBatchId` being
 * outside the signed digest (exactly like `phase` / `snapshotRef`): a narrowing
 * hint can never grant unauthorized access, so it needs no digest version bump
 * or negotiation. These tests pin that invariant.
 */

const baseParams = (sinceBatchId?: string, syncSessionId?: string) => {
  const digestCalls: unknown[][] = [];
  return {
    digestCalls,
    params: {
      contextGraphId: 'mfacts',
      offset: 0,
      limit: 100,
      includeSharedMemory: false,
      targetPeerId: 'peer-responder',
      requesterPeerId: 'peer-requester',
      phase: 'data' as const,
      sinceBatchId,
      syncSessionId,
      needsAuth: true,
      computeSyncDigest: (...args: unknown[]) => {
        digestCalls.push(args);
        // Deterministic 32-byte digest independent of any post-digest field.
        return new Uint8Array(32).fill(7);
      },
      getIdentityId: async () => 1n,
      signMessage: async () => ({ r: new Uint8Array(32).fill(1), vs: new Uint8Array(32).fill(2) }),
    },
  };
};

const EXACT_UAL = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7';

describe('Phase C sync envelope — sinceBatchId is unsigned', () => {
  it('does not feed sinceBatchId or syncSessionId into the signed digest', async () => {
    const without = baseParams(undefined);
    const withHint = baseParams('42', 'session-1');

    await buildSyncRequestEnvelope(without.params);
    await buildSyncRequestEnvelope(withHint.params);

    expect(without.digestCalls).toHaveLength(1);
    expect(withHint.digestCalls).toHaveLength(1);

    // The digest signature is (cg, offset, limit, includeSWM, target, requester,
    // requestId, issuedAtMs, agentAddress, authPurpose, authSelector). The last
    // two slots are always forwarded and remain undefined for legacy requests.
    // requestId (idx 6) and issuedAtMs (idx 7) are random/time-based per build,
    // so compare only the stable, semantically-meaningful positions.
    const a = without.digestCalls[0];
    const b = withHint.digestCalls[0];
    expect(a).toHaveLength(11);
    expect(b).toHaveLength(11);
    for (const idx of [0, 1, 2, 3, 4, 5, 8, 9, 10]) expect(b[idx]).toEqual(a[idx]);
    expect(a[9]).toBeUndefined();
    expect(a[10]).toBeUndefined();
    // The additive hint values never appear anywhere in the digest inputs.
    expect(b.some((arg) => String(arg) === '42')).toBe(false);
    expect(b.some((arg) => String(arg) === 'session-1')).toBe(false);
  });

  it('carries sinceBatchId in the authenticated JSON envelope when set', async () => {
    const { params } = baseParams('42');
    const bytes = await buildSyncRequestEnvelope(params);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as SyncRequestEnvelope;
    expect(parsed.sinceBatchId).toBe('42');
    // Sanity: it's still a signed envelope.
    expect(parsed.requesterSignatureR).toBeTruthy();
  });

  it('carries syncSessionId in the authenticated JSON envelope when set', async () => {
    const { params } = baseParams(undefined, 'session-1');
    const bytes = await buildSyncRequestEnvelope(params);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as SyncRequestEnvelope;
    expect(parsed.syncSessionId).toBe('session-1');
    expect(parsed.requesterSignatureR).toBeTruthy();
  });

  it('carries an exact-KA filter outside the authenticated digest', async () => {
    const { params, digestCalls } = baseParams(undefined);
    const bytes = await buildSyncRequestEnvelope({ ...params, assetUals: [EXACT_UAL] });
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as SyncRequestEnvelope;

    expect(parsed.assetUals).toEqual([EXACT_UAL]);
    expect(digestCalls).toHaveLength(1);
    expect(digestCalls[0]).not.toContain(EXACT_UAL);
  });

  it('omits sinceBatchId from the envelope when unset (no key leakage)', async () => {
    const { params } = baseParams(undefined);
    const bytes = await buildSyncRequestEnvelope(params);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as SyncRequestEnvelope;
    expect(parsed.sinceBatchId).toBeUndefined();
  });

  it('feeds generic authPurpose/authSelector into the signed digest when set', async () => {
    const { params, digestCalls } = baseParams(undefined);
    const bytes = await buildSyncRequestEnvelope({
      ...params,
      authPurpose: 'imported-artifact:v1',
      authSelector: 'imported-artifact:v1:0xabc',
    });
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as SyncRequestEnvelope;

    expect(parsed.authPurpose).toBe('imported-artifact:v1');
    expect(parsed.authSelector).toBe('imported-artifact:v1:0xabc');
    expect(digestCalls).toHaveLength(1);
    expect(digestCalls[0]).toHaveLength(11);
    expect(digestCalls[0][9]).toBe('imported-artifact:v1');
    expect(digestCalls[0][10]).toBe('imported-artifact:v1:0xabc');
  });

  it('appends an unauthenticated |since|<n> token for the pipe encoding', async () => {
    const { params } = baseParams('42');
    const bytes = await buildSyncRequestEnvelope({ ...params, needsAuth: false });
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe('mfacts|0|100|since|42');
  });

  it('appends unauthenticated session and since tokens for the pipe encoding', async () => {
    const { params } = baseParams('42', 'session-1');
    const bytes = await buildSyncRequestEnvelope({ ...params, needsAuth: false });
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe('mfacts|0|100|session|session-1|since|42');
  });

  it('appends the exact-KA token after legacy session/delta tokens', async () => {
    const { params } = baseParams('42', 'session-1');
    const bytes = await buildSyncRequestEnvelope({
      ...params,
      needsAuth: false,
      assetUals: [EXACT_UAL],
    });
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('mfacts|0|100|session|session-1|since|42|assets|');
    expect(decodeURIComponent(text.split('|assets|')[1]!)).toBe(JSON.stringify([EXACT_UAL]));
  });

  it('omits the pipe |since| token when the hint is unset', async () => {
    const { params } = baseParams(undefined);
    const bytes = await buildSyncRequestEnvelope({ ...params, needsAuth: false });
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe('mfacts|0|100');
  });
});
