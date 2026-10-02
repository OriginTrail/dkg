import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authorityIndexTrustDomain,
  planAuthorityIndexBootstrap,
  resolveAuthorityIndexConfig,
} from '../src/authority-index-config.js';

const RELAY_PEER = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const relay = `/ip4/127.0.0.1/tcp/9200/p2p/${RELAY_PEER}`;
const SECOND_RELAY_PEER = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const secondRelay = `/dns4/relay.example.com/tcp/9090/p2p/${SECOND_RELAY_PEER}`;
// Distinct valid identities: the relays of the shipped Base and Gnosis network files.
const TEN_PEERS = [
  '12D3KooWFWm8sg6dkitmdBd5Uxaqp3CDRL27mFcM7vEHK92Xapyy',
  '12D3KooWMasqzRrim48ZJM64UyTfHufDTmSG3n3jqwsS5phz8m91',
  '12D3KooWDgTunUpkGaE7dYCaDP1CCBT6Dm2HPMXSZhJn2KXYLH15',
  '12D3KooWCodgXHMwybaEe93rbKgWMfGXQvUb6cpT3VCrjCbbnyEu',
  '12D3KooWL9gwurFAVhQguJVs8CpzuSbt2hom9jyNJ5oHdHfyz351',
  '12D3KooWS8pRJLrDgjqBNGJAjHDF7VoNrE4igbZ2tt9N61u7AUrG',
  '12D3KooWGEW48Foccg27wPyKv66oUnjeAx46p1mQkWURXw8orCA1',
  '12D3KooWLwPkoiastt27S2SRPtdx6t8KuFXwcbHovgCkAMfkJcXx',
  '12D3KooWJth5STEUczjRh2NXqBedRtvrsjrB11172CUZbKGKNPKg',
  '12D3KooWD2Q9pd6q6qT2hKPuXHRB6TGmGa12xNPyRphb2kTeVMZm',
];

/** Everything core-snapshot mode needs, as `DKGAgent.create` receives it from the daemon. */
const wiredEdge = {
  nodeRole: 'edge' as const,
  chainConfig: { operationalKeys: [`0x${'11'.repeat(32)}`] },
  localContextGraphAuthorityIndexStore: {},
  networkRelays: [relay, secondRelay],
};

describe('planAuthorityIndexBootstrap', () => {
  it('seeds an edge without operator config from the network relays through the explicit normalizer', () => {
    const plan = planAuthorityIndexBootstrap(wiredEdge);
    expect(plan.source).toBe('network-relays');
    expect(plan.config).toEqual({
      mode: 'core-snapshot',
      trustedCorePeers: [relay, secondRelay],
      maxTailBlocks: 2_000,
      cacheEpoch: 0,
    });
    expect(plan.config!.snapshot.trustedCorePeers).toEqual([
      { peerId: RELAY_PEER, multiaddr: relay },
      { peerId: SECOND_RELAY_PEER, multiaddr: secondRelay },
    ]);
    // Nothing runtime-only rides on it: its serialized form is a config.json
    // block pinning the same relays, which resolves to the same trust namespace.
    const persisted = JSON.parse(JSON.stringify(plan.config));
    expect(persisted).toEqual({
      mode: 'core-snapshot', trustedCorePeers: [relay, secondRelay], maxTailBlocks: 2_000, cacheEpoch: 0,
    });
    expect(authorityIndexTrustDomain(resolveAuthorityIndexConfig(persisted, 'edge')!))
      .toBe(authorityIndexTrustDomain(plan.config!));
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it('pins only relays with a valid final PeerID, first address per identity, in network-file order', () => {
    const plan = planAuthorityIndexBootstrap({
      ...wiredEdge,
      networkRelays: [
        '/ip4/178.105.87.39/tcp/9090/p2p/PEER_ID_SOLARIS',
        secondRelay,
        '/ip4/127.0.0.1/tcp/9200',
        'not a multiaddr',
        `/ip4/127.0.0.2/tcp/9201/p2p/${SECOND_RELAY_PEER}`,
        relay,
      ],
    });
    expect(plan.source).toBe('network-relays');
    expect(plan.config!.trustedCorePeers).toEqual([secondRelay, relay]);
  });

  it('caps the relay trust set at eight identities', () => {
    const relays = TEN_PEERS.map((peerId, index) => `/ip4/10.0.0.${index + 1}/tcp/9090/p2p/${peerId}`);
    const plan = planAuthorityIndexBootstrap({ ...wiredEdge, networkRelays: relays });
    expect(plan.config!.trustedCorePeers).toEqual(relays.slice(0, 8));
  });

  it('lets operator config win over the network relays, without a fallback source', () => {
    const plan = planAuthorityIndexBootstrap({
      ...wiredEdge,
      authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [secondRelay], cacheEpoch: 2 },
    });
    expect(plan.source).toBe('operator');
    expect(plan.config).toMatchObject({ trustedCorePeers: [secondRelay], cacheEpoch: 2 });
    // The daemon's early validation hands the agent this same resolved value.
    const resolved = resolveAuthorityIndexConfig({ mode: 'core-snapshot', trustedCorePeers: [relay] }, 'edge');
    expect(planAuthorityIndexBootstrap({ ...wiredEdge, authorityIndex: resolved }).config).toBe(resolved);
  });

  it.each([
    ['an injected chain adapter', { chainAdapter: {} }],
    ['no EVM chain', { chainConfig: undefined }],
    ['no operational key', { chainConfig: { operationalKeys: [] } }],
    ['no local index store', { localContextGraphAuthorityIndexStore: undefined }],
  ])('never downgrades operator config the agent cannot run: %s', (_label, overrides) => {
    expect(() => planAuthorityIndexBootstrap({
      ...wiredEdge,
      ...overrides,
      authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [relay] },
    })).toThrow(new TypeError(
      'authorityIndex core-snapshot mode requires a configured EVM chain and a local authority index store',
    ));
  });

  it.each([
    [{ chainAdapter: {} }, 'the chain adapter is injected (such as the mock chain), not a configured EVM chain'],
    [{ chainConfig: undefined }, 'no EVM chain is configured'],
    [{ chainConfig: { operationalKeys: [] } }, 'no operational key is configured'],
    [{ localContextGraphAuthorityIndexStore: undefined }, 'no local authority index store is available'],
    [{ networkRelays: [] }, 'no network relay is available to seed from'],
    [{ networkRelays: undefined }, 'no network relay is available to seed from'],
    [{ networkRelays: ['/ip4/178.105.87.39/tcp/9090/p2p/PEER_ID_KEPLER'] }, 'no network relay is available to seed from'],
  ])('keeps an edge that cannot seed on local history and says why: %j', (overrides, skipReason) => {
    expect(planAuthorityIndexBootstrap({ ...wiredEdge, ...overrides })).toEqual({
      source: 'local-history',
      skipReason,
    });
  });

  it('treats a missing role as edge, like the agent', () => {
    expect(planAuthorityIndexBootstrap({ ...wiredEdge, nodeRole: undefined }).source).toBe('network-relays');
  });

  it('keeps a core on its own chain history with nothing to report, and still rejects operator config there', () => {
    expect(planAuthorityIndexBootstrap({ ...wiredEdge, nodeRole: 'core' })).toEqual({ source: 'local-history' });
    expect(() => planAuthorityIndexBootstrap({
      ...wiredEdge,
      nodeRole: 'core',
      authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [relay] },
    })).toThrow('only supported on edge nodes');
  });
});

describe('authorityIndexTrustDomain', () => {
  const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

  it('keys the persistence namespace by sorted PeerIDs, epoch zero keeping the original bytes', () => {
    const config = resolveAuthorityIndexConfig({
      mode: 'core-snapshot', trustedCorePeers: [secondRelay, relay],
    }, 'edge')!;
    expect(authorityIndexTrustDomain(config)).toBe(sha256([RELAY_PEER, SECOND_RELAY_PEER]));
  });

  it('adds a non-zero cache epoch to the namespace', () => {
    const config = resolveAuthorityIndexConfig({
      mode: 'core-snapshot', trustedCorePeers: [relay, secondRelay], cacheEpoch: 3,
    }, 'edge')!;
    expect(authorityIndexTrustDomain(config)).toBe(sha256({
      trustedCorePeers: [RELAY_PEER, SECOND_RELAY_PEER],
      cacheEpoch: 3,
    }));
  });
});
