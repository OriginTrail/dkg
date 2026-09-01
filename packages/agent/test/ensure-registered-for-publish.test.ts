/**
 * #1116 (round 11, reviewer 🟡 #3) — focused UNIT tests for
 * `DKGAgent.ensureRegisteredForPublish`, exercising the two previously-untested
 * branches: (a) stored-option forwarding into registerContextGraph, and (b) the
 * check-then-act RACE-CONFIRM path (swallow vs rethrow).
 *
 * No live daemon / chain — we bind the prototype method to a minimal stub that
 * records the args its dependencies were called with, the same pattern used by
 * `dkg-agent-on-chain-policy.test.ts` / `encrypt-inline-policy.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';

type Stub = Record<string, any>;
const DEFAULT_PUBLISHER = { id: 'default-publisher' };
const SELECTED_PUBLISHER = { id: 'selected-publisher' };

/** Minimal stub: only the dependencies ensureRegisteredForPublish actually calls.
 * #1085 (R7) — the publish auto-register path reads the create-time policy + PCA
 * directly from the canonical `getStoredContextGraphRegistrationOptions` reader
 * (the caller-shaped shared resolver was removed), so that is the boundary these
 * tests stub. It forwards BOTH stored fields and stays fail-loud. */
function makeStub(overrides: Stub = {}): Stub {
  return {
    getContextGraphOnChainId: async () => null,
    getStoredContextGraphRegistrationOptions: async () => ({}),
    registerContextGraph: async () => undefined,
    publisher: DEFAULT_PUBLISHER,
    ...overrides,
  };
}

function callEnsure(stub: Stub, cgId: string, opts?: { callerAgentAddress?: string; publisher?: unknown }) {
  return (DKGAgent.prototype as any).ensureRegisteredForPublish.call(stub, cgId, opts);
}

describe('DKGAgent.ensureRegisteredForPublish', () => {
  it('short-circuits (no register) when an on-chain id already exists', async () => {
    const registerCalls: any[] = [];
    const stub = makeStub({
      getContextGraphOnChainId: async () => 42n,
      registerContextGraph: async (...a: any[]) => { registerCalls.push(a); },
    });
    await callEnsure(stub, 'cg-already');
    expect(registerCalls.length).toBe(0); // idempotent — no second mint
  });

  it('(a) reads stored options for the EXACT publish cg id, then forwards its publishPolicy / publishAuthorityAccountId + callerAgentAddress into registerContextGraph', async () => {
    const registerCalls: Array<[string, any]> = [];
    const storedReads: any[][] = [];
    const stub = makeStub({
      getContextGraphOnChainId: async () => null, // not yet registered
      getStoredContextGraphRegistrationOptions: async (...a: any[]) => {
        storedReads.push(a);
        return {
          publishPolicy: 1,
          publishAuthorityAccountId: '0x00000000000000000000000000000000000000ab',
        };
      },
      registerContextGraph: async (cgId: string, regOpts: any) => { registerCalls.push([cgId, regOpts]); },
    });

    await callEnsure(stub, 'cg-stored', { callerAgentAddress: '0x00000000000000000000000000000000000000c1' });

    // The publish path reads stored options for the EXACT publish contextGraphId
    // (no body policy exists here) — a regression that queried the wrong CG fails.
    expect(storedReads).toEqual([['cg-stored']]);

    expect(registerCalls.length).toBe(1);
    const [cgId, regOpts] = registerCalls[0];
    expect(cgId).toBe('cg-stored');
    expect(regOpts.publishPolicy).toBe(1);
    expect(regOpts.publishAuthorityAccountId).toBe('0x00000000000000000000000000000000000000ab');
    expect(regOpts.callerAgentAddress).toBe('0x00000000000000000000000000000000000000c1');
    expect(regOpts.publisher).toBe(DEFAULT_PUBLISHER);
  });

  it('(a) omits stored fields that are undefined (does not forward absent options)', async () => {
    const registerCalls: Array<[string, any]> = [];
    const stub = makeStub({
      getStoredContextGraphRegistrationOptions: async () => ({}), // nothing stored
      registerContextGraph: async (cgId: string, regOpts: any) => { registerCalls.push([cgId, regOpts]); },
    });
    await callEnsure(stub, 'cg-bare');
    expect(registerCalls.length).toBe(1);
    const regOpts = registerCalls[0][1];
    expect('publishPolicy' in regOpts).toBe(false);
    expect('publishAuthorityAccountId' in regOpts).toBe(false);
    expect('callerAgentAddress' in regOpts).toBe(false);
  });

  it('(a) FAIL-LOUD: a stored-options read failure PROPAGATES and does NOT register (never mints under a default policy — #1085)', async () => {
    const registerCalls: any[] = [];
    const stub = makeStub({
      getContextGraphOnChainId: async () => null, // not yet registered → proceeds to read stored
      getStoredContextGraphRegistrationOptions: async () => { throw new Error('stored registration-options read failed'); },
      registerContextGraph: async (...a: any[]) => { registerCalls.push(a); },
    });
    // The publish path is fail-loud: a store-read error must surface, not
    // silently register the CG under the DEFAULT policy (that would drop the
    // create-time policy on-chain — exactly the #1085 regression).
    await expect(callEnsure(stub, 'cg-readfail')).rejects.toThrow(/read failed/i);
    expect(registerCalls.length).toBe(0);
  });

  it('(b) race-confirm: registerContextGraph throws "already registered on-chain" AND an id now exists ⇒ RETURNS (swallows)', async () => {
    let onChainIdCalls = 0;
    let registrationPublisher: unknown;
    const stub = makeStub({
      // First call (the pre-check) → null; second call (the race confirm) → truthy.
      getContextGraphOnChainId: async () => {
        onChainIdCalls += 1;
        return onChainIdCalls >= 2 ? 7n : null;
      },
      registerContextGraph: async (_cgId: string, opts: Record<string, unknown>) => {
        registrationPublisher = opts.publisher;
        throw new Error('Context graph "cg-race" is already registered on-chain.');
      },
    });

    // Must NOT throw — the concurrent publisher won the race; the CG IS registered.
    await expect(callEnsure(stub, 'cg-race', { publisher: SELECTED_PUBLISHER })).resolves.toBeUndefined();
    expect(registrationPublisher).toBe(SELECTED_PUBLISHER);
    expect(onChainIdCalls).toBeGreaterThanOrEqual(2); // it re-checked after the throw
  });

  it('(b) race-confirm: "already registered" but the id is STILL falsy ⇒ RETHROWS', async () => {
    const stub = makeStub({
      getContextGraphOnChainId: async () => null, // never resolves to a truthy id
      registerContextGraph: async () => {
        throw new Error('Context graph "cg-noid" is already registered on-chain.');
      },
    });
    await expect(callEnsure(stub, 'cg-noid')).rejects.toThrow(/already registered on-chain/i);
  });

  it('(b) a genuine registration failure (NOT "already registered") always RETHROWS', async () => {
    const stub = makeStub({
      getContextGraphOnChainId: async () => null,
      registerContextGraph: async () => {
        throw new Error('insufficient TRAC to register context graph');
      },
    });
    await expect(callEnsure(stub, 'cg-fail')).rejects.toThrow(/insufficient TRAC/i);
  });

  it('rejects unauthorized local registration before expensive preparation', async () => {
    const order: string[] = [];
    const signerAddress = '0x00000000000000000000000000000000000000b2';
    const capability = {
      signerAddress,
      coverage: { source: 'explicit', accountId: 17n },
      submit: async () => ({ contextGraphId: 1n }),
    };
    const stub = {
      store: {},
      chain: {
        chainId: 'hardhat',
        async prepareOnChainContextGraphRegistration(options: unknown) {
          order.push('prepare');
          expect(options).toEqual({ registrationPcaAccountId: 17n });
          return capability;
        },
      },
      peerId: 'peer-test',
      defaultAgentAddress: signerAddress,
      log: { warn() {}, info() {} },
      contextGraphExists: async () => true,
      getContextGraphCurator: async () => {
        order.push('curator-preflight');
        return 'did:dkg:agent:0x00000000000000000000000000000000000000c3';
      },
      isCallerOrNodeAddressOwner: () => false,
    };

    await expect(
      (DKGAgent.prototype as any).registerContextGraph.call(stub, 'cg-prepared-first', {
        registrationPcaAccountId: 17n,
      }),
    ).rejects.toThrow(/Only the context graph curator/);
    expect(order).toEqual(['curator-preflight']);
  });
});
