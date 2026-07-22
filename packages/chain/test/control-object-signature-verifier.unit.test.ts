import {
  computeControlObjectDigestHex,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1,
  CONTROL_EIP1271_CALL_FROM_V1,
  CONTROL_EIP1271_ENDPOINT_ATTEMPT_POLICY_V1,
  CONTROL_EIP1271_GAS_LIMIT_V1,
  CONTROL_EIP1271_MAX_ATTEMPTS_V1,
  CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1,
  CONTROL_EIP1271_MAX_RPC_RESPONSE_BYTES_V1,
  CONTROL_EIP1271_MAX_RETURN_BYTES_V1,
  CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1,
  EIP1271_CANONICAL_ABI_RETURN_V1,
  ControlSignatureVerificationErrorV1,
  CurrentFinalizedEvmCallErrorV1,
  assertVerifiedControlEnvelopeIssuerSignatureV1,
  readVerifiedControlEnvelopeIssuerSignatureV1,
  verifyControlEnvelopeIssuerSignatureV1,
  type CurrentFinalizedEvmCallResultV1,
  type CurrentFinalizedEvmCallV1,
} from '../src/control-object-signature-verifier.js';

const PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const OTHER_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const SAFE = '0x3333333333333333333333333333333333333333';
const BLOCK_HASH = `0x${'44'.repeat(32)}`;
const SECP256K1_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);
const SECP256K1_HALF_N = BigInt(
  '0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0',
);
const EIP1271_INTERFACE = new ethers.Interface([
  'function isValidSignature(bytes32,bytes) view returns (bytes4)',
]);
const EIP191_VECTOR_DIGEST =
  '0x2e5b81a340e15ae386e3319a642fe2bc431dff13b568ec3c887fbaebdc151b73';
const EIP191_VECTOR_SIGNATURE =
  '0xc528dd3ae35507cee21806cd55eb02e2398fd9c70c662888d59c02a725ebe9c244442765007b40bc331a093139c4713396a6b9c688836f1064d03ad6eb75a49d1c';
const EIP191_VECTOR_VARIANT_DIGEST =
  '0xdef8e7105256a04293e404d7001db9816aa786ffceb390872135ac6a9dbf4908';

const FINALIZED_OK = Object.freeze({
  chainId: '20430',
  blockNumber: '123',
  blockHash: BLOCK_HASH,
  returnData: EIP1271_CANONICAL_ABI_RETURN_V1,
} satisfies CurrentFinalizedEvmCallResultV1);

afterEach(() => {
  vi.useRealTimers();
});

describe('RFC-64 control-object issuer signature verifier', () => {
  it('verifies EIP-191 over raw digest bytes and returns immutable variant identity', async () => {
    const wallet = new ethers.Wallet(PRIVATE_KEY);
    const envelope = await eoaEnvelope(wallet);
    const capability = await verifyControlEnvelopeIssuerSignatureV1(envelope);
    const verified = readVerifiedControlEnvelopeIssuerSignatureV1(capability);

    expect(envelope.objectDigest).toBe(EIP191_VECTOR_DIGEST);
    expect(envelope.signature).toBe(EIP191_VECTOR_SIGNATURE);
    expect(verified).toMatchObject({
      objectDigest: envelope.objectDigest,
      signatureVariantDigest: EIP191_VECTOR_VARIANT_DIGEST,
      issuer: wallet.address.toLowerCase(),
      signatureSuite: 'eip191-personal-sign-digest-v1',
      verificationEvidence: { kind: 'eip191' },
    });
    expect(verified.signatureVariantDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.getPrototypeOf(capability)).toBeNull();
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.verificationEvidence)).toBe(true);
  });

  it('rejects forged, cloned, and serialized verification-token lookalikes', async () => {
    const capability = await verifyControlEnvelopeIssuerSignatureV1(
      await eoaEnvelope(new ethers.Wallet(PRIVATE_KEY)),
    );
    expect(() => assertVerifiedControlEnvelopeIssuerSignatureV1(capability)).not.toThrow();
    for (const lookalike of [
      {},
      { ...capability },
      Object.create(null),
      JSON.parse(JSON.stringify(capability)) as unknown,
    ]) {
      expect(() => assertVerifiedControlEnvelopeIssuerSignatureV1(lookalike)).toThrow(
        /was not minted by this verifier/,
      );
      expect(() => readVerifiedControlEnvelopeIssuerSignatureV1(lookalike)).toThrow(
        /was not minted by this verifier/,
      );
    }
  });

  it('rejects signing UTF-8 hex text and a signature from another issuer', async () => {
    const wallet = new ethers.Wallet(PRIVATE_KEY);
    const other = new ethers.Wallet(OTHER_PRIVATE_KEY);
    const envelope = await eoaEnvelope(wallet);

    await expect(verifyControlEnvelopeIssuerSignatureV1({
      ...envelope,
      signature: (await wallet.signMessage(envelope.objectDigest)).toLowerCase(),
    })).rejects.toMatchObject({ code: 'CONTROL_SIGNATURE_ISSUER_MISMATCH' });
    await expect(verifyControlEnvelopeIssuerSignatureV1({
      ...envelope,
      signature: (await other.signMessage(ethers.getBytes(envelope.objectDigest))).toLowerCase(),
    })).rejects.toMatchObject({ code: 'CONTROL_SIGNATURE_ISSUER_MISMATCH' });
  });

  it.each(['00', '01', '23', '25'])('rejects non-canonical wire v=0x%s', async (v) => {
    const envelope = await eoaEnvelope(new ethers.Wallet(PRIVATE_KEY));
    await expect(verifyControlEnvelopeIssuerSignatureV1({
      ...envelope,
      signature: `${envelope.signature.slice(0, -2)}${v}`,
    })).rejects.toMatchObject({ code: 'CONTROL_SIGNATURE_EIP191_NON_CANONICAL' });
  });

  it.each([
    ['r=0', 0n, 1n],
    ['r=n', SECP256K1_N, 1n],
    ['s=0', 1n, 0n],
    ['s=halfN+1', 1n, SECP256K1_HALF_N + 1n],
  ])('rejects non-canonical %s before recovery', async (_label, r, s) => {
    const envelope = await eoaEnvelope(new ethers.Wallet(PRIVATE_KEY));
    await expect(verifyControlEnvelopeIssuerSignatureV1({
      ...envelope,
      signature: serializedSignature(r, s, '1b'),
    })).rejects.toMatchObject({ code: 'CONTROL_SIGNATURE_EIP191_NON_CANONICAL' });
  });

  it('admits the inclusive halfN boundary to recovery rather than canonicality rejection', async () => {
    const envelope = await eoaEnvelope(new ethers.Wallet(PRIVATE_KEY));
    let caught: unknown;
    try {
      await verifyControlEnvelopeIssuerSignatureV1({
        ...envelope,
        signature: serializedSignature(1n, SECP256K1_HALF_N, '1b'),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toMatchObject({ code: 'CONTROL_SIGNATURE_EIP191_NON_CANONICAL' });
  });

  it('rejects envelope digest corruption before invoking the finalized gateway', async () => {
    const call = vi.fn(async () => FINALIZED_OK);
    await expect(verifyControlEnvelopeIssuerSignatureV1({
      ...safeEnvelope(),
      objectDigest: `0x${'00'.repeat(32)}`,
    }, { callEvmAtCurrentFinalized: call }))
      .rejects.toMatchObject({ code: 'CONTROL_SIGNATURE_ENVELOPE_INVALID' });
    expect(call).not.toHaveBeenCalled();
  });

  it('rejects EIP-1271 evidence for a contract other than the issuer before RPC', async () => {
    const call = vi.fn(async () => FINALIZED_OK);
    const base = safeEnvelope();
    const unsigned: UnsignedControlEnvelopeV1 = {
      objectType: base.objectType,
      payload: base.payload,
      signatureSuite: 'eip1271-current-finalized-v1',
      issuer: base.issuer,
      signatureEvidence: {
        kind: 'eip1271-current-finalized',
        chainId: '20430',
        contractAddress: '0x5555555555555555555555555555555555555555',
      },
    };
    await expect(verifyControlEnvelopeIssuerSignatureV1({
      ...unsigned,
      objectDigest: base.objectDigest,
      signature: base.signature,
    }, { callEvmAtCurrentFinalized: call }))
      .rejects.toMatchObject({
        code: 'CONTROL_SIGNATURE_ENVELOPE_INVALID',
        disposition: 'invalid',
      });
    expect(call).not.toHaveBeenCalled();
  });

  it('issues one exact bounded raw EIP-1271 call at current-finalized state', async () => {
    const call = vi.fn(async () => FINALIZED_OK);
    const envelope = safeEnvelope();
    const capability = await verifyControlEnvelopeIssuerSignatureV1(envelope, {
      callEvmAtCurrentFinalized: call,
    });
    const verified = readVerifiedControlEnvelopeIssuerSignatureV1(capability);

    expect(call).toHaveBeenCalledTimes(1);
    const request = call.mock.calls[0]![0];
    expect(request).toEqual({
      chainId: '20430',
      to: SAFE,
      from: CONTROL_EIP1271_CALL_FROM_V1,
      data: EIP1271_INTERFACE.encodeFunctionData('isValidSignature', [
        envelope.objectDigest,
        envelope.signature,
      ]).toLowerCase(),
      gasLimit: CONTROL_EIP1271_GAS_LIMIT_V1,
      maxReturnBytes: CONTROL_EIP1271_MAX_RETURN_BYTES_V1,
      maxRpcResponseBytes: CONTROL_EIP1271_MAX_RPC_RESPONSE_BYTES_V1,
      attemptTimeoutMs: CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1,
      maxAttempts: CONTROL_EIP1271_MAX_ATTEMPTS_V1,
      endpointAttemptPolicy: CONTROL_EIP1271_ENDPOINT_ATTEMPT_POLICY_V1,
      maxConcurrentCallsPerChain: CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1,
      totalDeadlineMs: CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1,
      ccipReadEnabled: false,
      signal: expect.any(AbortSignal),
    });
    const decoded = EIP1271_INTERFACE.decodeFunctionData('isValidSignature', request.data);
    expect(decoded[0]).toBe(envelope.objectDigest);
    expect(decoded[1]).toBe(envelope.signature);
    expect(verified.verificationEvidence).toEqual({
      kind: 'eip1271-current-finalized',
      chainId: '20430',
      contractAddress: SAFE,
      blockNumber: '123',
      blockHash: BLOCK_HASH,
    });
  });

  it.each([
    ['empty', '0x', 'malformed-return'],
    ['bare bytes4', '0x1626ba7e', 'malformed-return'],
    ['oversized', `0x1626ba7e${'00'.repeat(29)}`, 'malformed-return'],
    ['nonzero padding', `0x1626ba7e01${'00'.repeat(27)}`, 'wrong-magic'],
    ['wrong magic', `0xffffffff${'00'.repeat(28)}`, 'wrong-magic'],
  ])('rejects %s EIP-1271 return data', async (_label, returnData, reason) => {
    await expect(verifyControlEnvelopeIssuerSignatureV1(safeEnvelope(), {
      callEvmAtCurrentFinalized: callReturning({ ...FINALIZED_OK, returnData }),
    })).rejects.toMatchObject({
      code: 'CONTROL_SIGNATURE_EIP1271_INVALID',
      disposition: 'invalid',
      reason,
    });
  });

  it('keeps local chain mismatch and malformed gateway anchors retryable', async () => {
    await expect(verifyControlEnvelopeIssuerSignatureV1(safeEnvelope(), {
      callEvmAtCurrentFinalized: callReturning({ ...FINALIZED_OK, chainId: '1' }),
    })).rejects.toMatchObject({
      code: 'CONTROL_SIGNATURE_CHAIN_MISMATCH',
      disposition: 'retryable-unavailable',
    });

    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error('hostile ownKeys');
      },
    }) as CurrentFinalizedEvmCallResultV1;
    await expect(verifyControlEnvelopeIssuerSignatureV1(safeEnvelope(), {
      callEvmAtCurrentFinalized: callReturning(hostile),
    })).rejects.toMatchObject({
      code: 'CONTROL_SIGNATURE_RPC_UNAVAILABLE',
      disposition: 'retryable-unavailable',
    });

    const injected = new ControlSignatureVerificationErrorV1(
      'CONTROL_SIGNATURE_ABORTED',
      'cancelled',
      'gateway-result trap tried to impersonate caller cancellation',
    );
    const hostileVerifierError = new Proxy({}, {
      ownKeys() {
        throw injected;
      },
    }) as CurrentFinalizedEvmCallResultV1;
    await expect(verifyControlEnvelopeIssuerSignatureV1(safeEnvelope(), {
      callEvmAtCurrentFinalized: callReturning(hostileVerifierError),
    })).rejects.toMatchObject({
      code: 'CONTROL_SIGNATURE_RPC_UNAVAILABLE',
      disposition: 'retryable-unavailable',
    });
  });

  it('snapshots a stateful finalized result once and never re-reads the hostile object', async () => {
    let blockNumberReads = 0;
    const stateful = new Proxy({ ...FINALIZED_OK }, {
      get(target, property, receiver) {
        if (property === 'blockNumber') {
          blockNumberReads += 1;
          return blockNumberReads === 1 ? '123' : 'NOT-U64';
        }
        return Reflect.get(target, property, receiver);
      },
    }) as CurrentFinalizedEvmCallResultV1;
    const capability = await verifyControlEnvelopeIssuerSignatureV1(safeEnvelope(), {
      callEvmAtCurrentFinalized: callReturning(stateful),
    });
    const verified = readVerifiedControlEnvelopeIssuerSignatureV1(capability);
    expect(verified.verificationEvidence).toMatchObject({ blockNumber: '123' });
    expect(blockNumberReads).toBe(1);
  });

  it('closes and freezes the gateway error vocabulary, with forged codes retryable', async () => {
    const typed = new CurrentFinalizedEvmCallErrorV1('rpc-unavailable', 'offline');
    expect(Object.isFrozen(typed)).toBe(true);
    expect(() => new CurrentFinalizedEvmCallErrorV1(
      'evil' as never,
      'evil',
    )).toThrow(/Unsupported current-finalized EVM call error code/);

    const forged = Object.create(CurrentFinalizedEvmCallErrorV1.prototype) as {
      code: string;
      message: string;
    };
    forged.code = 'evil';
    forged.message = 'forged gateway failure';
    await expect(verifyControlEnvelopeIssuerSignatureV1(safeEnvelope(), {
      callEvmAtCurrentFinalized: vi.fn(async () => {
        throw forged;
      }),
    })).rejects.toMatchObject({
      code: 'CONTROL_SIGNATURE_RPC_UNAVAILABLE',
      disposition: 'retryable-unavailable',
    });
  });

  it('does not let an injected gateway impersonate a verifier-owned invalid result', async () => {
    const injected = new ControlSignatureVerificationErrorV1(
      'CONTROL_SIGNATURE_EIP1271_INVALID',
      'invalid',
      'gateway-forged cryptographic failure',
      { reason: 'wrong-magic' },
    );
    await expect(verifyControlEnvelopeIssuerSignatureV1(safeEnvelope(), {
      callEvmAtCurrentFinalized: vi.fn(async () => {
        throw injected;
      }),
    })).rejects.toMatchObject({
      code: 'CONTROL_SIGNATURE_RPC_UNAVAILABLE',
      disposition: 'retryable-unavailable',
    });

    const trapError = new ControlSignatureVerificationErrorV1(
      'CONTROL_SIGNATURE_ABORTED',
      'cancelled',
      'gateway rejection trap tried to impersonate caller cancellation',
    );
    const hostileRejection = new Proxy({}, {
      getPrototypeOf() {
        throw trapError;
      },
    });
    await expect(verifyControlEnvelopeIssuerSignatureV1(safeEnvelope(), {
      callEvmAtCurrentFinalized: vi.fn(async () => {
        throw hostileRejection;
      }),
    })).rejects.toMatchObject({
      code: 'CONTROL_SIGNATURE_RPC_UNAVAILABLE',
      disposition: 'retryable-unavailable',
    });
  });

  it.each([
    ['unsupported-chain', 'CONTROL_SIGNATURE_CHAIN_UNSUPPORTED', 'unsupported', undefined],
    ['chain-mismatch', 'CONTROL_SIGNATURE_CHAIN_MISMATCH', 'retryable-unavailable', undefined],
    ['finalized-state-unavailable', 'CONTROL_SIGNATURE_FINALIZED_STATE_UNAVAILABLE', 'retryable-unavailable', undefined],
    ['rpc-unavailable', 'CONTROL_SIGNATURE_RPC_UNAVAILABLE', 'retryable-unavailable', undefined],
    ['rpc-timeout', 'CONTROL_SIGNATURE_RPC_TIMEOUT', 'retryable-unavailable', undefined],
    ['concurrency-saturated', 'CONTROL_SIGNATURE_CONCURRENCY_SATURATED', 'retryable-unavailable', undefined],
    ['resource-limit', 'CONTROL_SIGNATURE_EIP1271_RESOURCE_LIMIT', 'unsupported', undefined],
    ['revert', 'CONTROL_SIGNATURE_EIP1271_INVALID', 'invalid', 'revert'],
    ['no-code', 'CONTROL_SIGNATURE_EIP1271_INVALID', 'invalid', 'no-code'],
    ['malformed-return', 'CONTROL_SIGNATURE_EIP1271_INVALID', 'invalid', 'malformed-return'],
  ] as const)('maps gateway %s without conflating validity and availability', async (
    gatewayCode,
    code,
    disposition,
    reason,
  ) => {
    const call = vi.fn(async () => {
      throw new CurrentFinalizedEvmCallErrorV1(gatewayCode, gatewayCode);
    });
    await expect(verifyControlEnvelopeIssuerSignatureV1(safeEnvelope(), {
      callEvmAtCurrentFinalized: call,
    })).rejects.toMatchObject({ code, disposition, ...(reason ? { reason } : {}) });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('treats a missing gateway as unsupported rather than signature-invalid', async () => {
    await expect(verifyControlEnvelopeIssuerSignatureV1(safeEnvelope()))
      .rejects.toMatchObject({
        code: 'CONTROL_SIGNATURE_CHAIN_UNSUPPORTED',
        disposition: 'unsupported',
      });
  });

  it('enforces the total deadline even if a gateway ignores abort', async () => {
    vi.useFakeTimers();
    const call: CurrentFinalizedEvmCallV1 = vi.fn(async () => new Promise(() => undefined));
    const verification = verifyControlEnvelopeIssuerSignatureV1(safeEnvelope(), {
      callEvmAtCurrentFinalized: call,
    });
    const assertion = expect(verification).rejects.toMatchObject({
      code: 'CONTROL_SIGNATURE_RPC_TIMEOUT',
      disposition: 'retryable-unavailable',
    });
    await vi.advanceTimersByTimeAsync(CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1);
    await assertion;
  });

  it('honors caller abort before and during a finalized call', async () => {
    const before = new AbortController();
    before.abort();
    await expect(verifyControlEnvelopeIssuerSignatureV1(safeEnvelope(), {
      signal: before.signal,
      callEvmAtCurrentFinalized: callReturning(FINALIZED_OK),
    })).rejects.toMatchObject({ code: 'CONTROL_SIGNATURE_ABORTED' });

    const during = new AbortController();
    const call: CurrentFinalizedEvmCallV1 = vi.fn(async ({ signal }) => new Promise(
      (_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      },
    ));
    const verification = verifyControlEnvelopeIssuerSignatureV1(safeEnvelope(), {
      signal: during.signal,
      callEvmAtCurrentFinalized: call,
    });
    during.abort();
    await expect(verification).rejects.toMatchObject({ code: 'CONTROL_SIGNATURE_ABORTED' });
  });

  it('keeps object identity stable while EIP-1271 re-signing changes variant identity', async () => {
    const first = safeEnvelope('0x12');
    const second = safeEnvelope('0x1234');
    const call = callReturning(FINALIZED_OK);

    const verifiedFirst = readVerifiedControlEnvelopeIssuerSignatureV1(
      await verifyControlEnvelopeIssuerSignatureV1(first, {
        callEvmAtCurrentFinalized: call,
      }),
    );
    const verifiedSecond = readVerifiedControlEnvelopeIssuerSignatureV1(
      await verifyControlEnvelopeIssuerSignatureV1(second, {
        callEvmAtCurrentFinalized: call,
      }),
    );
    expect(verifiedFirst.objectDigest).toBe(verifiedSecond.objectDigest);
    expect(verifiedFirst.signatureVariantDigest).not.toBe(verifiedSecond.signatureVariantDigest);
  });

  it('accepts 1-byte and 4096-byte EIP-1271 signatures and rejects 0/4097 structurally', async () => {
    const call = callReturning(FINALIZED_OK);
    const oneByte = await verifyControlEnvelopeIssuerSignatureV1(safeEnvelope('0xaa'), {
      callEvmAtCurrentFinalized: call,
    });
    expect(readVerifiedControlEnvelopeIssuerSignatureV1(oneByte)).toMatchObject({
      signatureSuite: 'eip1271-current-finalized-v1',
    });
    const maxBytes = await verifyControlEnvelopeIssuerSignatureV1(
      safeEnvelope(`0x${'aa'.repeat(4096)}`),
      { callEvmAtCurrentFinalized: call },
    );
    expect(readVerifiedControlEnvelopeIssuerSignatureV1(maxBytes)).toMatchObject({
      signatureSuite: 'eip1271-current-finalized-v1',
    });
    await expect(verifyControlEnvelopeIssuerSignatureV1(safeEnvelope('0x'), {
      callEvmAtCurrentFinalized: call,
    })).rejects.toMatchObject({ code: 'CONTROL_SIGNATURE_ENVELOPE_INVALID' });
    await expect(verifyControlEnvelopeIssuerSignatureV1(
      safeEnvelope(`0x${'aa'.repeat(4097)}`),
      { callEvmAtCurrentFinalized: call },
    )).rejects.toMatchObject({ code: 'CONTROL_SIGNATURE_ENVELOPE_INVALID' });
  });
});

async function eoaEnvelope(wallet: ethers.Wallet): Promise<SignedControlEnvelopeV1> {
  const unsigned: UnsignedControlEnvelopeV1 = {
    objectType: 'ContextGraphPolicyV1',
    payload: {
      contextGraphId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/verification',
      networkId: 'otp:20430',
      version: '1',
    },
    signatureSuite: 'eip191-personal-sign-digest-v1',
    issuer: wallet.address.toLowerCase(),
    signatureEvidence: { kind: 'none' },
  };
  const objectDigest = computeControlObjectDigestHex(unsigned);
  return {
    ...unsigned,
    objectDigest,
    signature: (await wallet.signMessage(ethers.getBytes(objectDigest))).toLowerCase(),
  };
}

function safeEnvelope(signature = '0x1234'): SignedControlEnvelopeV1 {
  const unsigned: UnsignedControlEnvelopeV1 = {
    objectType: 'ContextGraphCheckpointV1',
    payload: {
      contextGraphId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/verification',
      networkId: 'otp:20430',
      version: '1',
    },
    signatureSuite: 'eip1271-current-finalized-v1',
    issuer: SAFE,
    signatureEvidence: {
      kind: 'eip1271-current-finalized',
      chainId: '20430',
      contractAddress: SAFE,
    },
  };
  return {
    ...unsigned,
    objectDigest: computeControlObjectDigestHex(unsigned),
    signature,
  };
}

function callReturning(result: CurrentFinalizedEvmCallResultV1): CurrentFinalizedEvmCallV1 {
  return vi.fn(async () => result);
}

function serializedSignature(r: bigint, s: bigint, v: '1b' | '1c'): string {
  return `0x${r.toString(16).padStart(64, '0')}${s
    .toString(16)
    .padStart(64, '0')}${v}`;
}
