// SPDX-License-Identifier: Apache-2.0
/**
 * Review coverage gap (PR #1409): the agent's `drainRpcUsage()` is THE
 * boundary the daemon telemetry consumes (`startRpcUsageTelemetry({ source:
 * agent })`), and a delegation regression here would silence every rpc_usage
 * log while the chain-side and cli-side tests stayed green. These drive the
 * REAL method (prototype-invoked with a chain-bearing `this`, the established
 * pattern for agent unit tests) against the real MockChainAdapter, a
 * counts-bearing adapter, and an adapter lacking the capability.
 */
import { describe, it, expect } from 'vitest';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import { DKGAgent } from '../src/dkg-agent.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';

const drain = DKGAgentBase.prototype.drainRpcUsage;

describe('DKGAgent.drainRpcUsage — the adapter→agent telemetry boundary', () => {
  it('delegates to the adapter and passes the window through VERBATIM', () => {
    const window = { byMethod: { eth_call: 42, eth_getLogs: 7 }, total: 49, lifetimeTotal: 49 };
    const out = drain.call({ chain: { drainRpcUsage: () => window } } as never);
    expect(out).toBe(window); // same object — no reshaping/copying in the boundary
  });

  it('returns the real MockChainAdapter empty window (capability present, no transport)', () => {
    const chain = new MockChainAdapter();
    const out = drain.call({ chain } as never);
    expect(out).toEqual({ byMethod: {}, total: 0, lifetimeTotal: 0 });
  });

  it('collapses a missing adapter capability to a concrete EMPTY window (consumers never see undefined)', () => {
    const out = drain.call({ chain: {} } as never);
    expect(out).toEqual({ byMethod: {}, total: 0, lifetimeTotal: 0 });
  });

  it('is inherited by the composed DKGAgent class (the daemon consumes agent, not the base)', () => {
    // The daemon passes the DKGAgent instance as the telemetry source — the
    // method must exist on the composed class's prototype chain.
    expect(typeof DKGAgent.prototype.drainRpcUsage).toBe('function');
    const window = { byMethod: { eth_sendRawTransaction: 3 }, total: 3, lifetimeTotal: 3 };
    const out = DKGAgent.prototype.drainRpcUsage.call({ chain: { drainRpcUsage: () => window } } as never);
    expect(out).toBe(window);
  });
});
