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
  it('maps an inactive WM discard precondition to a typed conflict', () => {
    const { record, res } = fakeResponse();
    respondAssertionError(res, {
      code: 'KA_WM_LIFECYCLE_REQUIRED',
      message: 'Knowledge Asset has no active Working Memory draft',
    });

    expect(record.status).toBe(409);
    expect(record.ended).toBe(true);
    expect(JSON.parse(record.body)).toEqual({
      error: 'Knowledge Asset has no active Working Memory draft',
      code: 'KA_WM_LIFECYCLE_REQUIRED',
    });
  });
});
