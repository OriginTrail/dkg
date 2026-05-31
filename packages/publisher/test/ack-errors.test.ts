import { describe, it, expect } from 'vitest';
import {
  ACKProviderError,
  RpcPreconditionError,
  QuorumUnmetError,
  isACKProviderError,
  isRpcPreconditionError,
  isQuorumUnmetError,
  wrapAsRpcPreconditionIfApplicable,
} from '../src/ack-errors.js';

describe('PR3 / RC11 — typed ACKProviderError surface', () => {
  describe('RpcPreconditionError', () => {
    it('renders method + url + upstream code in the message', () => {
      const err = new RpcPreconditionError({
        method: 'getEvmChainId',
        message: 'over rate limit',
        url: 'https://sepolia.base.org',
        upstream: -32016,
      });
      expect(err.name).toBe('RpcPreconditionError');
      expect(err.message).toContain('getEvmChainId');
      expect(err.message).toContain('over rate limit');
      expect(err.message).toContain('https://sepolia.base.org');
      expect(err.message).toContain('-32016');
    });

    it('preserves the underlying cause', () => {
      const cause = new Error('connection reset by peer');
      const err = new RpcPreconditionError({
        method: 'getKnowledgeAssetsLifecycleAddress',
        message: 'failed to read',
        cause,
      });
      expect((err as Error & { cause?: unknown }).cause).toBe(cause);
    });

    it('is recognised by all narrowing helpers', () => {
      const err = new RpcPreconditionError({ method: 'x', message: 'y' });
      expect(isACKProviderError(err)).toBe(true);
      expect(isRpcPreconditionError(err)).toBe(true);
      expect(isQuorumUnmetError(err)).toBe(false);
      expect(err).toBeInstanceOf(ACKProviderError);
    });
  });

  describe('QuorumUnmetError', () => {
    it('renders counts and per-peer outcomes', () => {
      const err = new QuorumUnmetError({
        collected: 1,
        required: 3,
        dialled: 4,
        peerOutcomes: [
          { peerId: 'peer-aaaaaaaa', dialOk: true, protocolSupported: true, reason: 'ACK' },
          { peerId: 'peer-bbbbbbbb', dialOk: false, reason: 'TRANSPORT_ERROR' },
          { peerId: 'peer-cccccccc', dialOk: true, protocolSupported: true, swmHostModeAdvertised: false, reason: 'STORAGE_ACK_DECLINE:NO_DATA_IN_SWM' },
          { peerId: 'peer-dddddddd', reason: 'no_response' },
        ],
      });
      expect(err.name).toBe('QuorumUnmetError');
      expect(err.message).toContain('collected=1/3');
      expect(err.message).toContain('dialled=4');
      expect(err.message).toContain('aaaaaaaa');
      expect(err.message).toContain('TRANSPORT_ERROR');
      expect(err.message).toContain('NO_DATA_IN_SWM');
      expect(err.message).toContain('no_response');
      expect(err.peerOutcomes).toHaveLength(4);
    });

    it('embeds legacy message verbatim so storage_ack_* greps still match', () => {
      const err = new QuorumUnmetError({
        collected: 0,
        required: 3,
        dialled: 0,
        peerOutcomes: [],
        legacyMessage: 'storage_ack_insufficient: got 0/3 valid ACKs. Tried 0 core peers.',
      });
      expect(err.message).toContain('storage_ack_insufficient');
      expect(err.message).toContain('QuorumUnmetError');
    });

    it('renders cleanly without peer outcomes', () => {
      const err = new QuorumUnmetError({
        collected: 0,
        required: 3,
        dialled: 0,
      });
      expect(err.message).toMatch(/QuorumUnmetError\(collected=0\/3, dialled=0\)/);
    });

    it('is recognised by all narrowing helpers', () => {
      const err = new QuorumUnmetError({ collected: 0, required: 1, dialled: 0 });
      expect(isACKProviderError(err)).toBe(true);
      expect(isQuorumUnmetError(err)).toBe(true);
      expect(isRpcPreconditionError(err)).toBe(false);
      expect(err).toBeInstanceOf(ACKProviderError);
    });
  });

  describe('wrapAsRpcPreconditionIfApplicable', () => {
    it('promotes a raw Error into a RpcPreconditionError with the method tag', () => {
      const raw = new Error('connection timed out');
      const wrapped = wrapAsRpcPreconditionIfApplicable(raw, 'getEvmChainId');
      expect(wrapped).toBeInstanceOf(RpcPreconditionError);
      expect(wrapped.method).toBe('getEvmChainId');
      expect(wrapped.message).toContain('connection timed out');
      expect((wrapped as Error & { cause?: unknown }).cause).toBe(raw);
    });

    it('passes through an already-typed RpcPreconditionError without re-wrapping', () => {
      const original = new RpcPreconditionError({
        method: 'getKnowledgeAssetsLifecycleAddress',
        message: 'rate limited',
        upstream: -32016,
      });
      const wrapped = wrapAsRpcPreconditionIfApplicable(original, 'getKnowledgeAssetsLifecycleAddress');
      expect(wrapped).toBe(original);
    });

    it('extracts upstream code from ethers-shape errors', () => {
      const ethersErr: Record<string, unknown> = {
        message: 'rate limited',
        info: { error: { code: -32016, message: 'over rate limit' } },
      };
      const wrapped = wrapAsRpcPreconditionIfApplicable(ethersErr, 'getEvmChainId');
      expect(wrapped.upstream).toBe(-32016);
    });

    it('extracts upstream code from JSON-RPC top-level shape', () => {
      const rpcErr: Record<string, unknown> = {
        message: 'unauthorized',
        code: 'UNAUTHORIZED',
      };
      const wrapped = wrapAsRpcPreconditionIfApplicable(rpcErr, 'getMinimumRequiredSignatures');
      expect(wrapped.upstream).toBe('UNAUTHORIZED');
    });

    it('threads the optional url through', () => {
      const raw = new Error('boom');
      const wrapped = wrapAsRpcPreconditionIfApplicable(raw, 'getEvmChainId', {
        url: 'https://sepolia.base.org',
      });
      expect(wrapped.url).toBe('https://sepolia.base.org');
      expect(wrapped.message).toContain('https://sepolia.base.org');
    });
  });
});
