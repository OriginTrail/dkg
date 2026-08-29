import { describe, expect, it } from 'vitest';

import {
  computeRfc64SubGraphKeyV1,
  deriveRfc64ContextGraphSemanticAddressesV1,
  deriveRfc64CurrentAuthorCatalogRefAddressV1,
  deriveRfc64SubgraphSemanticAddressesV1,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type NetworkIdV1,
  type SubGraphNameV1,
} from '../src/index.js';

const NETWORK = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH = (
  '0x0123456789abcdef0123456789abcdef01234567/14'
) as ContextGraphIdV1;
const AUTHOR = '0x89abcdef0123456789abcdef0123456789abcdef' as EvmAddressV1;
const SUBGRAPH = 'research' as SubGraphNameV1;

describe('RFC-64 semantic addresses v1', () => {
  it('freezes collision-safe root and named subgraph key vectors', () => {
    expect(computeRfc64SubGraphKeyV1(null)).toBe(
      '0x746bfff91a7c229a180489f0149b250944da97e5038b125af5df5a74916518e4',
    );
    expect(computeRfc64SubGraphKeyV1(SUBGRAPH)).toBe(
      '0x8e38ab4dfb3e25028a2c1863a0d246817222e60842f7bebe997bc5d60bbcf66e',
    );
  });

  it('derives the exact current-author catalog graph and collision-safe subject', () => {
    expect(deriveRfc64CurrentAuthorCatalogRefAddressV1({
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
      authorAddress: AUTHOR,
    })).toEqual({
      subGraphKey: '0x8e38ab4dfb3e25028a2c1863a0d246817222e60842f7bebe997bc5d60bbcf66e',
      graphUri:
        `did:dkg:context-graph:${CONTEXT_GRAPH}/_sync/catalog/`
        + `0x8e38ab4dfb3e25028a2c1863a0d246817222e60842f7bebe997bc5d60bbcf66e/`
        + `${AUTHOR}/current`,
      subject:
        `urn:dkg:sync:catalog:otp%3A20430:`
        + `0x0123456789abcdef0123456789abcdef01234567%2F14:`
        + `0x8e38ab4dfb3e25028a2c1863a0d246817222e60842f7bebe997bc5d60bbcf66e:`
        + AUTHOR,
    });
  });

  it('isolates one author current-head ref between root and named subgraphs', () => {
    const common = {
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      authorAddress: AUTHOR,
    } as const;
    const root = deriveRfc64CurrentAuthorCatalogRefAddressV1({
      ...common,
      subGraphName: null,
    });
    const named = deriveRfc64CurrentAuthorCatalogRefAddressV1({
      ...common,
      subGraphName: SUBGRAPH,
    });

    expect(root).toEqual({
      subGraphKey: '0x746bfff91a7c229a180489f0149b250944da97e5038b125af5df5a74916518e4',
      graphUri:
        `did:dkg:context-graph:${CONTEXT_GRAPH}/_sync/catalog/`
        + `0x746bfff91a7c229a180489f0149b250944da97e5038b125af5df5a74916518e4/`
        + `${AUTHOR}/current`,
      subject:
        'urn:dkg:sync:catalog:otp%3A20430:'
        + '0x0123456789abcdef0123456789abcdef01234567%2F14:'
        + '0x746bfff91a7c229a180489f0149b250944da97e5038b125af5df5a74916518e4:'
        + AUTHOR,
    });
    expect(root.subGraphKey).not.toBe(named.subGraphKey);
    expect(root.graphUri).not.toBe(named.graphUri);
    expect(root.subject).not.toBe(named.subject);
    expect(root.graphUri).toContain(`/catalog/${root.subGraphKey}/${AUTHOR}/current`);
    expect(named.graphUri).toContain(`/catalog/${named.subGraphKey}/${AUTHOR}/current`);
  });

  it('derives every per-subgraph reserved graph and fixed subject', () => {
    const addresses = deriveRfc64SubgraphSemanticAddressesV1({
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
    });
    expect(addresses).toEqual({
      subGraphKey: '0x8e38ab4dfb3e25028a2c1863a0d246817222e60842f7bebe997bc5d60bbcf66e',
      appliedSeal: {
        graphUri: `did:dkg:context-graph:${CONTEXT_GRAPH}/_sync/applied/${addresses.subGraphKey}`,
        subject:
          `urn:dkg:sync:applied:otp%3A20430:`
          + `0x0123456789abcdef0123456789abcdef01234567%2F14:${addresses.subGraphKey}`,
      },
      mutationGuard: {
        graphUri: `did:dkg:context-graph:${CONTEXT_GRAPH}/_sync/mutation/${addresses.subGraphKey}`,
        subject:
          `urn:dkg:sync:mutation:otp%3A20430:`
          + `0x0123456789abcdef0123456789abcdef01234567%2F14:${addresses.subGraphKey}`,
      },
      reconcileTarget: {
        graphUri:
          `did:dkg:context-graph:${CONTEXT_GRAPH}/_sync/reconcile-target/${addresses.subGraphKey}`,
        subject:
          `urn:dkg:sync:reconcile-target:otp%3A20430:`
          + `0x0123456789abcdef0123456789abcdef01234567%2F14:${addresses.subGraphKey}`,
      },
    });
  });

  it('derives every context-graph-wide reserved graph and fixed subject', () => {
    expect(deriveRfc64ContextGraphSemanticAddressesV1({
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
    })).toEqual({
      mutationGuard: {
        graphUri: `did:dkg:context-graph:${CONTEXT_GRAPH}/_sync/mutation-cg`,
        subject:
          'urn:dkg:sync:mutation-cg:otp%3A20430:'
          + '0x0123456789abcdef0123456789abcdef01234567%2F14',
      },
      appliedSetRef: {
        graphUri: `did:dkg:context-graph:${CONTEXT_GRAPH}/_sync/applied-set`,
        subject:
          'urn:dkg:sync:applied-set:otp%3A20430:'
          + '0x0123456789abcdef0123456789abcdef01234567%2F14',
      },
      appliedSeal: {
        graphUri: `did:dkg:context-graph:${CONTEXT_GRAPH}/_sync/applied-cg`,
        subject:
          'urn:dkg:sync:applied-cg:otp%3A20430:'
          + '0x0123456789abcdef0123456789abcdef01234567%2F14',
      },
    });
  });

  it('rejects noncanonical scope components before deriving an IRI', () => {
    expect(() => deriveRfc64CurrentAuthorCatalogRefAddressV1({
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: null,
      authorAddress: AUTHOR.toUpperCase() as EvmAddressV1,
    })).toThrow(/authorAddress/u);
    expect(() => deriveRfc64SubgraphSemanticAddressesV1({
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: 'bad/name' as SubGraphNameV1,
    })).toThrow(/subGraphName/u);
    expect(() => deriveRfc64ContextGraphSemanticAddressesV1({
      networkId: 'otp network' as NetworkIdV1,
      contextGraphId: CONTEXT_GRAPH,
    })).toThrow(/networkId/u);
  });
});
