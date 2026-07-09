/**
 * #1337 (via Mechanism B endpoint stickiness): the SWM public-CG gate
 * (`DKGAgent.isContextGraphPublicOnChain` → `resolveOnChainAccessPolicyState`)
 * makes up to THREE sequential on-chain policy reads
 * (`getContextGraphNameHash` → `isContextGraphActiveOnChain` →
 * `getContextGraphAccessPolicy`), each wrapped in the agent's 2.5s
 * `raceChainPolicyRead`. Under a DEGRADED primary, on `main` every one of those
 * reads restarts the failover loop at endpoint[0] and re-stalls on the primary —
 * so each read blows the 2.5s race and the gate fails closed (SWM wrongly kept
 * encrypted), even though a healthy backup is configured.
 *
 * These drive the REAL `EVMChainAdapter` policy-read methods through the REAL
 * `RpcFailoverClient` (bare-provider doubles, no Hardhat — sibling of
 * `evm-adapter-cg-deposit-failover.unit.test.ts`). They prove the transport-level
 * behavior that resolves #1337: once one read fails over to the backup, endpoint
 * stickiness makes the NEXT policy read start on that backup, so it finishes well
 * under the 2.5s race instead of re-stalling on the primary. (The agent's
 * `raceChainPolicyRead` wrapper + the `isContextGraphPublicOnChain` wiring onto
 * these methods are covered independently in `packages/agent`'s
 * `swm-public-cg-plaintext.test.ts`; here we model the 2.5s race inline to make
 * the #1337 fail-close / pass boundary explicit against the real transport.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { RPC_READ_STALL_TIMEOUT_MS } from '../src/evm-adapter-constants.js';
import { _resetRpcFailoverStatsForTest } from '../src/rpc-failover-log.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

// The agent's per-read policy race (dkg-agent-constants CHAIN_POLICY_READ_TIMEOUT_MS
// = 2500ms), reproduced here so the #1337 fail-close/pass boundary is explicit.
// It is deliberately TIGHTER than the 4s transport cap (RPC_READ_STALL_TIMEOUT_MS),
// so a primary stall fails the race BEFORE the transport fails over.
const CHAIN_POLICY_RACE_MS = 2_500;

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    adminPrivateKey: ADMIN_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
    ...overrides,
  };
}

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

const retryable429 = () => { const e = new Error('429 too many requests'); (e as any).status = 429; return e; };

interface EndpointViews {
  isActive: () => Promise<boolean>;
  getPolicy: () => Promise<bigint>;
}

// Real EVMChainAdapter, two endpoints, ContextGraphStorage stubbed as a
// per-endpoint `connect` double so the context-graph policy reads run the REAL
// `this.readContract` → `rpcFailover` failover (mirrors the #1535 deposit-failover
// harness). `p0` = primary, `p1` = backup.
function makePolicyAdapter(views: { primary: EndpointViews; backup: EndpointViews }) {
  const a: any = new EVMChainAdapter(minimalConfig());
  a.initialized = true;
  a.init = async () => { a.initialized = true; };
  a.ensureConfiguredStaticChainIdValidated = async () => {};

  const p0 = {}; const p1 = {};
  a.providers = [p0, p1];
  a.rpcUrls = ['https://primary.example', 'https://backup.example'];

  a.contracts = {
    contextGraphStorage: {
      connect: (p: unknown) => {
        const v = p === p0 ? views.primary : views.backup;
        return {
          isContextGraphActive: (_id: bigint) => v.isActive(),
          getAccessPolicy: (_id: bigint) => v.getPolicy(),
        };
      },
    },
  };
  return { a };
}

describe('#1337: context-graph policy reads reuse the last-good endpoint (Mechanism B stickiness)', () => {
  afterEach(() => { vi.useRealTimers(); _resetRpcFailoverStatsForTest(); });

  it('a STALLED primary fails the 2.5s policy race, but primes the preferred so the NEXT read passes it', async () => {
    vi.useFakeTimers();
    const primaryActive = recorder(() => new Promise<boolean>(() => {})); // hangs forever
    const backupActive = recorder(async () => true);
    const { a } = makePolicyAdapter({
      primary: { isActive: primaryActive, getPolicy: async () => 0n },
      backup: { isActive: backupActive, getPolicy: async () => 0n },
    });

    const SENTINEL = Symbol('policy-read-timeout');
    const race = <T>(p: Promise<T>, ms: number): Promise<T | typeof SENTINEL> => {
      let t: ReturnType<typeof setTimeout>;
      const to = new Promise<typeof SENTINEL>((r) => { t = setTimeout(() => r(SENTINEL), ms); });
      return Promise.race([p.finally(() => clearTimeout(t)), to]);
    };

    // Read #1: primary hangs. The 2.5s policy race fails closed while the 4s
    // transport cap keeps the read running underneath.
    const read1 = a.isContextGraphActiveOnChain(7n);
    const raced1 = race(read1, CHAIN_POLICY_RACE_MS);
    await vi.advanceTimersByTimeAsync(CHAIN_POLICY_RACE_MS);
    expect(await raced1).toBe(SENTINEL); // #1337 symptom: the policy read fails closed at 2.5s

    // The transport cap (4s) then fires → the read fails over to the backup →
    // establishes preferred = backup (the background completion the review flagged).
    await vi.advanceTimersByTimeAsync(RPC_READ_STALL_TIMEOUT_MS - CHAIN_POLICY_RACE_MS + 100);
    expect(await read1).toBe(true); // eventually completed on the backup

    // Read #2: preferred = backup → tries the backup FIRST → resolves fast, well
    // inside the 2.5s race. On `main` (index-0) it would re-stall on the primary
    // and fail the race again.
    const read2 = a.isContextGraphActiveOnChain(7n);
    const raced2 = race(read2, CHAIN_POLICY_RACE_MS);
    await vi.advanceTimersByTimeAsync(50);
    expect(await raced2).toBe(true); // #1337 FIXED: the second policy read passes the race
    expect(primaryActive.calls).toHaveLength(1); // primary NOT re-probed on read #2 (index-0 → 2)
    expect(backupActive.calls).toHaveLength(2);  // read #1 failover + read #2 preferred-first
  });

  it('one failover primes the preferred for a SUBSEQUENT heterogeneous policy read (the 3 sequential reads share it)', async () => {
    // A degraded (but fast-erroring) primary — the cross-op ordering proof, no
    // stalls needed. isContextGraphActiveOnChain establishes the preferred; the
    // DIFFERENT getContextGraphAccessPolicy read then starts on that same backend.
    const primaryActive = recorder(async () => { throw retryable429(); });
    const backupActive = recorder(async () => true);
    const primaryPolicy = recorder(async () => { throw retryable429(); });
    const backupPolicy = recorder(async () => 0n);
    const { a } = makePolicyAdapter({
      primary: { isActive: primaryActive, getPolicy: primaryPolicy },
      backup: { isActive: backupActive, getPolicy: backupPolicy },
    });

    // Read #1 (isContextGraphActiveOnChain): primary 429 → fail over → backup ok → preferred := backup
    expect(await a.isContextGraphActiveOnChain(7n)).toBe(true);
    expect(primaryActive.calls).toHaveLength(1);
    expect(backupActive.calls).toHaveLength(1);

    // Read #2 (getContextGraphAccessPolicy): a DIFFERENT method on the same storage
    // contract → preferred = backup → backup FIRST → the primary is NOT re-probed.
    expect(await a.getContextGraphAccessPolicy(7n)).toBe(0);
    expect(backupPolicy.calls).toHaveLength(1);
    expect(primaryPolicy.calls).toHaveLength(0); // #1337: the 2nd sequential read does not re-stall the primary
  });

  it('kill-switch (DKG_DISABLE_RPC_STICKINESS=1) reproduces the pre-change re-stall on the 2nd read', async () => {
    const prev = process.env.DKG_DISABLE_RPC_STICKINESS;
    process.env.DKG_DISABLE_RPC_STICKINESS = '1';
    try {
      const primaryPolicy = recorder(async () => { throw retryable429(); });
      const backupPolicy = recorder(async () => 0n);
      const { a } = makePolicyAdapter({
        primary: { isActive: async () => { throw retryable429(); }, getPolicy: primaryPolicy },
        backup: { isActive: async () => true, getPolicy: backupPolicy },
      });

      expect(await a.isContextGraphActiveOnChain(7n)).toBe(true); // establishes nothing (kill-switch)
      expect(await a.getContextGraphAccessPolicy(7n)).toBe(0);
      expect(primaryPolicy.calls).toHaveLength(1); // index-0: the 2nd read RE-PROBES the primary (the #1337 bug)
    } finally {
      if (prev === undefined) delete process.env.DKG_DISABLE_RPC_STICKINESS;
      else process.env.DKG_DISABLE_RPC_STICKINESS = prev;
    }
  });
});
