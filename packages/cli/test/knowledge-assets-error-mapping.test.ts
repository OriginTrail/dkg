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
