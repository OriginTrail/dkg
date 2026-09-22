import { describe, expect, it, vi } from 'vitest';
import { resolveDefaultAuthorityIndexConfig } from '@origintrail-official/dkg-agent';
import {
  decideAuthorityIndexBootstrap,
  type AuthorityIndexBootstrapDecisionInput,
} from '../src/daemon/authority-index-bootstrap-decision.js';

// The daemon decides the discovered edge default only once it knows the
// agent's chain wiring, from the same facts `DKGAgent.create` checks (it
// rejects ANY core-snapshot config, explicit or default, without a real EVM
// chain, operational keys and a local index store). This pins every
// combination without booting a daemon; `daemon-sync-agents-meta-wiring.test.ts`
// drives the real call site for a mock-chain and an EVM edge.

const explicitConfig = Object.freeze({ mode: 'core-snapshot' as const, trustedCorePeers: ['pinned'] });
const discoveredDefault = Object.freeze({ mode: 'core-snapshot' as const, discovery: 'on-chain-cores' as const });
type StubConfig = typeof explicitConfig | typeof discoveredDefault;

type ChainWiringFacts = Pick<
  AuthorityIndexBootstrapDecisionInput<unknown>,
  'nodeRole' | 'hasEvmChainConfig' | 'usesMockChainAdapter' | 'operationalWalletCount' | 'hasLocalAuthorityIndexStore'
>;

// An edge on a real EVM chain with an operational wallet and the daemon's store.
const satisfiedEdge: ChainWiringFacts = {
  nodeRole: 'edge',
  hasEvmChainConfig: true,
  usesMockChainAdapter: false,
  operationalWalletCount: 1,
  hasLocalAuthorityIndexStore: true,
};

// Every precondition failing at once, as a mock-chain edge with an empty
// wallets.json and no store would present.
const unsatisfied: Omit<ChainWiringFacts, 'nodeRole'> = {
  hasEvmChainConfig: false,
  usesMockChainAdapter: true,
  operationalWalletCount: 0,
  hasLocalAuthorityIndexStore: false,
};

function decide(overrides: Partial<ChainWiringFacts> & { explicitAuthorityIndex?: StubConfig }) {
  const resolveDefault = vi.fn((_nodeRole: 'edge'): StubConfig | undefined => discoveredDefault);
  const decision = decideAuthorityIndexBootstrap<StubConfig>({
    ...satisfiedEdge,
    explicitAuthorityIndex: undefined,
    ...overrides,
    resolveDefault,
  });
  return { decision, resolveDefault };
}

describe('decideAuthorityIndexBootstrap', () => {
  it('forwards an explicit block untouched whatever the chain wiring, without consulting the default', () => {
    const { decision, resolveDefault } = decide({ ...unsatisfied, explicitAuthorityIndex: explicitConfig });
    expect(decision.authorityIndex).toBe(explicitConfig);
    expect(decision).toStrictEqual({ authorityIndex: explicitConfig });
    expect(resolveDefault).not.toHaveBeenCalled();
  });

  it('gives an edge with an EVM chain, operational wallets and the local store the discovered default', () => {
    const { decision, resolveDefault } = decide({});
    expect(decision.authorityIndex).toBe(discoveredDefault);
    expect(decision).toStrictEqual({ authorityIndex: discoveredDefault });
    expect(resolveDefault).toHaveBeenCalledTimes(1);
    expect(resolveDefault).toHaveBeenCalledWith('edge');
  });

  it("resolves the agent's own role default for a satisfied edge", () => {
    const decision = decideAuthorityIndexBootstrap({
      ...satisfiedEdge,
      explicitAuthorityIndex: undefined,
      resolveDefault: resolveDefaultAuthorityIndexConfig,
    });
    expect(decision.reason).toBeUndefined();
    expect(decision.authorityIndex).toMatchObject({
      mode: 'core-snapshot',
      discovery: 'on-chain-cores',
      trustedCorePeers: [],
      maxTailBlocks: 2_000,
      cacheEpoch: 0,
    });
  });

  it.each([
    {
      case: 'mock chain adapter (which also has no projected EVM config)',
      overrides: { usesMockChainAdapter: true, hasEvmChainConfig: false },
      reason: 'the node runs the mock chain adapter (chain.type is "mock")',
    },
    {
      case: 'no chain configuration',
      overrides: { hasEvmChainConfig: false },
      reason: 'no EVM chain is configured (chain.rpcUrl and chain.hubAddress are required)',
    },
    {
      case: 'no operational wallets',
      overrides: { operationalWalletCount: 0 },
      reason: 'no operational wallet is configured (wallets.json has no operational keys)',
    },
    {
      case: 'no local authority index store (SDK embedder)',
      overrides: { hasLocalAuthorityIndexStore: false },
      reason: 'no local authority index store is available',
    },
  ])('keeps an edge with $case on local history and says why', ({ overrides, reason }) => {
    const { decision, resolveDefault } = decide(overrides);
    expect(decision).toStrictEqual({ authorityIndex: undefined, reason });
    expect(resolveDefault).not.toHaveBeenCalled();
  });

  it('reports the single most actionable reason when several preconditions fail', () => {
    const { decision } = decide(unsatisfied);
    expect(decision.reason).toBe('the node runs the mock chain adapter (chain.type is "mock")');
    expect(decide({ ...unsatisfied, usesMockChainAdapter: false }).decision.reason)
      .toBe('no EVM chain is configured (chain.rpcUrl and chain.hubAddress are required)');
    expect(decide({ ...unsatisfied, usesMockChainAdapter: false, hasEvmChainConfig: true }).decision.reason)
      .toBe('no operational wallet is configured (wallets.json has no operational keys)');
  });

  it.each([
    { case: 'chain wiring that would satisfy an edge', overrides: {} },
    { case: 'no chain wiring at all', overrides: unsatisfied },
  ])('gives a core no default and no skip reason with $case', ({ overrides }) => {
    const { decision, resolveDefault } = decide({ ...overrides, nodeRole: 'core' });
    expect(decision).toStrictEqual({ authorityIndex: undefined });
    expect(resolveDefault).not.toHaveBeenCalled();
  });
});
