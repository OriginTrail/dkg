import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  genericSqlSourceHandler,
  registerGenericSqlConnector,
  selectGenericSqlAssetGroupsForChangedPartitions,
  unregisterGenericSqlConnector,
  type GenericSqlClient,
  type GenericSqlMappingSpec,
  type GenericSqlSourceDefinition,
} from '../src/generic-sql-source.js';

const TEST_DIALECT = 'neutral-memory-sql';
const cleanupPaths: string[] = [];

afterEach(async () => {
  unregisterGenericSqlConnector(TEST_DIALECT);
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('generic SQL source handler', () => {
  it('queries a real SQLite database and maps typed literals and joins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'generic-sql-source-'));
    cleanupPaths.push(dir);
    const databasePath = join(dir, 'fixture.sqlite');
    await seedSqliteDatabase(databasePath);

    const result = await genericSqlSourceHandler.prepare(sqliteSource(databasePath));
    const quads = result.assets.flatMap((asset) => asset.quads);

    expect(result.fingerprintMetadata).toMatchObject({
      kind: 'generic-sql-partitions',
      mappingId: 'neutral.orders.v1',
      partitions: [
        {
          key: 'A100',
          rowCounts: {
            orders: 1,
            lines: 2,
          },
        },
      ],
    });
    expect(result.assets.map((asset) => asset.rootEntity).sort()).toEqual([
      'urn:neutral:line:L1',
      'urn:neutral:line:L2',
      'urn:neutral:order:A100',
    ]);
    expect(quads).toEqual(expect.arrayContaining([
      quad('urn:neutral:order:A100', 'https://example.test/quantity', '"12.5"^^<http://www.w3.org/2001/XMLSchema#decimal>'),
      quad('urn:neutral:order:A100', 'https://example.test/status', '"READY"'),
      quad('urn:neutral:line:L1', 'https://example.test/eventTime', '"2026-05-22T10:30:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>'),
      quad('urn:neutral:order:A100', 'https://example.test/hasLine', 'urn:neutral:line:L1'),
    ]));
  });

  it('fails clearly when a required SQL column is missing', async () => {
    registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
      async query(_sql, _parameters, dataset) {
        if (dataset === 'orders') {
          return [{ order_id: 'A100' }];
        }
        return [];
      },
    }));

    await expect(genericSqlSourceHandler.prepare(memorySource({
      ...mapping,
      datasets: {
        ...mapping.datasets,
        orders: {
          query: 'select order_id from customer_order',
          requiredColumns: ['order_id', 'quantity'],
        },
      },
    }))).rejects.toThrow('dataset orders is missing required columns: quantity');
  });

  it('renders mapping templates without regular expression replacement', async () => {
    registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
      async query(_sql, _parameters, dataset) {
        return rowsByDataset()[dataset] ?? [];
      },
    }));

    const result = await genericSqlSourceHandler.prepare(memorySource({
      ...mapping,
      entities: [
        {
          name: 'order',
          from: 'orders',
          id: 'urn:neutral:order:{order_id}',
          properties: {
            'https://example.test/composite': 'order-{order_id}-{status}',
            'https://example.test/emptyBraces': 'literal-{}',
            'https://example.test/unclosedBrace': 'literal-{status',
          },
        },
      ],
      relations: [],
    }));

    const quads = result.assets.flatMap((asset) => asset.quads);
    expect(quads).toEqual(expect.arrayContaining([
      quad('urn:neutral:order:A100', 'https://example.test/composite', '"order-A100-ready"'),
      quad('urn:neutral:order:A100', 'https://example.test/emptyBraces', '"literal-{}"'),
      quad('urn:neutral:order:A100', 'https://example.test/unclosedBrace', '"literal-{status"'),
    ]));
  });

  it('selects only asset groups for changed partitions', async () => {
    let rows = rowsByDataset();
    registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
      async query(_sql, _parameters, dataset) {
        return rows[dataset] ?? [];
      },
    }));

    const prior = await genericSqlSourceHandler.prepare(memorySource());
    rows = rowsByDataset({
      orders: [
        { order_id: 'A100', sku: 'W-1', quantity: '12.5', status: 'ready' },
        { order_id: 'B200', sku: 'W-2', quantity: '9', status: 'ready' },
      ],
    });
    const current = await genericSqlSourceHandler.prepare(memorySource());
    const groups = selectGenericSqlAssetGroupsForChangedPartitions(
      current.assets,
      current.fingerprintMetadata,
      prior.fingerprintMetadata,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.roots).toEqual(['urn:neutral:order:B200']);
  });

  it('changes the source fingerprint when mapping contents change without a version bump', async () => {
    registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
      async query(_sql, _parameters, dataset) {
        return rowsByDataset()[dataset] ?? [];
      },
    }));

    const prior = await genericSqlSourceHandler.prepare(memorySource());
    const current = await genericSqlSourceHandler.prepare(memorySource({
      ...mapping,
      relations: mapping.relations?.map((relation) => ({
        ...relation,
        predicate: 'https://example.test/includesLine',
      })),
    }));
    const groups = selectGenericSqlAssetGroupsForChangedPartitions(
      current.assets,
      current.fingerprintMetadata,
      prior.fingerprintMetadata,
    );

    expect(current.fingerprintMetadata.mappingId).toBe(prior.fingerprintMetadata.mappingId);
    expect(current.fingerprintMetadata.mappingVersion).toBe(prior.fingerprintMetadata.mappingVersion);
    expect(current.fingerprintMetadata.sourceConfigFingerprint).not.toBe(prior.fingerprintMetadata.sourceConfigFingerprint);
    expect(current.fingerprint).not.toBe(prior.fingerprint);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.roots).toEqual(current.assets.map((asset) => asset.rootEntity).sort());
  });

  it('rejects rows missing the configured partition key', async () => {
    registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
      async query(_sql, _parameters, dataset) {
        if (dataset === 'orders') {
          return [
            { order_id: '', sku: 'W-missing-key', quantity: '1', status: 'ready' },
          ];
        }
        return [];
      },
    }));

    await expect(genericSqlSourceHandler.prepare(memorySource({
      ...mapping,
      entities: [
        {
          name: 'order',
          from: 'orders',
          id: 'urn:neutral:sku:{sku}',
          properties: {
            'https://example.test/status': '{status}',
          },
        },
      ],
      relations: [],
      fingerprint: {
        mapperVersion: 1,
        partitionBy: {
          field: 'order_id',
          datasets: ['orders'],
        },
      },
    }))).rejects.toThrow('dataset orders row 1 is missing partition key order_id');
  });

  it('preflights missing SQL Server environment before loading optional driver', async () => {
    await expect(genericSqlSourceHandler.prepare({
      ...memorySource(),
      connection: {
        dialect: 'mssql',
        serverEnv: 'GENERIC_SQL_TEST_SERVER_NOT_SET',
        databaseEnv: 'GENERIC_SQL_TEST_DATABASE_NOT_SET',
        userEnv: 'GENERIC_SQL_TEST_USER_NOT_SET',
        passwordEnv: 'GENERIC_SQL_TEST_PASSWORD_NOT_SET',
      },
    })).rejects.toThrow('requires environment variable GENERIC_SQL_TEST_SERVER_NOT_SET');
  });

  describe('mapping validation', () => {
    it('rejects mapping without id', async () => {
      registerStaticConnector();
      await expect(
        genericSqlSourceHandler.prepare(memorySource({ ...mapping, id: '' as unknown as string })),
      ).rejects.toThrow(/mapping is missing id/);
    });

    it('rejects mapping without datasets', async () => {
      registerStaticConnector();
      await expect(
        genericSqlSourceHandler.prepare(
          memorySource({ ...mapping, datasets: {} } as unknown as GenericSqlMappingSpec),
        ),
      ).rejects.toThrow(/must define at least one dataset/);
    });

    it('rejects mapping without entities', async () => {
      registerStaticConnector();
      await expect(
        genericSqlSourceHandler.prepare(memorySource({ ...mapping, entities: [] })),
      ).rejects.toThrow(/must define at least one entity/);
    });

    it('rejects an entity without name', async () => {
      registerStaticConnector();
      await expect(
        genericSqlSourceHandler.prepare(
          memorySource({
            ...mapping,
            entities: [{ ...mapping.entities[0]!, name: '' }],
          }),
        ),
      ).rejects.toThrow(/has an entity without name/);
    });

    it('rejects duplicate entity names — collision is unrecoverable in fingerprint roots', async () => {
      registerStaticConnector();
      await expect(
        genericSqlSourceHandler.prepare(
          memorySource({
            ...mapping,
            entities: [mapping.entities[0]!, mapping.entities[0]!],
          }),
        ),
      ).rejects.toThrow(/has duplicate entity order/);
    });

    it('rejects an entity referencing an unknown dataset', async () => {
      registerStaticConnector();
      await expect(
        genericSqlSourceHandler.prepare(
          memorySource({
            ...mapping,
            entities: [{ ...mapping.entities[0]!, from: 'no_such_dataset' }],
          }),
        ),
      ).rejects.toThrow(/references unknown dataset no_such_dataset/);
    });

    it('rejects an entity without id template', async () => {
      registerStaticConnector();
      await expect(
        genericSqlSourceHandler.prepare(
          memorySource({
            ...mapping,
            entities: [{ ...mapping.entities[0]!, id: '' }],
          }),
        ),
      ).rejects.toThrow(/must define id/);
    });

    it('rejects a relation referencing an unknown from-entity', async () => {
      registerStaticConnector();
      await expect(
        genericSqlSourceHandler.prepare(
          memorySource({
            ...mapping,
            relations: [{ ...mapping.relations![0]!, from: 'phantom' }],
          }),
        ),
      ).rejects.toThrow(/relation references unknown from entity phantom/);
    });

    it('rejects a relation referencing an unknown to-entity', async () => {
      registerStaticConnector();
      await expect(
        genericSqlSourceHandler.prepare(
          memorySource({
            ...mapping,
            relations: [{ ...mapping.relations![0]!, to: 'phantom' }],
          }),
        ),
      ).rejects.toThrow(/relation references unknown to entity phantom/);
    });
  });

  describe('connection / dialect routing', () => {
    it('rejects a source whose connection is missing dialect', async () => {
      await expect(
        genericSqlSourceHandler.prepare({
          ...memorySource(),
          connection: {} as unknown as GenericSqlSourceDefinition['connection'],
        }),
      ).rejects.toThrow(/connection must define dialect/);
    });

    it('rejects an unsupported SQL dialect (no factory registered)', async () => {
      // Defends the explicit allow-list: a typo or rogue dialect must
      // surface a clear error, not silently fall through to a default
      // that might point at the wrong driver.
      await expect(
        genericSqlSourceHandler.prepare({
          ...memorySource(),
          connection: { dialect: 'totally-fake-dialect-xyz' },
        }),
      ).rejects.toThrow(/unsupported SQL dialect totally-fake-dialect-xyz/);
    });

    it('rejects sqlite connection without databasePath or databasePathEnv', async () => {
      await expect(
        genericSqlSourceHandler.prepare({
          ...memorySource(),
          connection: { dialect: 'sqlite' },
        }),
      ).rejects.toThrow(/sqlite connection must define databasePath or databasePathEnv/);
    });

    it('rejects mssql connection missing serverEnv name', async () => {
      // No serverEnv at all (different from "env var unset" which the
      // existing test covers). Surfaces that the mapping itself is
      // incomplete vs the runtime env being incomplete.
      await expect(
        genericSqlSourceHandler.prepare({
          ...memorySource(),
          connection: {
            dialect: 'mssql',
            databaseEnv: 'MSSQL_DB',
            userEnv: 'MSSQL_USER',
            passwordEnv: 'MSSQL_PWD',
          },
        }),
      ).rejects.toThrow(/mssql connection must define serverEnv/);
    });
  });

  describe('mapping loader (mappingFile vs mapping)', () => {
    it('rejects a source with neither mapping nor mappingFile', async () => {
      registerStaticConnector();
      const src: GenericSqlSourceDefinition = {
        id: 'no-mapping',
        kind: 'generic-sql',
        connection: { dialect: TEST_DIALECT },
      };
      await expect(genericSqlSourceHandler.prepare(src)).rejects.toThrow(
        /must define mapping or mappingFile/,
      );
    });

    it('reads mapping from disk when mappingFile is provided', async () => {
      registerStaticConnector();
      const dir = await mkdtemp(join(tmpdir(), 'generic-sql-mapping-'));
      cleanupPaths.push(dir);
      const mappingPath = join(dir, 'mapping.json');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(mappingPath, JSON.stringify(mapping), 'utf8');

      const src: GenericSqlSourceDefinition = {
        id: 'file-mapping',
        kind: 'generic-sql',
        connection: { dialect: TEST_DIALECT },
        mappingFile: mappingPath,
      };
      const result = await genericSqlSourceHandler.prepare(src);
      // Same content, same fingerprint structure as inline mapping (modulo
      // source id / parameters which are part of sourceConfigFingerprint).
      expect(result.fingerprintMetadata.mappingId).toBe('neutral.orders.v1');
      expect(result.assets.length).toBeGreaterThan(0);
    });
  });

  describe('connector registry', () => {
    it('round-trips register / unregister for a custom dialect', async () => {
      const dialect = 'one-shot-test-dialect';
      registerGenericSqlConnector(dialect, async () => ({
        async query() { return []; },
      }));
      const src: GenericSqlSourceDefinition = {
        ...memorySource(),
        connection: { dialect },
      };
      // While registered: prepare succeeds (no datasets returns empty assets).
      const ok = await genericSqlSourceHandler.prepare(src);
      expect(ok.assets).toEqual([]);
      // After unregister: prepare fails with the unsupported-dialect path.
      unregisterGenericSqlConnector(dialect);
      await expect(genericSqlSourceHandler.prepare(src)).rejects.toThrow(
        /unsupported SQL dialect one-shot-test-dialect/,
      );
    });

    it('unregistering a built-in dialect restores the default factory (no permanent removal)', async () => {
      // Even after explicit unregister, mssql/sqlite are restored — this
      // is the contract that `unregisterGenericSqlConnector` enforces so
      // tests can stub them without leaking into other tests.
      registerGenericSqlConnector('mssql', async () => ({
        async query() { return []; },
      }));
      unregisterGenericSqlConnector('mssql');
      // The default mssql factory rejects without env vars, not with the
      // unsupported-dialect error. Both error messages prove the factory
      // is back in place.
      await expect(
        genericSqlSourceHandler.prepare({
          ...memorySource(),
          connection: {
            dialect: 'mssql',
            serverEnv: 'GENERIC_SQL_TEST_SERVER_NOT_SET_2',
            databaseEnv: 'GENERIC_SQL_TEST_DATABASE_NOT_SET_2',
            userEnv: 'GENERIC_SQL_TEST_USER_NOT_SET_2',
            passwordEnv: 'GENERIC_SQL_TEST_PASSWORD_NOT_SET_2',
          },
        }),
      ).rejects.toThrow(/requires environment variable GENERIC_SQL_TEST_SERVER_NOT_SET_2/);
    });
  });

  describe('row normalization (normalizeSqlValue)', () => {
    it('serialises Date objects as ISO 8601 strings before mapping', async () => {
      registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
        async query(_sql, _parameters, dataset) {
          if (dataset === 'orders') {
            return [{
              order_id: 'A100',
              sku: 'W-1',
              quantity: '1',
              status: 'ready',
              created_at: new Date('2026-05-22T10:30:00.000Z'),
            }];
          }
          return [];
        },
      }));

      const result = await genericSqlSourceHandler.prepare(memorySource({
        ...mapping,
        entities: [{
          name: 'order',
          from: 'orders',
          id: 'urn:neutral:order:{order_id}',
          properties: {
            'https://example.test/createdAt': {
              value: '{created_at}',
              datatype: 'xsd:dateTime',
            },
          },
        }],
        relations: [],
      }));
      const quads = result.assets.flatMap((asset) => asset.quads);
      expect(quads).toContainEqual(
        quad(
          'urn:neutral:order:A100',
          'https://example.test/createdAt',
          '"2026-05-22T10:30:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
        ),
      );
    });

    it('serialises bigint values as decimal strings (no BigInt JSON crash, no truncation)', async () => {
      registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
        async query(_sql, _parameters, dataset) {
          if (dataset === 'orders') {
            return [{
              order_id: 'A100',
              sku: 'W-1',
              quantity: '1',
              status: 'ready',
              big_count: 9_007_199_254_740_993n, // > Number.MAX_SAFE_INTEGER
            }];
          }
          return [];
        },
      }));

      const result = await genericSqlSourceHandler.prepare(memorySource({
        ...mapping,
        entities: [{
          name: 'order',
          from: 'orders',
          id: 'urn:neutral:order:{order_id}',
          properties: {
            'https://example.test/bigCount': {
              value: '{big_count}',
              datatype: 'xsd:integer',
            },
          },
        }],
        relations: [],
      }));
      const quads = result.assets.flatMap((asset) => asset.quads);
      expect(quads).toContainEqual(
        quad(
          'urn:neutral:order:A100',
          'https://example.test/bigCount',
          '"9007199254740993"^^<http://www.w3.org/2001/XMLSchema#integer>',
        ),
      );
    });

    it('serialises Uint8Array (binary blob) values as base64', async () => {
      registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
        async query(_sql, _parameters, dataset) {
          if (dataset === 'orders') {
            return [{
              order_id: 'A100',
              sku: 'W-1',
              quantity: '1',
              status: 'ready',
              payload: new Uint8Array([1, 2, 3, 4]),
            }];
          }
          return [];
        },
      }));

      const result = await genericSqlSourceHandler.prepare(memorySource({
        ...mapping,
        entities: [{
          name: 'order',
          from: 'orders',
          id: 'urn:neutral:order:{order_id}',
          properties: {
            'https://example.test/payloadB64': '{payload}',
          },
        }],
        relations: [],
      }));
      const quads = result.assets.flatMap((asset) => asset.quads);
      expect(quads).toContainEqual(
        quad(
          'urn:neutral:order:A100',
          'https://example.test/payloadB64',
          '"AQIDBA=="',
        ),
      );
    });
  });

  describe('property / transform coverage', () => {
    it('emits rdf:type triples for entity.type (string and array forms)', async () => {
      registerStaticConnector();
      const result = await genericSqlSourceHandler.prepare(memorySource({
        ...mapping,
        entities: [{
          name: 'order',
          from: 'orders',
          id: 'urn:neutral:order:{order_id}',
          type: [
            'https://example.test/Order',
            'https://example.test/CommerceObject',
          ],
        }],
        relations: [],
      }));
      const quads = result.assets.flatMap((asset) => asset.quads);
      expect(quads).toContainEqual(
        quad(
          'urn:neutral:order:A100',
          'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
          'https://example.test/Order',
        ),
      );
      expect(quads).toContainEqual(
        quad(
          'urn:neutral:order:A100',
          'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
          'https://example.test/CommerceObject',
        ),
      );
    });

    it('iri-form property emits the rendered IRI directly (NOT as a quoted literal)', async () => {
      // The contract is: `iri:` form bypasses the `literal()` wrapper —
      // a regression that wrapped the IRI in `"..."` quotes would render
      // it as a string literal, breaking SPARQL property-path traversal.
      registerStaticConnector();
      const result = await genericSqlSourceHandler.prepare(memorySource({
        ...mapping,
        entities: [{
          name: 'order',
          from: 'orders',
          id: 'urn:neutral:order:{order_id}',
          properties: {
            'https://example.test/seeAlso': { iri: 'urn:neutral:related:{sku}' },
          },
        }],
        relations: [],
      }));
      const quads = result.assets.flatMap((asset) => asset.quads);
      expect(quads).toContainEqual(
        quad('urn:neutral:order:A100', 'https://example.test/seeAlso', 'urn:neutral:related:W-1'),
      );
      // Negative: must NOT have been wrapped as a literal.
      expect(quads).not.toContainEqual(
        quad('urn:neutral:order:A100', 'https://example.test/seeAlso', '"urn:neutral:related:W-1"'),
      );
    });

    it('does NOT emit a property quad when the source value is null or empty (no empty literal)', async () => {
      // Without this guard, the assertion store would gain `<order> <p> ""`
      // triples that downstream queries treat as a present-but-blank value.
      registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
        async query(_sql, _parameters, dataset) {
          if (dataset === 'orders') {
            return [{ order_id: 'A100', sku: 'W-1', quantity: '1', status: null }];
          }
          return [];
        },
      }));
      const result = await genericSqlSourceHandler.prepare(memorySource({
        ...mapping,
        entities: [{
          name: 'order',
          from: 'orders',
          id: 'urn:neutral:order:{order_id}',
          properties: {
            'https://example.test/status': { value: '{status}' },
            'https://example.test/sku': { value: '{sku}' },
          },
        }],
        relations: [],
      }));
      const quads = result.assets.flatMap((asset) => asset.quads);
      expect(quads).toContainEqual(
        quad('urn:neutral:order:A100', 'https://example.test/sku', '"W-1"'),
      );
      expect(quads.find((q) => q.predicate === 'https://example.test/status')).toBeUndefined();
    });

    it('coalesce transform picks the first non-empty argument', async () => {
      registerStaticConnector();
      const result = await genericSqlSourceHandler.prepare(memorySource({
        ...mapping,
        entities: [{
          name: 'order',
          from: 'orders',
          id: 'urn:neutral:order:{order_id}',
          properties: {
            'https://example.test/firstNonEmpty': {
              transform: 'coalesce',
              args: ['{sku_missing}', '', '{status}'],
            },
          },
        }],
        relations: [],
      }));
      const quads = result.assets.flatMap((asset) => asset.quads);
      expect(quads).toContainEqual(
        quad('urn:neutral:order:A100', 'https://example.test/firstNonEmpty', '"ready"'),
      );
    });

    it('trim / lower transforms produce the expected literal forms', async () => {
      registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
        async query(_sql, _parameters, dataset) {
          if (dataset === 'orders') {
            return [{ order_id: 'A100', sku: '  W-1  ', quantity: '1', status: 'READY' }];
          }
          return [];
        },
      }));
      const result = await genericSqlSourceHandler.prepare(memorySource({
        ...mapping,
        entities: [{
          name: 'order',
          from: 'orders',
          id: 'urn:neutral:order:{order_id}',
          properties: {
            'https://example.test/skuTrim': { transform: 'trim', args: ['{sku}'] },
            'https://example.test/statusLower': { transform: 'lower', args: ['{status}'] },
          },
        }],
        relations: [],
      }));
      const quads = result.assets.flatMap((asset) => asset.quads);
      expect(quads).toContainEqual(
        quad('urn:neutral:order:A100', 'https://example.test/skuTrim', '"W-1"'),
      );
      expect(quads).toContainEqual(
        quad('urn:neutral:order:A100', 'https://example.test/statusLower', '"ready"'),
      );
    });

    it('rejects unknown transforms (closed allow-list)', async () => {
      registerStaticConnector();
      await expect(
        genericSqlSourceHandler.prepare(memorySource({
          ...mapping,
          entities: [{
            name: 'order',
            from: 'orders',
            id: 'urn:neutral:order:{order_id}',
            properties: {
              'https://example.test/unknown': { transform: 'no_such_transform', args: ['{sku}'] },
            },
          }],
          relations: [],
        })),
      ).rejects.toThrow(/Unsupported generic SQL mapping transform: no_such_transform/);
    });

    it('combineDateTime returns null (no quad emitted) when the date argument is empty', async () => {
      // Defensive: combineDateTime with empty date must not produce
      // `T10:30Z` — that would forge a 1970-01-01-style ISO string that
      // looks valid but corresponds to no source row.
      registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
        async query(_sql, _parameters, dataset) {
          if (dataset === 'lines') {
            return [{
              line_id: 'L1',
              order_id: 'A100',
              line_quantity: '1',
              event_date: '',
              event_time: '10:30',
            }];
          }
          if (dataset === 'orders') {
            return [{ order_id: 'A100', sku: 'W-1', quantity: '1', status: 'ready' }];
          }
          return [];
        },
      }));
      const result = await genericSqlSourceHandler.prepare(memorySource());
      const lineQuads = result.assets
        .filter((a) => a.rootEntity.startsWith('urn:neutral:line:'))
        .flatMap((a) => a.quads);
      expect(lineQuads.find((q) => q.predicate === 'https://example.test/eventTime')).toBeUndefined();
    });

    it('combineDateTime with HH:MM time pads to HH:MM:00 (deterministic shape)', async () => {
      // Locks the normalize-time spec: the source format is HH:MM in the
      // fixture, the emitted value MUST be HH:MM:00 to satisfy
      // xsd:dateTime grammar. A regression that left HH:MM bare would
      // make every produced quad fail dateTime parsing on subscribers.
      registerStaticConnector();
      const result = await genericSqlSourceHandler.prepare(memorySource());
      const lineQuads = result.assets
        .filter((a) => a.rootEntity.startsWith('urn:neutral:line:'))
        .flatMap((a) => a.quads);
      expect(lineQuads).toContainEqual(
        quad(
          'urn:neutral:line:L1',
          'https://example.test/eventTime',
          '"2026-05-22T10:30:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
        ),
      );
    });
  });

  describe('template renderer edge cases', () => {
    it('substitutes a missing field with empty string and keeps surrounding literal', async () => {
      registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
        async query(_sql, _parameters, dataset) {
          if (dataset === 'orders') {
            return [{ order_id: 'A100', sku: 'W-1', quantity: '1', status: 'ready' }];
          }
          return [];
        },
      }));
      const result = await genericSqlSourceHandler.prepare(memorySource({
        ...mapping,
        entities: [{
          name: 'order',
          from: 'orders',
          id: 'urn:neutral:order:{order_id}',
          properties: {
            'https://example.test/composite': 'a-{missing_col}-b',
          },
        }],
        relations: [],
      }));
      const quads = result.assets.flatMap((asset) => asset.quads);
      // Missing field renders as empty string, surrounding literal retained.
      expect(quads).toContainEqual(
        quad('urn:neutral:order:A100', 'https://example.test/composite', '"a--b"'),
      );
    });
  });

  describe('relation join edge cases', () => {
    it('respects qualified field syntax `dataset.field` on both sides of the join', async () => {
      // The current fixture uses `orders.order_id` / `lines.order_id`. We
      // probe the dataset-prefix gate by switching the right side to a
      // dataset that doesn't match — the join MUST produce no edges, not
      // silently fall through to unqualified field lookup.
      registerStaticConnector();
      const result = await genericSqlSourceHandler.prepare(memorySource({
        ...mapping,
        relations: [{
          from: 'order',
          to: 'line',
          predicate: 'https://example.test/hasLine',
          join: { left: 'orders.order_id', right: 'orders.order_id' },
          // ^^^ wrong dataset on the right; line instances live in `lines`
          // so the right-side filter rejects every instance.
        }],
      }));
      const quads = result.assets.flatMap((a) => a.quads);
      expect(quads.find((q) => q.predicate === 'https://example.test/hasLine')).toBeUndefined();
    });

    it('skips join rows where the join field is empty on either side (no orphan edges)', async () => {
      // Probe only the relation-join logic without tripping the partition-key
      // validator: keep `lines` out of the partition set (partitionBy.datasets
      // = ['orders'] only) so an empty order_id on a line row is allowed at
      // fingerprint stage but the join still has to skip it.
      registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
        async query(_sql, _parameters, dataset) {
          if (dataset === 'orders') {
            return [{ order_id: 'A100', sku: 'W-1', quantity: '1', status: 'ready' }];
          }
          if (dataset === 'lines') {
            return [
              { line_id: 'L1', order_id: 'A100', line_quantity: '1', event_date: '2026-05-22', event_time: '10:00' },
              { line_id: 'L2', order_id: '',     line_quantity: '1', event_date: '2026-05-22', event_time: '11:00' },
            ];
          }
          return [];
        },
      }));
      const result = await genericSqlSourceHandler.prepare(memorySource({
        ...mapping,
        fingerprint: {
          ...mapping.fingerprint!,
          partitionBy: { field: 'order_id', datasets: ['orders'] },
        },
      }));
      const orderAssets = result.assets.find((a) => a.rootEntity === 'urn:neutral:order:A100');
      const lineEdges = (orderAssets?.quads ?? []).filter(
        (q) => q.predicate === 'https://example.test/hasLine',
      );
      // Only L1 has a non-empty order_id; L2 must NOT produce an edge.
      expect(lineEdges).toHaveLength(1);
      expect(lineEdges[0]!.object).toBe('urn:neutral:line:L1');
    });
  });

  describe('fingerprint stability + drift', () => {
    it('is bit-stable across two runs with identical inputs (deterministic)', async () => {
      registerStaticConnector();
      const a = await genericSqlSourceHandler.prepare(memorySource());
      const b = await genericSqlSourceHandler.prepare(memorySource());
      expect(a.fingerprint).toBe(b.fingerprint);
      expect(a.fingerprintMetadata.sourceConfigFingerprint).toBe(
        b.fingerprintMetadata.sourceConfigFingerprint,
      );
      expect(a.fingerprintMetadata.partitions.map((p) => p.fingerprint)).toEqual(
        b.fingerprintMetadata.partitions.map((p) => p.fingerprint),
      );
    });

    it('partition fingerprint is order-independent for a given dataset rows (sorted internally)', async () => {
      // Two runs differ only in row order. partition fingerprint must be
      // stable so partition-level diff doesn't fire on a benign reorder.
      let returnReversed = false;
      registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
        async query(_sql, _parameters, dataset) {
          const rows = rowsByDataset();
          const datasetRows = (rows[dataset] ?? []) as Record<string, unknown>[];
          return returnReversed ? [...datasetRows].reverse() : datasetRows;
        },
      }));
      const a = await genericSqlSourceHandler.prepare(memorySource());
      returnReversed = true;
      const b = await genericSqlSourceHandler.prepare(memorySource());
      expect(a.fingerprintMetadata.partitions.map((p) => p.fingerprint)).toEqual(
        b.fingerprintMetadata.partitions.map((p) => p.fingerprint),
      );
    });

    it('source.parameters change reshapes sourceConfigFingerprint (and overall fingerprint)', async () => {
      // parameters are part of `sourceFingerprintConfig` — two prepares
      // with different parameter values must NOT collide.
      registerStaticConnector();
      const a = await genericSqlSourceHandler.prepare({ ...memorySource(), parameters: { x: '1' } });
      const b = await genericSqlSourceHandler.prepare({ ...memorySource(), parameters: { x: '2' } });
      expect(a.fingerprintMetadata.sourceConfigFingerprint).not.toBe(
        b.fingerprintMetadata.sourceConfigFingerprint,
      );
      expect(a.fingerprint).not.toBe(b.fingerprint);
    });

    it('mapping.version bump alone changes the fingerprint (forces full publish on subscribers)', async () => {
      registerStaticConnector();
      const v1 = await genericSqlSourceHandler.prepare(memorySource({ ...mapping, version: '1' }));
      const v2 = await genericSqlSourceHandler.prepare(memorySource({ ...mapping, version: '2' }));
      expect(v1.fingerprint).not.toBe(v2.fingerprint);
      expect(v1.fingerprintMetadata.mappingVersion).toBe('1');
      expect(v2.fingerprintMetadata.mappingVersion).toBe('2');
    });

    it('mapperVersion bump alone changes the fingerprint and forces full publish', async () => {
      // mapperVersion is the protocol-level kill switch when the
      // *mapping engine* changes semantics (e.g. xsd encoding rules).
      // A bump must invalidate every prior partition fingerprint so
      // every subscriber re-publishes — the change-detection path must
      // surface as a full publish on the consumer.
      registerStaticConnector();
      const v1 = await genericSqlSourceHandler.prepare(memorySource({
        ...mapping,
        fingerprint: { ...mapping.fingerprint!, mapperVersion: 1 },
      }));
      const v2 = await genericSqlSourceHandler.prepare(memorySource({
        ...mapping,
        fingerprint: { ...mapping.fingerprint!, mapperVersion: 2 },
      }));
      expect(v1.fingerprint).not.toBe(v2.fingerprint);

      const groups = selectGenericSqlAssetGroupsForChangedPartitions(
        v2.assets,
        v2.fingerprintMetadata,
        v1.fingerprintMetadata,
      );
      // mapperVersion change → requiresFullPublish → all assets group.
      expect(groups).toHaveLength(1);
      expect(groups[0]!.roots).toEqual(v2.assets.map((a) => a.rootEntity).sort());
    });
  });

  describe('selectGenericSqlAssetGroupsForChangedPartitions edge cases', () => {
    it('returns the full all-assets group when prior fingerprint is undefined (cold start)', async () => {
      registerStaticConnector();
      const current = await genericSqlSourceHandler.prepare(memorySource());
      const groups = selectGenericSqlAssetGroupsForChangedPartitions(
        current.assets,
        current.fingerprintMetadata,
        undefined, // no prior — cold start
      );
      expect(groups).toHaveLength(1);
      expect(groups[0]!.roots).toEqual(current.assets.map((a) => a.rootEntity).sort());
    });

    it('returns an empty array when both fingerprints exist and no partition changed (steady state)', async () => {
      registerStaticConnector();
      const a = await genericSqlSourceHandler.prepare(memorySource());
      const b = await genericSqlSourceHandler.prepare(memorySource());
      const groups = selectGenericSqlAssetGroupsForChangedPartitions(
        b.assets,
        b.fingerprintMetadata,
        a.fingerprintMetadata,
      );
      expect(groups).toEqual([]);
    });

    it('returns the full all-assets group when a prior partition disappears (forces full publish)', async () => {
      // requiresFullPublish branch: prior had key X, current doesn't —
      // the publisher must republish everything because the partition
      // semantic changed. We probe by stripping a row in current.
      let dropB200 = false;
      registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
        async query(_sql, _parameters, dataset) {
          const rows = rowsByDataset();
          if (dropB200 && dataset === 'orders') {
            return ((rows.orders as Record<string, unknown>[]) ?? []).filter((r) => r.order_id !== 'B200');
          }
          return rows[dataset] ?? [];
        },
      }));
      const prior = await genericSqlSourceHandler.prepare(memorySource());
      dropB200 = true;
      const current = await genericSqlSourceHandler.prepare(memorySource());
      const groups = selectGenericSqlAssetGroupsForChangedPartitions(
        current.assets,
        current.fingerprintMetadata,
        prior.fingerprintMetadata,
      );
      // B200 disappeared → requiresFullPublish → all assets group.
      expect(groups).toHaveLength(1);
      expect(groups[0]!.roots).toEqual(current.assets.map((a) => a.rootEntity).sort());
    });

    it('returns an empty array when prior is missing but current has zero assets (cold-start no-op)', async () => {
      registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
        async query() { return []; },
      }));
      const current = await genericSqlSourceHandler.prepare(memorySource());
      const groups = selectGenericSqlAssetGroupsForChangedPartitions(
        current.assets,
        current.fingerprintMetadata,
        undefined,
      );
      expect(groups).toEqual([]);
    });
  });
});

function registerStaticConnector(rows = rowsByDataset()) {
  registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
    async query(_sql, _parameters, dataset) {
      return rows[dataset] ?? [];
    },
  }));
}

function sqliteSource(databasePath: string): GenericSqlSourceDefinition {
  return {
    ...memorySource(),
    connection: {
      dialect: 'sqlite',
      databasePath,
    },
    parameters: {
      orderId: 'A100',
    },
  };
}

function memorySource(customMapping: GenericSqlMappingSpec = mapping): GenericSqlSourceDefinition {
  return {
    id: 'neutral-orders',
    kind: 'generic-sql',
    dataset: 'neutral',
    connection: {
      dialect: TEST_DIALECT,
    },
    mapping: customMapping,
  };
}

const mapping: GenericSqlMappingSpec = {
  id: 'neutral.orders.v1',
  version: '1',
  datasets: {
    orders: {
      query: 'select order_id, sku, quantity, status from customer_order where order_id = @orderId',
      requiredColumns: ['order_id', 'sku', 'quantity', 'status'],
    },
    lines: {
      query: 'select line_id, order_id, line_quantity, event_date, event_time from shipment_line where order_id = @orderId',
      requiredColumns: ['line_id', 'order_id', 'line_quantity', 'event_date', 'event_time'],
    },
  },
  entities: [
    {
      name: 'order',
      from: 'orders',
      id: 'urn:neutral:order:{order_id}',
      type: 'https://example.test/Order',
      properties: {
        'https://example.test/sku': '{sku}',
        'https://example.test/quantity': {
          value: '{quantity}',
          datatype: 'xsd:decimal',
        },
        'https://example.test/status': {
          transform: 'upper',
          args: ['{status}'],
        },
      },
    },
    {
      name: 'line',
      from: 'lines',
      id: 'urn:neutral:line:{line_id}',
      type: 'https://example.test/ShipmentLine',
      properties: {
        'https://example.test/lineQuantity': {
          value: '{line_quantity}',
          datatype: 'xsd:integer',
        },
        'https://example.test/eventTime': {
          transform: 'combineDateTime',
          args: ['{event_date}', '{event_time}', 'Z'],
          datatype: 'xsd:dateTime',
        },
      },
    },
  ],
  relations: [
    {
      from: 'order',
      to: 'line',
      predicate: 'https://example.test/hasLine',
      join: {
        left: 'orders.order_id',
        right: 'lines.order_id',
      },
    },
  ],
  fingerprint: {
    mapperVersion: 1,
    partitionBy: {
      field: 'order_id',
      datasets: ['orders', 'lines'],
    },
  },
};

function rowsByDataset(overrides: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  return {
    orders: [
      { order_id: 'A100', sku: 'W-1', quantity: '12.5', status: 'ready' },
      { order_id: 'B200', sku: 'W-2', quantity: '8', status: 'ready' },
    ],
    lines: [
      { line_id: 'L1', order_id: 'A100', line_quantity: '7', event_date: '2026-05-22', event_time: '10:30' },
      { line_id: 'L2', order_id: 'A100', line_quantity: '5', event_date: '2026-05-22', event_time: '10:45' },
    ],
    ...overrides,
  };
}

async function seedSqliteDatabase(databasePath: string): Promise<void> {
  const moduleName = 'node:sqlite';
  const sqlite = await import(moduleName) as any;
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE customer_order (
        order_id TEXT PRIMARY KEY,
        sku TEXT NOT NULL,
        quantity TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE shipment_line (
        line_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        line_quantity TEXT NOT NULL,
        event_date TEXT NOT NULL,
        event_time TEXT NOT NULL
      );
    `);
    database.prepare('INSERT INTO customer_order VALUES (?, ?, ?, ?)').run('A100', 'W-1', '12.5', 'ready');
    database.prepare('INSERT INTO customer_order VALUES (?, ?, ?, ?)').run('B200', 'W-2', '8', 'ready');
    const insertLine = database.prepare('INSERT INTO shipment_line VALUES (?, ?, ?, ?, ?)');
    insertLine.run('L1', 'A100', '7', '2026-05-22', '10:30');
    insertLine.run('L2', 'A100', '5', '2026-05-22', '10:45');
  } finally {
    database.close();
  }
}

function quad(subject: string, predicate: string, object: string) {
  return { subject, predicate, object, graph: '' };
}
