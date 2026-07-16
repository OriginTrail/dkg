import { describe, it, expect } from 'vitest';
import {
  buildContextGraphDeclarationsSparql,
  contextGraphIdsFromDeclarationBindings,
  contextGraphIdsFromLocalRootMetaGraphs,
  contextGraphIdsFromMetricSubscriptionCandidates,
  contextGraphIdFromGraphUriForMetrics,
  countContextGraphsFromGraphUris,
  parseRdfInt,
  shadowContextGraphIdsFromMetricSubscriptionCandidates,
} from '../src/daemon/metrics-queries.js';

// Guards the shared COUNT parser the daemon's metric getters depend on. The
// getters themselves are intentionally uncached (metricsSource is consumed only
// by the 30s MetricsCollector tick, so each snapshot re-reads the store fresh).
describe('parseRdfInt', () => {
  it('parses RDF typed-integer literals and bare numbers, defaulting to 0', () => {
    expect(parseRdfInt('"1000"^^<http://www.w3.org/2001/XMLSchema#integer>')).toBe(1000);
    expect(parseRdfInt('42')).toBe(42);
    expect(parseRdfInt(undefined)).toBe(0);
    expect(parseRdfInt('not-a-number')).toBe(0);
  });
});

describe('countContextGraphsFromGraphUris', () => {
  it('counts bare context graphs once across reserved layer graphs', () => {
    expect(countContextGraphsFromGraphUris([
      'did:dkg:context-graph:project',
      'did:dkg:context-graph:project/_meta',
      'did:dkg:context-graph:project/_private',
      'did:dkg:context-graph:project/_shared_memory',
      'did:dkg:context-graph:project/_shared_memory_meta',
      'did:dkg:context-graph:project/_verifiable_memory/1',
      'did:dkg:context-graph:project/context/1/_meta',
      'did:dkg:context-graph:project/code',
      'did:dkg:context-graph:project/code/_shared_memory',
    ])).toBe(1);
  });

  it('keeps known slash-bearing context graph ids without counting subgraphs', () => {
    const walletScoped = '0xE5B8896800000000000000000000000000000000/tuesday-cg';
    const nestedSlashId = `${walletScoped}/phase-two`;
    const reservedSegmentId = 'team/context/alpha';
    const knownContextGraphs = [walletScoped, nestedSlashId, reservedSegmentId, 'project'];

    expect(contextGraphIdFromGraphUriForMetrics(
      `did:dkg:context-graph:${walletScoped}/_meta`,
      knownContextGraphs,
    ))
      .toBe(walletScoped);
    expect(contextGraphIdFromGraphUriForMetrics(
      `did:dkg:context-graph:${nestedSlashId}/_meta`,
      knownContextGraphs,
    ))
      .toBe(nestedSlashId);
    expect(contextGraphIdFromGraphUriForMetrics(
      `did:dkg:context-graph:${reservedSegmentId}/_meta`,
      knownContextGraphs,
    ))
      .toBe(reservedSegmentId);
    expect(contextGraphIdFromGraphUriForMetrics(
      `did:dkg:context-graph:${nestedSlashId}/_meta`,
    ))
      .toBeNull();
    expect(contextGraphIdFromGraphUriForMetrics(
      `did:dkg:context-graph:${reservedSegmentId}/_meta`,
    ))
      .toBeNull();
    expect(contextGraphIdFromGraphUriForMetrics(
      `did:dkg:context-graph:${walletScoped}/_meta`,
    ))
      .toBeNull();
    expect(countContextGraphsFromGraphUris([
      `did:dkg:context-graph:${walletScoped}/_meta`,
      `did:dkg:context-graph:${walletScoped}/child/_meta`,
    ], [walletScoped])).toBe(1);
    expect(countContextGraphsFromGraphUris([
      `did:dkg:context-graph:${walletScoped}`,
      `did:dkg:context-graph:${walletScoped}/_meta`,
      `did:dkg:context-graph:${walletScoped}/assertion/0x0000000000000000000000000000000000000001/draft`,
      `did:dkg:context-graph:${nestedSlashId}`,
      `did:dkg:context-graph:${nestedSlashId}/_meta`,
      `did:dkg:context-graph:${reservedSegmentId}`,
      `did:dkg:context-graph:${reservedSegmentId}/_meta`,
      'did:dkg:context-graph:project/code',
      'did:dkg:context-graph:project/code/_shared_memory',
      'did:dkg:context-graph:project',
      'urn:not-a-context-graph',
    ], knownContextGraphs)).toBe(4);
  });

  it('counts known context graphs that do not have a local graph yet', () => {
    expect(countContextGraphsFromGraphUris([
      'did:dkg:context-graph:project/_meta',
      'did:dkg:context-graph:project/_shared_memory',
    ], ['project', 'joined-before-first-sync'])).toBe(2);
  });

  it('does not count system context graphs as user context graphs', () => {
    expect(countContextGraphsFromGraphUris([
      'did:dkg:context-graph:agents',
      'did:dkg:context-graph:agents/_meta',
      'did:dkg:context-graph:ontology',
      'did:dkg:context-graph:ontology/_meta',
      'did:dkg:context-graph:project/_meta',
    ], ['agents', 'ontology', 'project'])).toBe(1);
  });

  it('uses declaration metadata to count backed slash-bearing context graphs', () => {
    const declared = contextGraphIdsFromDeclarationBindings([
      { ctxGraph: 'did:dkg:context-graph:team/context/alpha' },
      { ctxGraph: 'did:dkg:context-graph:agents' },
      { ctxGraph: 'urn:not-a-context-graph' },
    ]);

    expect(countContextGraphsFromGraphUris([
      'did:dkg:context-graph:team/context/alpha/_meta',
      'did:dkg:context-graph:team/context/alpha/_private',
      'did:dkg:context-graph:agents/_shared_memory',
    ], declared)).toBe(1);
  });

  it('includes private context graphs when they are backed by known local state', () => {
    expect(countContextGraphsFromGraphUris([
      'did:dkg:context-graph:curated-private/_meta',
      'did:dkg:context-graph:curated-private/_private',
      'did:dkg:context-graph:curated-private/_shared_memory',
    ], ['curated-private'])).toBe(1);
  });

  it('does not collapse suffix-matching ids without proven shared identity', () => {
    const walletScoped = '0xE5B8896800000000000000000000000000000000/tuesday-cg';
    expect(countContextGraphsFromGraphUris([
      'did:dkg:context-graph:tuesday-cg/_meta',
      `did:dkg:context-graph:${walletScoped}/_meta`,
    ], ['tuesday-cg', walletScoped])).toBe(2);
  });

  it('skips graph-derived ids that are proven subscription shadows', () => {
    const hashKey = `0x${'a'.repeat(64)}`;
    expect(countContextGraphsFromGraphUris([
      `did:dkg:context-graph:${hashKey}/_meta`,
      'did:dkg:context-graph:cleartext-cg/_meta',
    ], ['cleartext-cg'], [hashKey])).toBe(1);
  });

  it('uses exact local root meta graphs to back subscribed slash ids', () => {
    expect(contextGraphIdsFromLocalRootMetaGraphs([
      'did:dkg:context-graph:team/context/alpha/_meta',
      'did:dkg:context-graph:team/context/beta/_meta',
      'did:dkg:context-graph:project/code/_meta',
    ], ['team/context/alpha', 'missing/slash', 'agents'])).toEqual(['team/context/alpha']);
  });

  it('excludes phantom subscription keys from metric candidates', () => {
    expect(contextGraphIdsFromMetricSubscriptionCandidates([
      ['phantom', { synced: false }],
      ['chain-backed', { onChainId: '42' }],
      ['pending-meta', { pendingMeta: true }],
      ['local-sync/slash-id', { metaSynced: true }],
      ['core-hosted', { coreHosted: true }],
    ])).toEqual(['chain-backed', 'pending-meta', 'local-sync/slash-id', 'core-hosted']);
  });

  it('dedupes subscription candidates by stable chain or wire identity', () => {
    const hashKey = `0x${'a'.repeat(64)}`;
    const wireOnlyHash = `0x${'b'.repeat(64)}`;
    const walletScoped = '0xE5B8896800000000000000000000000000000000/tuesday-cg';
    const reusedSlotHash = `0x${'d'.repeat(64)}`;
    const sharedIdentityHash = `0x${'f'.repeat(64)}`;
    expect(contextGraphIdsFromMetricSubscriptionCandidates([
      [hashKey, { onChainId: '7', onChainHash: hashKey, coreHosted: true }],
      ['cleartext-cg', { onChainId: '7', onChainHash: hashKey, synced: true }],
      [wireOnlyHash, { onChainHash: wireOnlyHash, coreHosted: true }],
      ['wire-only-clear', { onChainHash: wireOnlyHash, synced: true }],
      ['tuesday-cg', { onChainId: '9', onChainHash: `0x${'c'.repeat(64)}`, synced: true }],
      [walletScoped, { onChainId: '9', onChainHash: `0x${'c'.repeat(64)}`, synced: true }],
      ['reused-slot-old', { onChainId: '11', onChainHash: reusedSlotHash, synced: true }],
      ['reused-slot-new', { onChainId: '11', onChainHash: `0x${'e'.repeat(64)}`, synced: true }],
      ['13', { onChainId: '13', synced: true }],
      ['bare-wallet-cg', { onChainId: '13', onChainHash: sharedIdentityHash, synced: true }],
      ['0xE5B8896800000000000000000000000000000000/bare-wallet-cg', {
        onChainId: '13',
        onChainHash: sharedIdentityHash,
        synced: true,
      }],
    ])).toEqual([
      'cleartext-cg',
      'wire-only-clear',
      walletScoped,
      'reused-slot-old',
      'reused-slot-new',
      '0xE5B8896800000000000000000000000000000000/bare-wallet-cg',
    ]);
    expect(shadowContextGraphIdsFromMetricSubscriptionCandidates([
      ['tuesday-cg', { onChainId: '9', onChainHash: `0x${'c'.repeat(64)}`, synced: true }],
      [walletScoped, { onChainId: '9', onChainHash: `0x${'c'.repeat(64)}`, synced: true }],
    ])).toEqual(['tuesday-cg']);
    expect(shadowContextGraphIdsFromMetricSubscriptionCandidates([
      ['13', { onChainId: '13', synced: true }],
      ['bare-wallet-cg', { onChainId: '13', onChainHash: sharedIdentityHash, synced: true }],
      ['0xE5B8896800000000000000000000000000000000/bare-wallet-cg', {
        onChainId: '13',
        onChainHash: sharedIdentityHash,
        synced: true,
      }],
    ])).toEqual(['bare-wallet-cg', '13']);
  });

  it('builds declaration queries from known declaration graphs only', () => {
    const query = buildContextGraphDeclarationsSparql([
      'did:dkg:context-graph:team/context/alpha/_meta',
      'did:dkg:context-graph:team/context/beta/_meta',
      'did:dkg:context-graph:plain-cg/code/_meta',
      'did:dkg:context-graph:plain-cg/_verifiable_memory/1/_meta',
      'did:dkg:context-graph:agents/_shared_memory',
      'did:dkg:context-graph:plain-cg',
      'did:dkg:context-graph:plain-cg/_meta',
    ], ['team/context/alpha']);

    expect(query).toContain('VALUES ?g');
    expect(query).toContain('STR(?g) = CONCAT(STR(?ctxGraph), "/_meta")');
    expect(query).toContain('<did:dkg:context-graph:team/context/alpha/_meta>');
    expect(query).toContain('<did:dkg:context-graph:ontology>');
    expect(query).toContain('<did:dkg:context-graph:agents>');
    expect(query).not.toContain('<did:dkg:context-graph:plain-cg/_meta>');
    expect(query).not.toContain('<did:dkg:context-graph:team/context/beta/_meta>');
    expect(query).not.toContain('<did:dkg:context-graph:plain-cg/code/_meta>');
    expect(query).not.toContain('<did:dkg:context-graph:plain-cg/_verifiable_memory/1/_meta>');
    expect(query).not.toContain('<did:dkg:context-graph:plain-cg>');
    expect(query).not.toContain('<did:dkg:context-graph:agents/_shared_memory>');
  });

  it('does not add foreign curated metadata graphs to the declaration query', () => {
    const query = buildContextGraphDeclarationsSparql([
      'did:dkg:context-graph:joined/slash-cg/_meta',
      'did:dkg:context-graph:foreign/slash-cg/_meta',
      'did:dkg:context-graph:foreign-plain/_meta',
    ], ['joined/slash-cg']);

    expect(query).toContain('<did:dkg:context-graph:joined/slash-cg/_meta>');
    expect(query).not.toContain('<did:dkg:context-graph:foreign/slash-cg/_meta>');
    expect(query).not.toContain('<did:dkg:context-graph:foreign-plain/_meta>');
  });
});
