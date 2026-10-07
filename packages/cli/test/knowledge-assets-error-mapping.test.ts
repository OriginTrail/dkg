import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPromoteRetryableFailure } from '@origintrail-official/dkg-publisher';
import { tagPromoteError } from '../../publisher/src/promote-step-tag.js';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { respondAssertionCodeError, respondAssertionError } from '../src/daemon/routes/knowledge-assets-error-mapping.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

function fakeResponse() {
  const record = { status: 0, body: '', ended: false, headers: {} as Record<string, string> };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      record.status = status;
      if (headers) Object.assign(record.headers, headers);
      return res;
    },
    end(body?: string) {
      if (typeof body === 'string') record.body = body;
      record.ended = true;
    },
  } as any;
  return { record, res };
}

/** The error a share raises when a prerequisite read is unavailable, as the engine builds it. */
function shareRecipientOutage(): { failure: any; cause: Error } {
  const cause = Object.assign(
    new Error('Context graph "cg" private authority changed while recipient keys were resolving'),
    {
      code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
      reason: 'chain-participant-authority-unavailable',
      detail: 'retry recipient resolution against the current private authority',
    },
  );
  const failure = tagPromoteError('encodeWorkspaceGossipPayload', createPromoteRetryableFailure(cause));
  return { failure, cause };
}

/** The daemon log lines one response wrote, parsed. */
function loggedEvents(stderr: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return stderr.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith('[DKG-Daemon] '))
    .map((line) => JSON.parse(line.slice('[DKG-Daemon] '.length)));
}

describe('knowledge-assets mutation error mapping', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['KA_ASSERTION_ALREADY_FINALIZED', 'ASSERTION_EMPTY', 'KA_SLOT_ALREADY_CLAIMED', 'KA_RESERVED_ID_MISMATCH'])('keeps the %s conflict mapping', (code) => {
    const { record, res } = fakeResponse();
    respondAssertionError(res, { code, message: 'caller precondition' });
    expect(record.status).toBe(409);
    expect(JSON.parse(record.body)).toEqual({ code, error: 'caller precondition' });
    const direct = fakeResponse();
    expect(respondAssertionCodeError(direct.res, { code, message: 'caller precondition' })).toBe(true);
    expect(direct.record.status).toBe(409);
    expect(JSON.parse(direct.record.body)).toEqual(JSON.parse(record.body));
  });

  it('leaves unknown codes to the route-specific fallback without writing a response', () => {
    const { record, res } = fakeResponse();
    expect(respondAssertionCodeError(res, { code: 'toString', message: 'unknown' })).toBe(false);
    expect(record).toMatchObject({ status: 0, body: '', ended: false });
  });

  it.each([
    ['CURATOR_REJECTED', 409, 'rejected'],
    ['CURATOR_UNCONFIRMED', 503, 'unconfirmed'],
  ])('keeps %s response details', (code, status, curatorDelivery) => {
    const { record, res } = fakeResponse();
    respondAssertionError(res, { code, message: 'curator outcome', contextGraphId: 'cg' });
    expect(record.status).toBe(status);
    expect(JSON.parse(record.body)).toEqual({ code, error: 'curator outcome', curatorDelivery, contextGraphId: 'cg' });
  });

  it('does not map inherited object-property names as error codes', () => {
    const { record, res } = fakeResponse();
    respondAssertionError(res, { code: 'toString', message: 'store damage' });
    expect(record.status).toBe(500);
  });

  it.each(['draft', 'InvalidAddresses', 'UnsafeImports'])('keeps damaged lifecycle records for %s as typed server failures', (name) => {
    const { record, res } = fakeResponse();
    const message = `Assertion "${name}" has a corrupt Working Memory lifecycle record`;
    respondAssertionError(res, { code: 'KA_WM_LIFECYCLE_CORRUPT', message });
    expect(record.status).toBe(500);
    expect(JSON.parse(record.body)).toEqual({ error: message, code: 'KA_WM_LIFECYCLE_CORRUPT' });
  });

  it.each(['KA_PROMOTE_RECOVERY_REQUIRED', 'PROMOTE_POST_COMMIT_FAILURE'])('keeps %s recovery coordinates consistent', (code) => {
    for (const context of [undefined, { contextGraphId: 'cg', name: 'same-asset', phase: 'share', subGraphName: 'sub' }]) {
      const { record, res } = fakeResponse();
      respondAssertionError(res, { code, message: 'recovery needed' }, context);
      const body = JSON.parse(record.body);
      expect(record.status).toBe(code === 'KA_PROMOTE_RECOVERY_REQUIRED' ? 409 : 503);
      expect(body).toMatchObject({ code, error: 'recovery needed', retryAction: 'resume_existing_knowledge_asset', retryPhase: 'swm-share' });
      if (context) expect(body).toMatchObject({ contextGraphId: 'cg', retryKnowledgeAssetName: 'same-asset', subGraphName: 'sub' });
      else expect(body).not.toHaveProperty('contextGraphId');
      if (code === 'PROMOTE_POST_COMMIT_FAILURE') expect(body.retryable).toBe(true);
      else expect(body).not.toHaveProperty('retryable');
    }
  });

  it('returns an actionable retry for a committed share whose pointer stamp failed', () => {
    const { record, res } = fakeResponse();
    respondAssertionError(res, {
      code: 'PROMOTE_POST_COMMIT_FAILURE',
      message: 'A promote post-commit step failed after Shared Memory was committed',
      cause: new Error('store connection reset'),
    }, { contextGraphId: 'cg', name: 'same-asset', phase: 'share' });
    expect(record.status).toBe(503);
    expect(JSON.parse(record.body)).toMatchObject({
      code: 'PROMOTE_POST_COMMIT_FAILURE', retryable: true,
      retryAction: 'resume_existing_knowledge_asset', retryPhase: 'swm-share',
      contextGraphId: 'cg', retryKnowledgeAssetName: 'same-asset',
    });

  });

  describe('a share whose prerequisite is temporarily unavailable', () => {
    it('answers a retryable 503 that names the asset to share again', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { failure } = shareRecipientOutage();
      const { record, res } = fakeResponse();

      respondAssertionError(res, failure, {
        contextGraphId: 'cg', name: 'same-asset', phase: 'swm-share', subGraphName: 'sub',
      });

      expect(record.status).toBe(503);
      expect(record.headers['Retry-After']).toBe('1');
      expect(JSON.parse(record.body)).toEqual({
        code: 'PROMOTE_RETRYABLE_FAILURE',
        error: '[promote:encodeWorkspaceGossipPayload] A promote prerequisite is temporarily unavailable',
        retryable: true,
        retryAction: 'resume_existing_knowledge_asset',
        retryPhase: 'swm-share',
        contextGraphId: 'cg',
        retryKnowledgeAssetName: 'same-asset',
        subGraphName: 'sub',
      });
      expect(stderr).toHaveBeenCalled();
    });

    it('does not report that nothing started, because the draft is already sealed', () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { record, res } = fakeResponse();

      respondAssertionError(res, shareRecipientOutage().failure, {
        contextGraphId: 'cg', name: 'same-asset', phase: 'swm-share',
      });

      const body = JSON.parse(record.body);
      expect(body).not.toHaveProperty('outcome');
      expect(body).not.toHaveProperty('subGraphName');
    });

    it('answers without coordinates when the route supplied none', () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { record, res } = fakeResponse();

      respondAssertionError(res, shareRecipientOutage().failure);

      expect(record.status).toBe(503);
      expect(record.headers['Retry-After']).toBe('1');
      const body = JSON.parse(record.body);
      expect(body).toMatchObject({
        code: 'PROMOTE_RETRYABLE_FAILURE', retryable: true,
        retryAction: 'resume_existing_knowledge_asset', retryPhase: 'swm-share',
      });
      expect(body).not.toHaveProperty('contextGraphId');
      expect(body).not.toHaveProperty('retryKnowledgeAssetName');
    });

    it('logs which prerequisite failed and keeps the cause text out of the log and the answer', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { failure, cause } = shareRecipientOutage();
      const { record, res } = fakeResponse();

      respondAssertionError(res, failure, { contextGraphId: 'cg', name: 'same-asset', phase: 'swm-share' });

      expect(loggedEvents(stderr)).toEqual([{
        event: 'knowledge_asset_share_prerequisite_unavailable',
        code: 'PROMOTE_RETRYABLE_FAILURE',
        step: 'encodeWorkspaceGossipPayload',
        causeCode: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
        causeReason: 'chain-participant-authority-unavailable',
        contextGraphId: 'cg',
        name: 'same-asset',
        phase: 'swm-share',
      }]);
      const written = stderr.mock.calls.map(([line]) => String(line)).join('');
      expect(written).not.toContain(cause.message);
      expect(written).not.toContain('retry recipient resolution');
      expect(record.body).not.toContain(cause.message);
      expect(record.body).not.toContain('chain-participant-authority-unavailable');
    });

    it.each([
      ['no cause', undefined],
      ['a cause that is not an object', 'store connection reset'],
      ['a cause whose identity is not a plain token', {
        code: 'https://rpc.example/v2/SECRETKEY', reason: 'timed out after 2500ms',
      }],
      ['a cause whose identity is not a string', { code: 503, reason: null }],
      ['a cause whose fields throw', new Proxy({}, { get() { throw new Error('hostile getter'); } })],
    ])('logs no cause identity for %s', (_label, cause) => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { record, res } = fakeResponse();

      respondAssertionError(res, {
        code: 'PROMOTE_RETRYABLE_FAILURE',
        message: 'A promote prerequisite is temporarily unavailable',
        cause,
      });

      expect(record.status).toBe(503);
      expect(loggedEvents(stderr)).toEqual([{
        event: 'knowledge_asset_share_prerequisite_unavailable',
        code: 'PROMOTE_RETRYABLE_FAILURE',
        step: 'unknown',
      }]);
    });

    it('reports an untagged or non-text message as an unknown step', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { record, res } = fakeResponse();

      respondAssertionError(res, { code: 'PROMOTE_RETRYABLE_FAILURE', message: undefined });

      expect(record.status).toBe(503);
      expect(JSON.parse(record.body)).toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE', retryable: true });
      expect(loggedEvents(stderr)).toEqual([{
        event: 'knowledge_asset_share_prerequisite_unavailable',
        code: 'PROMOTE_RETRYABLE_FAILURE',
        step: 'unknown',
      }]);
    });

    it('is the answer of POST /api/knowledge-assets/:name/swm/share', async () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const promote = vi.fn(async () => { throw shareRecipientOutage().failure; });
      const agent = {
        // A write preflight that accepts the graph, so the route reaches the share.
        probeContextGraphWritePreflight: async () => ({
          storeAvailable: true,
          exists: true,
          hasLocalContent: true,
          declarationFound: true,
          accessPolicy: 'public',
          callerAuthorized: true,
        }),
        assertion: { promote },
      };
      const { record, res } = fakeResponse();
      const rawPath = '/api/knowledge-assets/shared-right-after-registration/swm/share';
      const url = new URL(`http://127.0.0.1${rawPath}`);
      const req: any = {
        method: 'POST',
        url: rawPath,
        __dkgPrebufferedBody: Buffer.from(JSON.stringify({ contextGraphId: 'cg-1', subGraphName: 'documents' })),
      };

      await handleKnowledgeAssetsRoutes({
        req,
        res,
        agent,
        path: url.pathname,
        url,
        authentication: requestAuthentication({ kind: 'anonymous' }),
      } as unknown as RequestContext);

      expect(promote).toHaveBeenCalledTimes(1);
      expect(record.status).toBe(503);
      expect(record.headers['Retry-After']).toBe('1');
      expect(JSON.parse(record.body)).toEqual({
        code: 'PROMOTE_RETRYABLE_FAILURE',
        error: '[promote:encodeWorkspaceGossipPayload] A promote prerequisite is temporarily unavailable',
        retryable: true,
        retryAction: 'resume_existing_knowledge_asset',
        retryPhase: 'swm-share',
        contextGraphId: 'cg-1',
        retryKnowledgeAssetName: 'shared-right-after-registration',
        subGraphName: 'documents',
      });
    });
  });

  it('maps an inactive WM discard precondition to a typed conflict', () => {
    const { record, res } = fakeResponse();
    // The message the engine throws (assertWorkingMemoryLifecycleMutable).
    const message = 'Assertion "shared-ka" is not an active Working Memory draft; reopen it before mutating it';
    respondAssertionError(res, { code: 'KA_WM_LIFECYCLE_REQUIRED', message });

    expect(record.status).toBe(409);
    expect(record.ended).toBe(true);
    expect(JSON.parse(record.body)).toEqual({
      error: message,
      code: 'KA_WM_LIFECYCLE_REQUIRED',
    });
  });
});
