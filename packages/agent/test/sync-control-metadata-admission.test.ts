import { describe, expect, it } from 'vitest';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { selectVerifiedDurableSyncQuads } from '../src/sync/durable-integrity.js';

const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const CONTEXT_GRAPH_ID = 'sync-control-admission';
const CONTEXT_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}`;
const META_GRAPH = `${CONTEXT_GRAPH}/_meta`;
const UAL = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/41';
const UAL_B = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/42';

function quad(subject: string, predicate: string, object: string, graph = META_GRAPH): Quad {
  return { subject, predicate, object, graph };
}

function integer(value: bigint): string {
  return `"${value}"^^<${XSD_INTEGER}>`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function selectedMeta(data: Quad[], meta: Quad[], acceptUnverified = false): Quad[] {
  const selection = selectVerifiedDurableSyncQuads(data, meta, acceptUnverified);
  return selection.metaIndexes.map((index) => meta[index]!);
}

describe('durable sync control metadata admission', () => {
  it('keeps verified V2 controls and drops orphaned delta controls', () => {
    const scope = createGraphKnowledgeAssetScope(UAL, '1');
    const assertionGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.VerifiableMemory,
      scope,
    );
    const data = [quad('urn:verified:entity', 'urn:example:value', '"verified"', assertionGraph)];
    const verified = generateGraphKnowledgeAssetMetadata({
      ual: UAL,
      contextGraphId: CONTEXT_GRAPH_ID,
      merkleRoot: computeFlatKCRootV10(data, []),
      publisherPeerId: 'verified-publisher',
      accessPolicy: 'public',
      timestamp: new Date(0),
      assertionVersion: '1',
      publicTripleCount: data.length,
      assertionGraph,
    }, 'tentative');
    const authenticatedBatch = quad(UAL, `${DKG}batchId`, integer(41n));
    const poison = 'urn:unverified:delta-control';
    const unverifiedControls = [
      quad(poison, `${DKG}batchId`, integer(999n)),
      quad(poison, `${DKG}assertionGraph`, `${CONTEXT_GRAPH}/_verifiable_memory/attacker/999`),
      quad(poison, `${DKG}assertionVersion`, integer(999n)),
    ];
    const spoofedCompanion = 'urn:unverified:spoofed-companion';
    const spoofedDescriptorLink = [
      quad(spoofedCompanion, `${DKG}contentScopeVersion`, integer(2n)),
      quad(spoofedCompanion, `${DKG}kaUal`, UAL),
    ];
    const spoofedControls = [
      quad(spoofedCompanion, `${DKG}assertionGraph`, `${CONTEXT_GRAPH}/_verifiable_memory/attacker/41`),
      quad(spoofedCompanion, `${DKG}assertionVersion`, integer(999n)),
    ];
    const descriptive = quad(poison, `${DKG}status`, '"descriptive-only"');
    const meta = [
      ...verified,
      authenticatedBatch,
      ...unverifiedControls,
      ...spoofedDescriptorLink,
      ...spoofedControls,
      descriptive,
    ];

    expect(selectedMeta(data, meta)).toEqual([
      ...verified,
      authenticatedBatch,
      ...spoofedDescriptorLink,
      descriptive,
    ]);
  });

  it('authenticates a named-KA lifecycle VM pointer through its reserved UAL', () => {
    const scope = createGraphKnowledgeAssetScope(UAL, '1');
    const assertionGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.VerifiableMemory,
      scope,
    );
    const data = [quad('urn:verified:entity', 'urn:example:value', '"verified"', assertionGraph)];
    const descriptor = generateGraphKnowledgeAssetMetadata({
      ual: UAL,
      contextGraphId: CONTEXT_GRAPH_ID,
      merkleRoot: computeFlatKCRootV10(data, []),
      publisherPeerId: 'verified-publisher',
      accessPolicy: 'public',
      timestamp: new Date(0),
      assertionVersion: '1',
      publicTripleCount: data.length,
      assertionGraph,
    }, 'tentative');
    const lifecycle = `urn:dkg:assertion:${CONTEXT_GRAPH_ID}:0x00000000000000000000000000000000000000AB:asset`;
    const lifecycleRows = [
      quad(lifecycle, `${DKG}contentScopeVersion`, integer(2n)),
      quad(lifecycle, `${DKG}reservedUal`, `"${UAL}"`),
      quad(lifecycle, `${DKG}assertionVersion`, integer(1n)),
      quad(lifecycle, `${DKG}assertionGraph`, assertionGraph),
      quad(lifecycle, `${DKG}state`, '"published"'),
    ];
    const meta = [...descriptor, ...lifecycleRows];

    const selection = selectVerifiedDurableSyncQuads(data, meta, false);

    expect(selection.rejected).toBe(0);
    expect(selection.droppedSyncControlTriples).toBe(0);
    expect(selection.metaIndexes.map((index) => meta[index]!)).toEqual(meta);
  });

  it('rejects lifecycle controls when kaUal and reservedUal identities conflict', () => {
    const scope = createGraphKnowledgeAssetScope(UAL, '1');
    const assertionGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.VerifiableMemory,
      scope,
    );
    const data = [quad('urn:verified:entity', 'urn:example:value', '"verified"', assertionGraph)];
    const descriptor = generateGraphKnowledgeAssetMetadata({
      ual: UAL,
      contextGraphId: CONTEXT_GRAPH_ID,
      merkleRoot: computeFlatKCRootV10(data, []),
      publisherPeerId: 'verified-publisher',
      accessPolicy: 'public',
      timestamp: new Date(0),
      assertionVersion: '1',
      publicTripleCount: data.length,
      assertionGraph,
    }, 'tentative');
    const lifecycle = 'urn:dkg:assertion:conflicting-owner';
    const descriptiveRows = [
      quad(lifecycle, `${DKG}contentScopeVersion`, integer(2n)),
      quad(lifecycle, `${DKG}kaUal`, UAL),
      quad(lifecycle, `${DKG}reservedUal`, `"${UAL_B}"`),
    ];
    const controlRows = [
      quad(lifecycle, `${DKG}assertionVersion`, integer(1n)),
      quad(lifecycle, `${DKG}assertionGraph`, assertionGraph),
    ];
    const meta = [...descriptor, ...descriptiveRows, ...controlRows];

    const selection = selectVerifiedDurableSyncQuads(data, meta, false);

    expect(selection.rejected).toBe(0);
    expect(selection.droppedSyncControlTriples).toBe(2);
    expect(selection.metaIndexes.map((index) => meta[index]!)).toEqual([
      ...descriptor,
      ...descriptiveRows,
    ]);
  });

  it('drops orphaned controls from an otherwise unverified system-graph page', () => {
    const subject = 'urn:system:unverified-control';
    const descriptive = quad(subject, `${DKG}status`, '"keep"');
    const meta = [
      descriptive,
      quad(subject, `${DKG}batchId`, integer(999n)),
      quad(subject, `${DKG}assertionGraph`, 'urn:attacker:graph'),
      quad(subject, `${DKG}assertionVersion`, integer(999n)),
    ];

    const selection = selectVerifiedDurableSyncQuads([], meta, true);
    expect(selection.metaIndexes.map((index) => meta[index]!)).toEqual([descriptive]);
    expect(selection.droppedSyncControlTriples).toBe(3);
  });

  it('does not authenticate out-of-scope system delta controls from descriptor shape alone', () => {
    const scope = createGraphKnowledgeAssetScope(UAL, '1');
    const assertionGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.VerifiableMemory,
      scope,
    );
    const payload = [quad('urn:out-of-scope:entity', 'urn:example:value', '"old"', assertionGraph)];
    const meta = [
      ...generateGraphKnowledgeAssetMetadata({
        ual: UAL,
        contextGraphId: CONTEXT_GRAPH_ID,
        merkleRoot: computeFlatKCRootV10(payload, []),
        publisherPeerId: 'untrusted-system-peer',
        accessPolicy: 'public',
        timestamp: new Date(0),
        assertionVersion: '1',
        publicTripleCount: payload.length,
        assertionGraph,
      }, 'tentative'),
      quad(UAL, `${DKG}batchId`, integer(5n)),
    ];
    const selection = selectVerifiedDurableSyncQuads(
      [],
      meta,
      true,
      { kind: 'sinceBatchId', sinceBatchId: 100n },
    );
    const retained = selection.metaIndexes.map((index) => meta[index]!);

    expect(retained.some(({ predicate }) => predicate === `${DKG}batchId`)).toBe(false);
    expect(retained.some(({ predicate }) => predicate === `${DKG}assertionGraph`)).toBe(false);
    expect(retained.some(({ predicate }) => predicate === `${DKG}assertionVersion`)).toBe(false);
    expect(retained.some(({ predicate }) => predicate === `${DKG}merkleRoot`)).toBe(true);
  });

  it('does not let the system-graph override authenticate malformed legacy controls', () => {
    const subject = 'urn:system:malformed-legacy';
    const merkleRoot = quad(subject, `${DKG}merkleRoot`, `"${'00'.repeat(32)}"`);
    const meta = [
      merkleRoot,
      quad(subject, `${DKG}batchId`, integer(999n)),
    ];

    expect(selectedMeta([], meta, true)).toEqual([merkleRoot]);
  });

  it('preserves batch controls bound to a verified legacy envelope', () => {
    const root = 'urn:legacy:root';
    const child = `${UAL}/1`;
    const data = [quad(root, 'urn:example:value', '"legacy"', CONTEXT_GRAPH)];
    const meta = [
      quad(UAL, `${DKG}merkleRoot`, `"${toHex(computeFlatKCRootV10(data, []))}"`),
      quad(UAL, `${DKG}rootEntity`, root),
      quad(UAL, `${DKG}batchId`, integer(41n)),
      quad(child, `${DKG}partOf`, UAL),
      quad(child, `${DKG}batchId`, integer(41n)),
    ];

    expect(selectedMeta(data, meta)).toEqual(meta);
  });

  it('preserves controls for overlapping legacy envelopes sharing one root', () => {
    const root = 'urn:legacy:shared-root';
    const data = [quad(root, 'urn:example:value', '"shared"', CONTEXT_GRAPH)];
    const merkleRoot = `"${toHex(computeFlatKCRootV10(data, []))}"`;
    const meta = [
      quad(UAL, `${DKG}merkleRoot`, merkleRoot),
      quad(UAL, `${DKG}rootEntity`, root),
      quad(UAL, `${DKG}batchId`, integer(41n)),
      quad(UAL_B, `${DKG}merkleRoot`, merkleRoot),
      quad(UAL_B, `${DKG}rootEntity`, root),
      quad(UAL_B, `${DKG}batchId`, integer(42n)),
    ];

    expect(selectedMeta(data, meta)).toEqual(meta);
  });
});
