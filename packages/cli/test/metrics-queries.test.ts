import { describe, it, expect } from 'vitest';
import {
  contextGraphIdFromGraphUriForMetrics,
  countContextGraphsFromGraphUris,
  parseRdfInt,
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
      'did:dkg:context-graph:agents',
      'did:dkg:context-graph:agents/_meta',
      'did:dkg:context-graph:agents/_private',
      'did:dkg:context-graph:agents/_shared_memory',
      'did:dkg:context-graph:agents/_shared_memory_meta',
      'did:dkg:context-graph:agents/_verifiable_memory/1',
      'did:dkg:context-graph:agents/context/1/_meta',
      'did:dkg:context-graph:agents/code',
      'did:dkg:context-graph:agents/code/_shared_memory',
    ])).toBe(1);
  });

  it('keeps known slash-bearing context graph ids without counting subgraphs', () => {
    const walletScoped = '0xE5B8896800000000000000000000000000000000/tuesday-cg';
    const nestedSlashId = `${walletScoped}/phase-two`;
    const reservedSegmentId = 'team/context/alpha';
    const knownContextGraphs = [walletScoped, nestedSlashId, reservedSegmentId, 'agents'];

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
    expect(countContextGraphsFromGraphUris([
      `did:dkg:context-graph:${walletScoped}`,
      `did:dkg:context-graph:${walletScoped}/_meta`,
      `did:dkg:context-graph:${walletScoped}/assertion/0x0000000000000000000000000000000000000001/draft`,
      `did:dkg:context-graph:${nestedSlashId}`,
      `did:dkg:context-graph:${nestedSlashId}/_meta`,
      `did:dkg:context-graph:${reservedSegmentId}`,
      `did:dkg:context-graph:${reservedSegmentId}/_meta`,
      'did:dkg:context-graph:agents/code',
      'did:dkg:context-graph:agents/code/_shared_memory',
      'did:dkg:context-graph:agents',
      'urn:not-a-context-graph',
    ], knownContextGraphs)).toBe(4);
  });
});
