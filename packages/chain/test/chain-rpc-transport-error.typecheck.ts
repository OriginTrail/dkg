import {
  ChainRpcTransportError,
  RpcEndpointsExhaustedError,
} from '../src/chain-rpc-transport-error.js';

new RpcEndpointsExhaustedError('provider pool exhausted', {
  exhaustionKind: 'all-throttled',
  retryAfterMs: 1_000,
});

new ChainRpcTransportError('RPC_TIMEOUT', 'timed out', {
  // @ts-expect-error Provider-pool metadata is valid only on RpcEndpointsExhaustedError.
  exhaustionKind: 'all-throttled',
});
