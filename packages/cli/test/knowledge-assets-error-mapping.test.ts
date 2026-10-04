import { describe, expect, it } from 'vitest';
import { respondAssertionError } from '../src/daemon/routes/knowledge-assets.js';

function fakeResponse() {
  const record = { status: 0, body: '', ended: false };
  const res = {
    writeHead(status: number) {
      record.status = status;
      return res;
    },
    end(body?: string) {
      if (typeof body === 'string') record.body = body;
      record.ended = true;
    },
  } as any;
  return { record, res };
}

describe('knowledge-assets mutation error mapping', () => {
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
