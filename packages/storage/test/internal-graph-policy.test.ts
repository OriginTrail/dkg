import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SYSTEM_RECORD_KIND_V1 } from '@origintrail-official/dkg-core/system-record-v1';

import { ATOMIC_GRAPH_REPLACE_STAGING_PREFIX } from '../src/atomic-graph-replace.js';
import {
  RESERVED_INTERNAL_GRAPHS_V1,
  ReservedInternalGraphWriteError,
  SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH,
  SYSTEM_RECORD_V1_STATE_GRAPH,
  assertNotReservedInternalGraphV1,
  excludeInternalGraphsV1,
  isEphemeralInternalStagingGraphUriV1,
  isInternalGraphUriV1,
  isReservedInternalGraphUriV1,
} from '../src/internal-graph-policy.js';

const stagingGraph = (): string => `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}${randomUUID()}`;

describe('internal graph policy V1', () => {
  it('keeps the reserved names inside the predecessor-hidden prefix', () => {
    // The downgrade property: an older binary hides these with its existing
    // prefix filter and therefore neither enumerates nor serves them.
    for (const graph of RESERVED_INTERNAL_GRAPHS_V1) {
      expect(graph.startsWith(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX)).toBe(true);
      expect(isInternalGraphUriV1(graph)).toBe(true);
    }
  });

  it('binds the shadow graph name to the frozen protocol kind', () => {
    // Guards against the literal drifting from the B1 constant while this
    // module stays dependency-free at runtime.
    expect(SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH).toBe(
      `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}system-record-v1:shadow:${SYSTEM_RECORD_KIND_V1}`,
    );
    expect(SYSTEM_RECORD_V1_STATE_GRAPH).toBe(
      `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}system-record-v1:state`,
    );
  });

  it('partitions persistent reserved state from ephemeral staging graphs', () => {
    const ephemeral = stagingGraph();

    expect(isReservedInternalGraphUriV1(SYSTEM_RECORD_V1_STATE_GRAPH)).toBe(true);
    expect(isReservedInternalGraphUriV1(SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH)).toBe(true);
    expect(isReservedInternalGraphUriV1(ephemeral)).toBe(false);

    // The load-bearing direction: a staging sweep must never classify durable
    // state as garbage.
    expect(isEphemeralInternalStagingGraphUriV1(SYSTEM_RECORD_V1_STATE_GRAPH)).toBe(false);
    expect(isEphemeralInternalStagingGraphUriV1(SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH)).toBe(false);
    expect(isEphemeralInternalStagingGraphUriV1(ephemeral)).toBe(true);
  });

  it('reserves by exact name so a near-miss cannot be matched into existence', () => {
    for (const nearMiss of [
      `${SYSTEM_RECORD_V1_STATE_GRAPH}-evil`,
      `${SYSTEM_RECORD_V1_STATE_GRAPH}/child`,
      `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}system-record-v1:state2`,
      `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}system-record-v1:shadow:ontology`,
      `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}system-record-v1:`,
    ]) {
      expect(isReservedInternalGraphUriV1(nearMiss)).toBe(false);
      // ...but still hidden, so an unrecognised internal name never leaks.
      expect(isInternalGraphUriV1(nearMiss)).toBe(true);
      // ...and still not sweepable, because it is not a canonical UUID.
      expect(isEphemeralInternalStagingGraphUriV1(nearMiss)).toBe(false);
    }
  });

  it('rejects a non-canonical UUID suffix as ephemeral', () => {
    for (const suffix of [
      'ABCDEF01-2345-6789-ABCD-EF0123456789', // uppercase
      '0123456789ab-cdef-0123-4567-89abcdef', // wrong grouping
      `${randomUUID()}x`,
      `${randomUUID()}:state`,
      '',
    ]) {
      expect(
        isEphemeralInternalStagingGraphUriV1(`${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}${suffix}`),
      ).toBe(false);
    }
  });

  it('treats a graph outside the internal prefix as ordinary', () => {
    for (const graph of [
      'did:dkg:context-graph:example',
      'urn:dkg:changelog',
      'urn:dkg:internal:something-else:state',
      '',
    ]) {
      expect(isInternalGraphUriV1(graph)).toBe(false);
      expect(isReservedInternalGraphUriV1(graph)).toBe(false);
      expect(isEphemeralInternalStagingGraphUriV1(graph)).toBe(false);
    }
  });

  it('fails a generic mutation closed on reserved state and stays silent elsewhere', () => {
    expect(() =>
      assertNotReservedInternalGraphV1(SYSTEM_RECORD_V1_STATE_GRAPH, 'dropGraph', 'TestStore'),
    ).toThrow(ReservedInternalGraphWriteError);

    try {
      assertNotReservedInternalGraphV1(
        SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH,
        'replaceGraph',
        'TestStore',
      );
      expect.unreachable('reserved shadow graph must refuse a generic replace');
    } catch (error) {
      expect(error).toBeInstanceOf(ReservedInternalGraphWriteError);
      const refusal = error as ReservedInternalGraphWriteError;
      expect(refusal.code).toBe('RESERVED_INTERNAL_GRAPH_WRITE');
      expect(refusal.name).toBe('ReservedInternalGraphWriteError');
      expect(refusal.graphUri).toBe(SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH);
      expect(refusal.operation).toBe('replaceGraph');
      expect(refusal.storeName).toBe('TestStore');
    }

    // An ephemeral staging graph IS writable — the atomic-replace builders drop
    // their own staging names on the failure path and must keep working.
    expect(() =>
      assertNotReservedInternalGraphV1(stagingGraph(), 'dropGraph', 'TestStore'),
    ).not.toThrow();
    expect(() =>
      assertNotReservedInternalGraphV1('did:dkg:context-graph:x', 'dropGraph', 'TestStore'),
    ).not.toThrow();
  });

  it('hides every internal graph from an enumeration result', () => {
    const ephemeral = stagingGraph();
    expect(
      excludeInternalGraphsV1([
        'did:dkg:context-graph:a',
        SYSTEM_RECORD_V1_STATE_GRAPH,
        ephemeral,
        SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH,
        `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}system-record-v1:unknown-future`,
        undefined,
        null,
        '',
        'did:dkg:context-graph:b',
      ]),
    ).toEqual(['did:dkg:context-graph:a', 'did:dkg:context-graph:b']);
  });
});
