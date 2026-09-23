// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { ChainRpcTransportError } from '../src/chain-rpc-transport-error.js';
import {
  classifyContextGraphRegistrationFailure,
  markContextGraphRegistrationNotSubmitted,
} from '../src/context-graph-registration-error.js';

describe('Context Graph registration failure classification', () => {
  it.each([
    Object.assign(new Error('reverted'), { code: 'CALL_EXCEPTION' }),
    Object.assign(new Error('mined revert'), { receipt: { status: 0 } }),
    new ChainRpcTransportError('RPC_TIMEOUT', 'pre-submission timeout'),
    markContextGraphRegistrationNotSubmitted(
      new ChainRpcTransportError('RPC_RECEIPT_LOOKUP_FAILED', 'approval receipt unavailable', {
        txHash: `0x${'ab'.repeat(32)}`,
      }),
    ),
  ])('classifies a proven non-registration outcome as definitive', (error) => {
    expect(classifyContextGraphRegistrationFailure(error)).toBe('definitive-failure');
  });

  it.each([
    new Error('unknown submission outcome'),
    new ChainRpcTransportError('RPC_RECEIPT_LOOKUP_FAILED', 'receipt unavailable', {
      txHash: `0x${'cd'.repeat(32)}`,
    }),
    new ChainRpcTransportError('RPC_TIMEOUT', 'broadcast timeout', {
      txHash: `0x${'ef'.repeat(32)}`,
    }),
  ])('retains pending when registration may have been submitted', (error) => {
    expect(classifyContextGraphRegistrationFailure(error)).toBe('outcome-ambiguous');
  });

  it('wraps a sealed preparatory failure in a typed pre-submission verdict', () => {
    const sealed = Object.preventExtensions(new Error('sealed approval failure'));
    const marked = markContextGraphRegistrationNotSubmitted(sealed);

    expect(marked).not.toBe(sealed);
    expect(marked).toMatchObject({
      message: sealed.message,
      cause: sealed,
      contextGraphRegistrationSubmitted: false,
    });
    expect(classifyContextGraphRegistrationFailure(marked)).toBe('definitive-failure');
  });
});
