import { describe, expect, it, vi } from 'vitest';
import {
  PRIVATE_SHARE_AUTHORITY_RETRY_ERROR,
  retryPrivateShareAuthority,
} from './helpers/private-share-authority-retry.js';

describe('private share fixture authority retry boundary', () => {
  it('caps a permanently unavailable authority at four submissions', async () => {
    const failure = { status: 500, body: { error: PRIVATE_SHARE_AUTHORITY_RETRY_ERROR } };
    const submit = vi.fn(async () => failure);
    const wait = vi.fn(async () => {});
    expect(await retryPrivateShareAuthority(submit, wait)).toBe(failure);
    expect(submit).toHaveBeenCalledTimes(4);
    expect(wait.mock.calls).toEqual([[250], [500], [1_000]]);
  });

  it.each([
    { status: 500, body: { error: 'an unrelated internal error' } },
    { status: 500, body: { error: '[promote:insertSwm] A promote prerequisite is temporarily unavailable' } },
    { status: 503, body: { error: PRIVATE_SHARE_AUTHORITY_RETRY_ERROR } },
    { status: 409, body: { error: PRIVATE_SHARE_AUTHORITY_RETRY_ERROR } },
  ])('propagates a non-precommit response without retry: $status $body.error', async failure => {
    const submit = vi.fn(async () => failure);
    const wait = vi.fn(async () => {});
    expect(await retryPrivateShareAuthority(submit, wait)).toBe(failure);
    expect(submit).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it('propagates an exception instead of interpreting it as authority churn', async () => {
    const error = new Error('transport failed');
    const submit = vi.fn(async () => { throw error; });
    await expect(retryPrivateShareAuthority(submit)).rejects.toBe(error);
    expect(submit).toHaveBeenCalledOnce();
  });
});
