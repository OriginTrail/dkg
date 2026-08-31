import { describe, expect, it } from 'vitest';

import {
  MAX_RFC64_PENDING_TARGET_DIGESTS_V1,
  MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1,
  RFC64_DIGEST_LIST_DATATYPE_IRI_V1,
  RFC64_SEMANTIC_NULL_IRI_V1,
  RFC64_SEMANTIC_PREDICATES_V1,
  Rfc64SemanticRecordErrorV1,
  decodeRfc64SemanticRecordStoreRowsV1,
  parseRenderedRdfStoreObjectV1,
  projectRfc64SemanticRecordStoreRowsV1,
  renderRfc64SemanticStoreRowV1,
  snapshotRfc64SemanticRecordV1,
  typedRdfStoreRowByteLengthV1,
  type ChainIdV1,
  type ContextGraphIdV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type Rfc64SemanticRecordCoordinateV1,
  type Rfc64SemanticRecordV1,
  type SubGraphNameV1,
} from '../src/index.js';

const NETWORK = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH = (
  '0x0123456789abcdef0123456789abcdef01234567/14'
) as ContextGraphIdV1;
const AUTHOR = '0x89abcdef0123456789abcdef0123456789abcdef' as EvmAddressV1;
const GOVERNANCE = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const CHAIN = '20430' as ChainIdV1;
const SUBGRAPH = 'research' as SubGraphNameV1;
const APPLIED_AT = '2026-08-29T10:00:00.123Z' as const;
const D = (byte: string): Digest32V1 => `0x${byte.repeat(64)}` as Digest32V1;
const U = (value: string): DecimalU64V1 => value as DecimalU64V1;

const records: readonly Rfc64SemanticRecordV1[] = [
  {
    recordType: 'CurrentAuthorCatalogRefV1',
    value: {
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      governanceChainId: CHAIN,
      governanceContractAddress: GOVERNANCE,
      ownershipTransitionDigest: D('1'),
      subGraphName: SUBGRAPH,
      authorAddress: AUTHOR,
      catalogEra: U('2'),
      catalogVersion: U('7'),
      catalogHeadDigest: D('a'),
    },
  },
  {
    recordType: 'AppliedSubgraphSealV1',
    value: {
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
      checkpointEra: U('3'),
      checkpointVersion: U('9'),
      checkpointDigest: D('b'),
      mutationGeneration: U('11'),
      appliedAt: APPLIED_AT,
    },
  },
  {
    recordType: 'SubgraphMutationGuardV1',
    value: {
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
      generation: U('12'),
    },
  },
  {
    recordType: 'ContextGraphMutationGuardV1',
    value: {
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      generation: U('13'),
    },
  },
  {
    recordType: 'SubgraphReconcileTargetGuardV1',
    value: {
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
      generation: U('14'),
      baselineSubgraphCheckpointDigest: null,
      activeTargetSubgraphCheckpointDigest: D('d'),
      pendingTargetCheckpointDigests: [D('c'), D('d')],
    },
  },
  {
    recordType: 'AppliedSubgraphSetRefV1',
    value: {
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      generation: U('15'),
      subgraphIndexEra: U('4'),
      subgraphIndexVersion: U('10'),
      subgraphCount: U('6'),
      appliedDirectoryRootDigest: D('e'),
    },
  },
  {
    recordType: 'AppliedContextGraphSealV1',
    value: {
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      checkpointEra: U('5'),
      checkpointVersion: U('12'),
      checkpointDigest: D('f'),
      policyDigest: D('2'),
      chainCoverageDigest: D('3'),
      mutationGeneration: U('16'),
      appliedAt: APPLIED_AT,
    },
  },
];

describe('RFC-64 semantic record RDF codec v1', () => {
  it('owns the inverse rendered RDF object boundary in core', () => {
    expect(parseRenderedRdfStoreObjectV1('urn:test:node')).toEqual({
      kind: 'named-node',
      value: 'urn:test:node',
    });
    expect(parseRenderedRdfStoreObjectV1('<urn:test:node>')).toEqual({
      kind: 'named-node',
      value: 'urn:test:node',
    });
    expect(parseRenderedRdfStoreObjectV1('"plain"')).toEqual({
      kind: 'literal',
      value: 'plain',
      datatypeIri: 'http://www.w3.org/2001/XMLSchema#string',
    });
    expect(parseRenderedRdfStoreObjectV1('"7"^^<http://www.w3.org/2001/XMLSchema#integer>'))
      .toEqual({
        kind: 'literal',
        value: '7',
        datatypeIri: 'http://www.w3.org/2001/XMLSchema#integer',
      });
    expect(() => parseRenderedRdfStoreObjectV1('"bonjour"@fr')).toThrow(/language tag/u);
  });
  it('round-trips all seven records independent of backend row order', () => {
    for (const record of records) {
      const rows = projectRfc64SemanticRecordStoreRowsV1(record);
      const decoded = decodeRfc64SemanticRecordStoreRowsV1(
        [...rows].reverse(),
        coordinateFor(record),
      );
      expect(decoded.record, record.recordType).toEqual(record);
      expect(decoded.rows, record.recordType).toEqual(rows);
      expect(new Set(rows.map((row) => row.predicateIri)).size).toBe(rows.length);
    }
  });

  it('freezes the exact ordered current-author predicate and object vector', () => {
    const record = records[0];
    const rendered = projectRfc64SemanticRecordStoreRowsV1(record)
      .map(renderRfc64SemanticStoreRowV1);
    expect(rendered.map(({ predicate }) => predicate)).toEqual([
      RFC64_SEMANTIC_PREDICATES_V1.NETWORK_ID,
      RFC64_SEMANTIC_PREDICATES_V1.CONTEXT_GRAPH_ID,
      RFC64_SEMANTIC_PREDICATES_V1.GOVERNANCE_CHAIN_ID,
      RFC64_SEMANTIC_PREDICATES_V1.GOVERNANCE_CONTRACT_ADDRESS,
      RFC64_SEMANTIC_PREDICATES_V1.OWNERSHIP_TRANSITION_DIGEST,
      RFC64_SEMANTIC_PREDICATES_V1.SUBGRAPH_NAME,
      RFC64_SEMANTIC_PREDICATES_V1.AUTHOR_ADDRESS,
      RFC64_SEMANTIC_PREDICATES_V1.CATALOG_ERA,
      RFC64_SEMANTIC_PREDICATES_V1.CATALOG_VERSION,
      RFC64_SEMANTIC_PREDICATES_V1.CATALOG_HEAD_DIGEST,
    ]);
    expect(rendered.map(({ object }) => object)).toEqual([
      '"otp:20430"',
      `"${CONTEXT_GRAPH}"`,
      '"20430"^^<http://www.w3.org/2001/XMLSchema#integer>',
      `"${GOVERNANCE}"`,
      `"${'1'.repeat(64)}"^^<http://www.w3.org/2001/XMLSchema#hexBinary>`,
      '"research"',
      `"${AUTHOR}"`,
      '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
      '"7"^^<http://www.w3.org/2001/XMLSchema#integer>',
      `"${'a'.repeat(64)}"^^<http://www.w3.org/2001/XMLSchema#hexBinary>`,
    ]);
    expect(new Set(rendered.map(({ subject }) => subject))).toEqual(new Set([
      'urn:dkg:sync:catalog:otp%3A20430:'
      + '0x0123456789abcdef0123456789abcdef01234567%2F14:'
      + '0x8e38ab4dfb3e25028a2c1863a0d246817222e60842f7bebe997bc5d60bbcf66e:'
      + AUTHOR,
    ]));
    expect(new Set(rendered.map(({ graph }) => graph))).toEqual(new Set([
      `did:dkg:context-graph:${CONTEXT_GRAPH}/_sync/catalog/`
      + '0x8e38ab4dfb3e25028a2c1863a0d246817222e60842f7bebe997bc5d60bbcf66e/'
      + `${AUTHOR}/current`,
    ]));
  });

  it('pins independent RDF goldens for the other six record contracts', () => {
    const encodedNetwork = 'otp%3A20430';
    const encodedContextGraph = '0x0123456789abcdef0123456789abcdef01234567%2F14';
    const contextGraphIri = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
    const subgraphKey = '0x8e38ab4dfb3e25028a2c1863a0d246817222e60842f7bebe997bc5d60bbcf66e';
    const xsd = 'http://www.w3.org/2001/XMLSchema#';
    const dkg = 'http://dkg.io/ontology/';
    const string = (value: string) => JSON.stringify(value);
    const integer = (value: string) => `${JSON.stringify(value)}^^<${xsd}integer>`;
    const digest = (byte: string) => `${JSON.stringify(byte.repeat(64))}^^<${xsd}hexBinary>`;
    const dateTime = (value: string) => `${JSON.stringify(value)}^^<${xsd}dateTime>`;
    const golden = (
      record: Rfc64SemanticRecordV1,
      route: string,
      suffix: string,
      rows: readonly (readonly [string, string])[],
    ) => {
      const subject = `urn:dkg:sync:${route}:${encodedNetwork}:${encodedContextGraph}${suffix}`;
      const graph = `${contextGraphIri}/_sync/${route}${suffix.replaceAll(':', '/')}`;
      expect(projectRfc64SemanticRecordStoreRowsV1(record).map(renderRfc64SemanticStoreRowV1))
        .toEqual(rows.map(([predicate, object]) => ({ subject, predicate, object, graph })));
    };

    golden(records[1], 'applied', `:${subgraphKey}`, [
      [`${dkg}networkId`, string('otp:20430')],
      [`${dkg}contextGraphId`, string(CONTEXT_GRAPH)],
      [`${dkg}subGraphName`, string('research')],
      [`${dkg}checkpointEra`, integer('3')],
      [`${dkg}checkpointVersion`, integer('9')],
      [`${dkg}checkpointDigest`, digest('b')],
      [`${dkg}mutationGeneration`, integer('11')],
      [`${dkg}appliedAt`, dateTime(APPLIED_AT)],
    ]);
    golden(records[2], 'mutation', `:${subgraphKey}`, [
      [`${dkg}networkId`, string('otp:20430')],
      [`${dkg}contextGraphId`, string(CONTEXT_GRAPH)],
      [`${dkg}subGraphName`, string('research')],
      [`${dkg}generation`, integer('12')],
    ]);
    golden(records[3], 'mutation-cg', '', [
      [`${dkg}networkId`, string('otp:20430')],
      [`${dkg}contextGraphId`, string(CONTEXT_GRAPH)],
      [`${dkg}generation`, integer('13')],
    ]);
    const pendingLexical = `["${D('c')}","${D('d')}"]`;
    golden(records[4], 'reconcile-target', `:${subgraphKey}`, [
      [`${dkg}networkId`, string('otp:20430')],
      [`${dkg}contextGraphId`, string(CONTEXT_GRAPH)],
      [`${dkg}subGraphName`, string('research')],
      [`${dkg}generation`, integer('14')],
      [`${dkg}baselineSubgraphCheckpointDigest`, '<urn:dkg:sync:null>'],
      [`${dkg}activeTargetSubgraphCheckpointDigest`, digest('d')],
      [
        `${dkg}pendingTargetCheckpointDigests`,
        `${JSON.stringify(pendingLexical)}^^<http://dkg.io/ontology/digestListV1>`,
      ],
    ]);
    golden(records[5], 'applied-set', '', [
      [`${dkg}networkId`, string('otp:20430')],
      [`${dkg}contextGraphId`, string(CONTEXT_GRAPH)],
      [`${dkg}generation`, integer('15')],
      [`${dkg}subgraphIndexEra`, integer('4')],
      [`${dkg}subgraphIndexVersion`, integer('10')],
      [`${dkg}subgraphCount`, integer('6')],
      [`${dkg}appliedDirectoryRootDigest`, digest('e')],
    ]);
    golden(records[6], 'applied-cg', '', [
      [`${dkg}networkId`, string('otp:20430')],
      [`${dkg}contextGraphId`, string(CONTEXT_GRAPH)],
      [`${dkg}checkpointEra`, integer('5')],
      [`${dkg}checkpointVersion`, integer('12')],
      [`${dkg}checkpointDigest`, digest('f')],
      [`${dkg}policyDigest`, digest('2')],
      [`${dkg}chainCoverageDigest`, digest('3')],
      [`${dkg}mutationGeneration`, integer('16')],
      [`${dkg}appliedAt`, dateTime(APPLIED_AT)],
    ]);
  });

  it('uses one explicit named-node sentinel for every null branch', () => {
    const root = {
      recordType: 'CurrentAuthorCatalogRefV1',
      value: {
        ...records[0].value,
        governanceChainId: null,
        governanceContractAddress: null,
        ownershipTransitionDigest: null,
        subGraphName: null,
      },
    } as Rfc64SemanticRecordV1;
    const rows = projectRfc64SemanticRecordStoreRowsV1(root);
    for (const predicate of [
      RFC64_SEMANTIC_PREDICATES_V1.GOVERNANCE_CHAIN_ID,
      RFC64_SEMANTIC_PREDICATES_V1.GOVERNANCE_CONTRACT_ADDRESS,
      RFC64_SEMANTIC_PREDICATES_V1.OWNERSHIP_TRANSITION_DIGEST,
      RFC64_SEMANTIC_PREDICATES_V1.SUBGRAPH_NAME,
    ]) {
      expect(rows.find((row) => row.predicateIri === predicate)?.object).toEqual({
        kind: 'named-node',
        value: RFC64_SEMANTIC_NULL_IRI_V1,
      });
    }
    expect(decodeRfc64SemanticRecordStoreRowsV1(rows, coordinateFor(root)).record).toEqual(root);
  });

  it('encodes the ordered pending target history as one canonical typed JCS literal', () => {
    const record = records[4];
    const row = projectRfc64SemanticRecordStoreRowsV1(record).find(
      (candidate) => candidate.predicateIri
        === RFC64_SEMANTIC_PREDICATES_V1.PENDING_TARGET_CHECKPOINT_DIGESTS,
    );
    expect(row?.object).toEqual({
      kind: 'literal',
      value: `["${D('c')}","${D('d')}"]`,
      datatypeIri: RFC64_DIGEST_LIST_DATATYPE_IRI_V1,
    });
  });

  it('preserves an NFC Unicode named subgraph in the row while deriving its hashed address', () => {
    const record = {
      recordType: 'SubgraphMutationGuardV1',
      value: {
        ...records[2].value,
        subGraphName: 'é' as SubGraphNameV1,
      },
    } as Rfc64SemanticRecordV1;
    const rows = projectRfc64SemanticRecordStoreRowsV1(record);
    expect(rows.find((row) => row.predicateIri === RFC64_SEMANTIC_PREDICATES_V1.SUBGRAPH_NAME)
      ?.object).toEqual({
      kind: 'literal',
      value: 'é',
      datatypeIri: 'http://www.w3.org/2001/XMLSchema#string',
    });
    expect(rows[0].graphIri).toContain(
      '0x8a7068aa6fcfe381b4d665af280edc5bee02bf16ba7140dd8c6cd75f7cbdc2bb',
    );
    expect(decodeRfc64SemanticRecordStoreRowsV1(rows, coordinateFor(record)).record)
      .toEqual(record);
  });

  it('rejects missing, duplicate, and unknown predicates', () => {
    const record = records[1];
    const rows = [...projectRfc64SemanticRecordStoreRowsV1(record)];
    expect(() => decodeRfc64SemanticRecordStoreRowsV1(
      rows.slice(1),
      coordinateFor(record),
    )).toThrow(/exactly 8 rows/u);

    const duplicate = [...rows];
    duplicate[duplicate.length - 1] = duplicate[0];
    expect(() => decodeRfc64SemanticRecordStoreRowsV1(
      duplicate,
      coordinateFor(record),
    )).toThrow(/duplicate semantic record predicate/u);

    const unknown = [...rows];
    unknown[0] = { ...unknown[0], predicateIri: 'urn:test:unknown' };
    expect(() => decodeRfc64SemanticRecordStoreRowsV1(
      unknown,
      coordinateFor(record),
    )).toThrow(/unknown semantic record predicate/u);
  });

  it('rejects a caller-selected graph or subject before materializing the record', () => {
    const record = records[2];
    const rows = [...projectRfc64SemanticRecordStoreRowsV1(record)];
    rows[0] = { ...rows[0], graphIri: 'urn:test:wrong-graph' };
    expect(() => decodeRfc64SemanticRecordStoreRowsV1(rows, coordinateFor(record)))
      .toThrow(/wrong subject or graph/u);

    const subjectRows = [...projectRfc64SemanticRecordStoreRowsV1(record)];
    subjectRows[0] = { ...subjectRows[0], subjectIri: 'urn:test:wrong-subject' };
    expect(() => decodeRfc64SemanticRecordStoreRowsV1(subjectRows, coordinateFor(record)))
      .toThrow(/wrong subject or graph/u);
  });

  it('rejects wrong datatypes and noncanonical integer, digest, datetime, and list forms', () => {
    const guard = records[3];
    const integerRows = [...projectRfc64SemanticRecordStoreRowsV1(guard)];
    const generation = integerRows.findIndex(
      (row) => row.predicateIri === RFC64_SEMANTIC_PREDICATES_V1.GENERATION,
    );
    integerRows[generation] = {
      ...integerRows[generation],
      object: {
        kind: 'literal',
        value: '013',
        datatypeIri: 'http://www.w3.org/2001/XMLSchema#integer',
      },
    };
    expect(() => decodeRfc64SemanticRecordStoreRowsV1(integerRows, coordinateFor(guard)))
      .toThrow(/generation is not canonical/u);

    const digestRecord = records[5];
    const digestRows = [...projectRfc64SemanticRecordStoreRowsV1(digestRecord)];
    const digest = digestRows.findIndex(
      (row) => row.predicateIri === RFC64_SEMANTIC_PREDICATES_V1.APPLIED_DIRECTORY_ROOT_DIGEST,
    );
    digestRows[digest] = {
      ...digestRows[digest],
      object: {
        kind: 'literal',
        value: 'E'.repeat(64),
        datatypeIri: 'http://www.w3.org/2001/XMLSchema#hexBinary',
      },
    };
    expect(() => decodeRfc64SemanticRecordStoreRowsV1(
      digestRows,
      coordinateFor(digestRecord),
    )).toThrow(/exact lowercase xsd:hexBinary/u);

    const seal = records[1];
    const dateRows = [...projectRfc64SemanticRecordStoreRowsV1(seal)];
    const appliedAt = dateRows.findIndex(
      (row) => row.predicateIri === RFC64_SEMANTIC_PREDICATES_V1.APPLIED_AT,
    );
    dateRows[appliedAt] = {
      ...dateRows[appliedAt],
      object: {
        kind: 'literal',
        value: '2026-08-29T10:00:00Z',
        datatypeIri: 'http://www.w3.org/2001/XMLSchema#dateTime',
      },
    };
    expect(() => decodeRfc64SemanticRecordStoreRowsV1(dateRows, coordinateFor(seal)))
      .toThrow(/exact YYYY-MM-DDTHH:mm:ss.sssZ form/u);

    const target = records[4];
    const listRows = [...projectRfc64SemanticRecordStoreRowsV1(target)];
    const list = listRows.findIndex(
      (row) => row.predicateIri
        === RFC64_SEMANTIC_PREDICATES_V1.PENDING_TARGET_CHECKPOINT_DIGESTS,
    );
    listRows[list] = {
      ...listRows[list],
      object: {
        kind: 'literal',
        value: `[ "${D('c')}" ]`,
        datatypeIri: RFC64_DIGEST_LIST_DATATYPE_IRI_V1,
      },
    };
    expect(() => decodeRfc64SemanticRecordStoreRowsV1(listRows, coordinateFor(target)))
      .toThrow(/canonical digest list/u);
  });

  it('rejects malformed null branches and mismatched governance tuples', () => {
    const root = {
      recordType: 'CurrentAuthorCatalogRefV1',
      value: {
        ...records[0].value,
        governanceChainId: null,
        governanceContractAddress: null,
        ownershipTransitionDigest: null,
        subGraphName: null,
      },
    } as Rfc64SemanticRecordV1;
    const rows = [...projectRfc64SemanticRecordStoreRowsV1(root)];
    const chain = rows.findIndex(
      (row) => row.predicateIri === RFC64_SEMANTIC_PREDICATES_V1.GOVERNANCE_CHAIN_ID,
    );
    rows[chain] = {
      ...rows[chain],
      object: { kind: 'named-node', value: 'urn:dkg:sync:not-null' },
    };
    expect(() => decodeRfc64SemanticRecordStoreRowsV1(rows, coordinateFor(root)))
      .toThrow(/wrong RDF object form/u);

    expect(() => snapshotRfc64SemanticRecordV1({
      ...root,
      value: {
        ...root.value,
        governanceChainId: CHAIN,
        governanceContractAddress: null,
      },
    })).toThrow(/must both be null or both non-null/u);
  });

  it('enforces the pending-history and typed-response resource bounds', () => {
    const target = records[4];
    const tooMany = Array.from(
      { length: MAX_RFC64_PENDING_TARGET_DIGESTS_V1 + 1 },
      (_, index) => `0x${index.toString(16).padStart(64, '0')}` as Digest32V1,
    );
    expect(() => projectRfc64SemanticRecordStoreRowsV1({
      ...target,
      value: { ...target.value, pendingTargetCheckpointDigests: tooMany },
    })).toThrow(/exceeds 64 entries/u);
    expect(() => projectRfc64SemanticRecordStoreRowsV1({
      ...target,
      value: { ...target.value, pendingTargetCheckpointDigests: [D('c'), D('c')] },
    })).toThrow(/must be unique/u);

    const current = records[0];
    const rows = [...projectRfc64SemanticRecordStoreRowsV1(current)];
    rows[0] = {
      ...rows[0],
      object: {
        kind: 'literal',
        value: 'x'.repeat(MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1),
        datatypeIri: 'http://www.w3.org/2001/XMLSchema#string',
      },
    };
    expect(() => decodeRfc64SemanticRecordStoreRowsV1(rows, coordinateFor(current)))
      .toThrow(/exceeds 64 KiB/u);
  });

  it('snapshots the pending list so caller mutation cannot change a validated record', () => {
    const pending = [D('c'), D('d')];
    const record = snapshotRfc64SemanticRecordV1({
      ...records[4],
      value: { ...records[4].value, pendingTargetCheckpointDigests: pending },
    });
    pending[0] = D('f');
    expect(record.value).toMatchObject({
      pendingTargetCheckpointDigests: [D('c'), D('d')],
    });
    expect(Object.isFrozen(
      (record.value as { pendingTargetCheckpointDigests: readonly Digest32V1[] })
        .pendingTargetCheckpointDigests,
    )).toBe(true);
  });

  it('snapshots exactly the pending digest descriptors it validates', () => {
    let indexedReads = 0;
    const pending = new Proxy([D('c'), D('d')], {
      get(target, property, receiver) {
        if (property === '0' || property === '1') {
          indexedReads += 1;
          return 'not-a-digest';
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const record = snapshotRfc64SemanticRecordV1({
      ...records[4],
      value: { ...records[4].value, pendingTargetCheckpointDigests: pending },
    });
    expect(indexedReads).toBe(0);
    expect(record.value).toMatchObject({
      pendingTargetCheckpointDigests: [D('c'), D('d')],
    });
    const rows = projectRfc64SemanticRecordStoreRowsV1(record);
    expect(decodeRfc64SemanticRecordStoreRowsV1(rows, coordinateFor(record)).record)
      .toEqual(record);
  });

  it('pins every public rejection category, including coordinates and row structure', () => {
    const expectCode = (
      operation: () => unknown,
      code: Rfc64SemanticRecordErrorV1['code'],
    ) => {
      try {
        operation();
        throw new Error('expected operation to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(Rfc64SemanticRecordErrorV1);
        expect((error as Rfc64SemanticRecordErrorV1).code).toBe(code);
      }
    };

    expectCode(
      () => snapshotRfc64SemanticRecordV1({ recordType: 'unknown', value: {} }),
      'rfc64-semantic-schema',
    );
    expectCode(
      () => snapshotRfc64SemanticRecordV1({
        ...records[3],
        value: { ...records[3].value, generation: '013' },
      }),
      'rfc64-semantic-scalar',
    );
    const currentRows = [...projectRfc64SemanticRecordStoreRowsV1(records[0])];
    expectCode(
      () => decodeRfc64SemanticRecordStoreRowsV1(currentRows, {
        ...coordinateFor(records[0]),
        contextGraphId: 'not canonical' as ContextGraphIdV1,
      }),
      'rfc64-semantic-coordinate',
    );
    const adorned = Object.assign([...currentRows], { extra: true });
    expectCode(
      () => decodeRfc64SemanticRecordStoreRowsV1(adorned, coordinateFor(records[0])),
      'rfc64-semantic-row-schema',
    );
    expectCode(
      () => decodeRfc64SemanticRecordStoreRowsV1(currentRows.slice(1), coordinateFor(records[0])),
      'rfc64-semantic-row-cardinality',
    );
    expectCode(
      () => decodeRfc64SemanticRecordStoreRowsV1(
        [{ ...currentRows[0], graphIri: 'urn:test:wrong' }, ...currentRows.slice(1)],
        coordinateFor(records[0]),
      ),
      'rfc64-semantic-row-term',
    );
    expectCode(
      () => decodeRfc64SemanticRecordStoreRowsV1([
        {
          ...currentRows[0],
          object: {
            kind: 'literal',
            value: 'x'.repeat(MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1),
            datatypeIri: 'http://www.w3.org/2001/XMLSchema#string',
          },
        },
        ...currentRows.slice(1),
      ], coordinateFor(records[0])),
      'rfc64-semantic-too-large',
    );
    const multibyteRow = {
      ...currentRows[0],
      object: {
        kind: 'literal' as const,
        value: 'é'.repeat(MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1 / 2),
        datatypeIri: 'http://www.w3.org/2001/XMLSchema#string',
      },
    };
    expect(multibyteRow.object.value.length)
      .toBeLessThan(MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1);
    expect(typedRdfStoreRowByteLengthV1(multibyteRow))
      .toBeGreaterThan(MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1);
    expectCode(
      () => decodeRfc64SemanticRecordStoreRowsV1(
        [multibyteRow, ...currentRows.slice(1)],
        coordinateFor(records[0]),
      ),
      'rfc64-semantic-too-large',
    );
  });
});

function coordinateFor(record: Rfc64SemanticRecordV1): Rfc64SemanticRecordCoordinateV1 {
  const common = {
    recordType: record.recordType,
    networkId: record.value.networkId,
    contextGraphId: record.value.contextGraphId,
  };
  if (record.recordType === 'CurrentAuthorCatalogRefV1') {
    return {
      ...common,
      recordType: record.recordType,
      subGraphName: record.value.subGraphName,
      authorAddress: record.value.authorAddress,
    };
  }
  if (
    record.recordType === 'AppliedSubgraphSealV1'
    || record.recordType === 'SubgraphMutationGuardV1'
    || record.recordType === 'SubgraphReconcileTargetGuardV1'
  ) {
    return {
      ...common,
      recordType: record.recordType,
      subGraphName: record.value.subGraphName,
    };
  }
  return { ...common, recordType: record.recordType };
}
