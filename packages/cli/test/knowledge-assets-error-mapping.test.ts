import { describe, expect, it } from 'vitest';
import { respondAssertionError } from '../src/daemon/routes/knowledge-assets-error-mapping.js';

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
  it.each(['KA_ASSERTION_ALREADY_FINALIZED', 'ASSERTION_EMPTY'])('keeps the %s conflict mapping', (code) => {
    const { record, res } = fakeResponse();
    respondAssertionError(res, { code, message: 'caller precondition' });
    expect(record.status).toBe(409);
    expect(JSON.parse(record.body)).toEqual({ code, error: 'caller precondition' });
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

  it('keeps damaged lifecycle records as server failures', () => {
    const { record, res } = fakeResponse();
    const message = 'Assertion "draft" has a corrupt Working Memory lifecycle record';
    respondAssertionError(res, { code: 'KA_WM_LIFECYCLE_CORRUPT', message });
    expect(record.status).toBe(500);
    expect(JSON.parse(record.body)).toEqual({ error: message });
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
