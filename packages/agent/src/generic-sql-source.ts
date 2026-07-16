import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SourceKindHandler, SourcePreparationResult, SourceWorkerSource } from './source-worker.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema#';
const DEFAULT_MAPPER_VERSION = 1;

export interface GenericSqlQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

export interface GenericSqlAsset {
  rootEntity: string;
  quads: GenericSqlQuad[];
}

export interface GenericSqlConnectionDefinition {
  dialect: string;
  serverEnv?: string;
  hostEnv?: string;
  portEnv?: string;
  databaseEnv?: string;
  databasePath?: string;
  databasePathEnv?: string;
  userEnv?: string;
  passwordEnv?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  requestTimeoutMs?: number;
}

export type GenericSqlParameterValue = string | number | boolean | null | readonly string[] | readonly number[];

export interface GenericSqlDatasetSpec {
  query: string;
  key?: string | readonly string[];
  requiredColumns?: readonly string[];
}

export interface GenericSqlPropertyObjectSpec {
  value?: string;
  iri?: string;
  datatype?: string;
  transform?: string;
  args?: readonly string[];
  optional?: boolean;
}

export type GenericSqlPropertySpec = string | GenericSqlPropertyObjectSpec;

export interface GenericSqlEntitySpec {
  name: string;
  from: string;
  id: string;
  type?: string | readonly string[];
  properties?: Record<string, GenericSqlPropertySpec>;
}

export interface GenericSqlRelationSpec {
  from: string;
  to: string;
  predicate: string;
  join: {
    left: string;
    right: string;
  };
}

export interface GenericSqlFingerprintSpec {
  partitionBy?: {
    field: string;
    datasets?: readonly string[];
  };
  globalDatasets?: readonly string[];
  mapperVersion?: number;
}

export interface GenericSqlMappingSpec {
  id: string;
  version?: string;
  datasets: Record<string, GenericSqlDatasetSpec>;
  entities: readonly GenericSqlEntitySpec[];
  relations?: readonly GenericSqlRelationSpec[];
  fingerprint?: GenericSqlFingerprintSpec;
}

export interface GenericSqlSourceDefinition extends SourceWorkerSource {
  kind: 'generic-sql';
  dataset?: string;
  connection: GenericSqlConnectionDefinition;
  mapping?: GenericSqlMappingSpec;
  mappingFile?: string;
  parameters?: Record<string, GenericSqlParameterValue>;
}

export interface GenericSqlPartitionFingerprintMetadata {
  key: string;
  fingerprint: string;
  rootEntities: string[];
  rowCounts: Record<string, number>;
}

export interface GenericSqlFingerprintMetadata {
  kind: 'generic-sql-partitions';
  mappingId: string;
  mappingVersion?: string;
  mapperVersion: number;
  sourceConfigFingerprint: string;
  globalFingerprint: string;
  partitions: GenericSqlPartitionFingerprintMetadata[];
}

export interface GenericSqlPreparationResult extends SourcePreparationResult<GenericSqlAsset> {
  fingerprintMetadata: GenericSqlFingerprintMetadata;
}

export type GenericSqlRow = Record<string, unknown>;

export interface GenericSqlClient {
  query(
    sql: string,
    parameters: Readonly<Record<string, GenericSqlParameterValue>>,
    dataset: string,
  ): Promise<GenericSqlRow[]>;
  close?(): Promise<void>;
}

export type GenericSqlConnectorFactory = (
  connection: GenericSqlConnectionDefinition,
  source: GenericSqlSourceDefinition,
) => Promise<GenericSqlClient>;

export interface GenericSqlAssetGroup {
  assets: GenericSqlAsset[];
  roots: string[];
  quads: GenericSqlQuad[];
}

type RowsByDataset = Record<string, GenericSqlRow[]>;

interface EntityInstance {
  entity: GenericSqlEntitySpec;
  id: string;
  dataset: string;
  row: GenericSqlRow;
}

const connectorFactories = new Map<string, GenericSqlConnectorFactory>([
  ['mssql', createMssqlClient],
  ['sqlite', createSqliteClient],
]);

export function registerGenericSqlConnector(dialect: string, factory: GenericSqlConnectorFactory): void {
  connectorFactories.set(dialect, factory);
}

export function unregisterGenericSqlConnector(dialect: string): void {
  if (dialect === 'mssql') {
    connectorFactories.set('mssql', createMssqlClient);
    return;
  }
  if (dialect === 'sqlite') {
    connectorFactories.set('sqlite', createSqliteClient);
    return;
  }
  connectorFactories.delete(dialect);
}

export const genericSqlSourceHandler: SourceKindHandler<GenericSqlSourceDefinition, GenericSqlAsset> = {
  async computeFingerprint(source: GenericSqlSourceDefinition): Promise<string> {
    return (await prepareGenericSqlSource(source)).fingerprint;
  },

  async prepare(source: GenericSqlSourceDefinition): Promise<GenericSqlPreparationResult> {
    return prepareGenericSqlSource(source);
  },
};

export async function prepareGenericSqlSource(source: GenericSqlSourceDefinition): Promise<GenericSqlPreparationResult> {
  const mapping = await loadGenericSqlMapping(source);
  validateGenericSqlMapping(source, mapping);
  const rowsByDataset = await readGenericSqlRows(source, mapping);
  const assets = buildGenericSqlAssets(mapping, rowsByDataset);
  const fingerprintMetadata = buildGenericSqlFingerprintMetadata(source, mapping, rowsByDataset, assets);
  const fingerprint = hashStable({
    mappingId: fingerprintMetadata.mappingId,
    mappingVersion: fingerprintMetadata.mappingVersion,
    mapperVersion: fingerprintMetadata.mapperVersion,
    sourceConfigFingerprint: fingerprintMetadata.sourceConfigFingerprint,
    globalFingerprint: fingerprintMetadata.globalFingerprint,
    partitions: fingerprintMetadata.partitions.map(({ key, fingerprint }) => ({ key, fingerprint })),
  });

  return {
    fingerprint,
    fingerprintMetadata,
    assets,
    warnings: [],
  };
}

export async function loadGenericSqlMapping(source: GenericSqlSourceDefinition): Promise<GenericSqlMappingSpec> {
  if (source.mapping) {
    return source.mapping;
  }
  if (!source.mappingFile) {
    throw new Error(`Generic SQL source ${source.id} must define mapping or mappingFile`);
  }
  return JSON.parse(await readFile(source.mappingFile, 'utf8')) as GenericSqlMappingSpec;
}

export function selectGenericSqlAssetGroupsForChangedPartitions(
  assets: readonly GenericSqlAsset[],
  current: GenericSqlFingerprintMetadata | undefined,
  prior: GenericSqlFingerprintMetadata | undefined,
): GenericSqlAssetGroup[] {
  if (!current || !prior || requiresFullPublish(current, prior)) {
    return allAssetsGroup(assets);
  }

  const priorPartitions = new Map(prior.partitions.map((partition) => [partition.key, partition]));
  const changed = current.partitions.filter((partition) => {
    return priorPartitions.get(partition.key)?.fingerprint !== partition.fingerprint;
  });
  if (changed.length === 0) {
    return [];
  }

  const assetsByRoot = new Map(assets.map((asset) => [asset.rootEntity, asset]));
  return changed.flatMap((partition) => {
    const partitionAssets = partition.rootEntities
      .map((root) => assetsByRoot.get(root))
      .filter((asset): asset is GenericSqlAsset => asset !== undefined);
    if (partitionAssets.length === 0) {
      return [];
    }
    return assetsToGroups(partitionAssets);
  });
}

function validateGenericSqlMapping(source: GenericSqlSourceDefinition, mapping: GenericSqlMappingSpec): void {
  if (!mapping.id) {
    throw new Error(`Generic SQL source ${source.id} mapping is missing id`);
  }
  if (!mapping.datasets || Object.keys(mapping.datasets).length === 0) {
    throw new Error(`Generic SQL source ${source.id} mapping ${mapping.id} must define at least one dataset`);
  }
  if (!mapping.entities?.length) {
    throw new Error(`Generic SQL source ${source.id} mapping ${mapping.id} must define at least one entity`);
  }

  const datasetNames = new Set(Object.keys(mapping.datasets));
  const entityNames = new Set<string>();
  for (const entity of mapping.entities) {
    if (!entity.name) {
      throw new Error(`Generic SQL source ${source.id} mapping ${mapping.id} has an entity without name`);
    }
    if (entityNames.has(entity.name)) {
      throw new Error(`Generic SQL source ${source.id} mapping ${mapping.id} has duplicate entity ${entity.name}`);
    }
    entityNames.add(entity.name);
    if (!datasetNames.has(entity.from)) {
      throw new Error(`Generic SQL source ${source.id} entity ${entity.name} references unknown dataset ${entity.from}`);
    }
    if (!entity.id) {
      throw new Error(`Generic SQL source ${source.id} entity ${entity.name} must define id`);
    }
  }

  for (const relation of mapping.relations ?? []) {
    if (!entityNames.has(relation.from)) {
      throw new Error(`Generic SQL source ${source.id} relation references unknown from entity ${relation.from}`);
    }
    if (!entityNames.has(relation.to)) {
      throw new Error(`Generic SQL source ${source.id} relation references unknown to entity ${relation.to}`);
    }
  }
}

async function readGenericSqlRows(source: GenericSqlSourceDefinition, mapping: GenericSqlMappingSpec): Promise<RowsByDataset> {
  const client = await createGenericSqlClient(source);
  try {
    const entries = await Promise.all(Object.entries(mapping.datasets).map(async ([dataset, spec]) => {
      const rows = await client.query(spec.query, source.parameters ?? {}, dataset);
      validateRequiredColumns(source.id, mapping.id, dataset, spec.requiredColumns ?? [], rows);
      return [dataset, rows.map(normalizeSqlRow)] as const;
    }));
    return Object.fromEntries(entries);
  } finally {
    await client.close?.();
  }
}

async function createGenericSqlClient(source: GenericSqlSourceDefinition): Promise<GenericSqlClient> {
  const dialect = source.connection?.dialect;
  if (!dialect) {
    throw new Error(`Generic SQL source ${source.id} connection must define dialect`);
  }
  const factory = connectorFactories.get(dialect);
  if (!factory) {
    throw new Error(`Generic SQL source ${source.id} uses unsupported SQL dialect ${dialect}`);
  }
  return factory(source.connection, source);
}

function validateRequiredColumns(
  sourceId: string,
  mappingId: string,
  dataset: string,
  requiredColumns: readonly string[],
  rows: readonly GenericSqlRow[],
): void {
  if (requiredColumns.length === 0 || rows.length === 0) {
    return;
  }
  const columns = new Set(rows.flatMap((row) => Object.keys(row)));
  const missing = requiredColumns.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(
      `Generic SQL source ${sourceId} mapping ${mappingId} dataset ${dataset} is missing required columns: ${missing.join(', ')}`,
    );
  }
}

function normalizeSqlRow(row: GenericSqlRow): GenericSqlRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeSqlValue(value)]));
}

function normalizeSqlValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }
  return value;
}

function buildGenericSqlAssets(mapping: GenericSqlMappingSpec, rowsByDataset: RowsByDataset): GenericSqlAsset[] {
  const assetsByRoot = new Map<string, GenericSqlQuad[]>();
  const instancesByEntity = new Map<string, EntityInstance[]>();

  for (const entity of mapping.entities) {
    const rows = rowsByDataset[entity.from] ?? [];
    const instances: EntityInstance[] = [];
    for (const row of rows) {
      const subject = renderTemplate(entity.id, row);
      if (!subject) {
        continue;
      }
      instances.push({ entity, id: subject, dataset: entity.from, row });
      addQuads(assetsByRoot, subject, buildEntityQuads(entity, subject, row));
    }
    instancesByEntity.set(entity.name, instances);
  }

  for (const relation of mapping.relations ?? []) {
    addRelationQuads(assetsByRoot, instancesByEntity, relation);
  }

  return [...assetsByRoot.entries()].map(([rootEntity, quads]) => ({ rootEntity, quads: uniqueQuads(quads) }));
}

function buildEntityQuads(entity: GenericSqlEntitySpec, subject: string, row: GenericSqlRow): GenericSqlQuad[] {
  const quads: GenericSqlQuad[] = [];
  for (const type of asArray(entity.type)) {
    const object = renderTemplate(type, row);
    if (object) {
      quads.push(quad(subject, RDF_TYPE, object));
    }
  }
  for (const [predicate, spec] of Object.entries(entity.properties ?? {})) {
    const object = resolvePropertyObject(spec, row);
    if (object) {
      quads.push(quad(subject, predicate, object));
    }
  }
  return quads;
}

function addRelationQuads(
  assetsByRoot: Map<string, GenericSqlQuad[]>,
  instancesByEntity: ReadonlyMap<string, EntityInstance[]>,
  relation: GenericSqlRelationSpec,
): void {
  const fromInstances = instancesByEntity.get(relation.from) ?? [];
  const toInstances = instancesByEntity.get(relation.to) ?? [];
  const left = parseQualifiedField(relation.join.left);
  const right = parseQualifiedField(relation.join.right);
  const toByJoinValue = new Map<string, EntityInstance[]>();

  for (const instance of toInstances) {
    if (right.dataset && right.dataset !== instance.dataset) {
      continue;
    }
    const value = stringifyRawValue(instance.row[right.field]);
    if (!value) {
      continue;
    }
    toByJoinValue.set(value, [...(toByJoinValue.get(value) ?? []), instance]);
  }

  for (const from of fromInstances) {
    if (left.dataset && left.dataset !== from.dataset) {
      continue;
    }
    const value = stringifyRawValue(from.row[left.field]);
    if (!value) {
      continue;
    }
    for (const to of toByJoinValue.get(value) ?? []) {
      addQuads(assetsByRoot, from.id, [quad(from.id, relation.predicate, to.id)]);
    }
  }
}

function resolvePropertyObject(spec: GenericSqlPropertySpec, row: GenericSqlRow): string | null {
  if (typeof spec === 'string') {
    const value = renderTemplate(spec, row);
    return value ? literal(value) : null;
  }

  if (spec.iri) {
    const iri = renderTemplate(spec.iri, row);
    return iri || null;
  }

  const value = resolvePropertyValue(spec, row);
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const normalized = stringifyRawValue(value);
  if (!normalized) {
    return null;
  }
  return spec.datatype ? typedLiteral(normalized, spec.datatype) : literal(normalized);
}

function resolvePropertyValue(spec: GenericSqlPropertyObjectSpec, row: GenericSqlRow): unknown {
  if (spec.transform) {
    return applyTransform(spec.transform, spec.args ?? [], row);
  }
  if (spec.value) {
    return renderTemplate(spec.value, row);
  }
  return null;
}

function applyTransform(name: string, args: readonly string[], row: GenericSqlRow): unknown {
  const values = args.map((arg) => resolveTemplateArgument(arg, row));
  switch (name) {
    case 'coalesce':
      return values.find((value) => stringifyRawValue(value).length > 0) ?? null;
    case 'combineDateTime':
      return combineDateTime(values[0], values[1], values[2]);
    case 'trim':
      return stringifyRawValue(values[0]).trim();
    case 'upper':
      return stringifyRawValue(values[0]).toUpperCase();
    case 'lower':
      return stringifyRawValue(values[0]).toLowerCase();
    default:
      throw new Error(`Unsupported generic SQL mapping transform: ${name}`);
  }
}

function combineDateTime(date: unknown, time: unknown, offset: unknown): string | null {
  const dateText = stringifyRawValue(date);
  if (!dateText) {
    return null;
  }
  const timeText = normalizeTime(stringifyRawValue(time));
  const offsetText = stringifyRawValue(offset) || 'Z';
  return `${dateText}T${timeText}${offsetText}`;
}

function normalizeTime(value: string): string {
  if (!value) {
    return '00:00:00';
  }
  if (/^\d{2}:\d{2}$/.test(value)) {
    return `${value}:00`;
  }
  return value;
}

function buildGenericSqlFingerprintMetadata(
  source: GenericSqlSourceDefinition,
  mapping: GenericSqlMappingSpec,
  rowsByDataset: RowsByDataset,
  assets: readonly GenericSqlAsset[],
): GenericSqlFingerprintMetadata {
  const mapperVersion = mapping.fingerprint?.mapperVersion ?? DEFAULT_MAPPER_VERSION;
  const partitionSpec = mapping.fingerprint?.partitionBy;
  const partitionDatasets = new Set(partitionSpec?.datasets ?? Object.keys(mapping.datasets));
  const globalDatasets = new Set(mapping.fingerprint?.globalDatasets ?? []);
  const rowsByPartition = new Map<string, Record<string, GenericSqlRow[]>>();

  if (!partitionSpec) {
    rowsByPartition.set('__all__', rowsByDataset);
  } else {
    for (const [dataset, rows] of Object.entries(rowsByDataset)) {
      if (!partitionDatasets.has(dataset)) {
        globalDatasets.add(dataset);
        continue;
      }
      for (const [rowIndex, row] of rows.entries()) {
        const key = stringifyRawValue(row[partitionSpec.field]);
        if (!key) {
          throw new Error(
            `Generic SQL source ${source.id} mapping ${mapping.id} dataset ${dataset} row ${rowIndex + 1} is missing partition key ${partitionSpec.field}`,
          );
        }
        const partition = rowsByPartition.get(key) ?? {};
        partition[dataset] = [...(partition[dataset] ?? []), row];
        rowsByPartition.set(key, partition);
      }
    }
  }

  const rootEntitiesByPartition = partitionSpec
    ? collectRootEntitiesByPartition(mapping, rowsByDataset, partitionSpec.field, assets)
    : new Map([['__all__', assets.map((asset) => asset.rootEntity)]]);

  const partitions: GenericSqlPartitionFingerprintMetadata[] = [...rowsByPartition.entries()]
    .map(([key, partitionRows]) => ({
      key,
      fingerprint: hashStable({ mapperVersion, key, rows: sortRowsByDataset(partitionRows) }),
      rootEntities: uniqueSorted(rootEntitiesByPartition.get(key) ?? []),
      rowCounts: Object.fromEntries(Object.entries(partitionRows).map(([dataset, rows]) => [dataset, rows.length])),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const globalRows = Object.fromEntries([...globalDatasets].map((dataset) => [dataset, rowsByDataset[dataset] ?? []]));
  return {
    kind: 'generic-sql-partitions',
    mappingId: mapping.id,
    mappingVersion: mapping.version,
    mapperVersion,
    sourceConfigFingerprint: hashStable(sourceFingerprintConfig(source, mapping)),
    globalFingerprint: hashStable(sortRowsByDataset(globalRows)),
    partitions,
  };
}

function collectRootEntitiesByPartition(
  mapping: GenericSqlMappingSpec,
  rowsByDataset: RowsByDataset,
  partitionField: string,
  assets: readonly GenericSqlAsset[],
): Map<string, string[]> {
  const assetRoots = new Set(assets.map((asset) => asset.rootEntity));
  const rootEntitiesByPartition = new Map<string, string[]>();
  for (const entity of mapping.entities) {
    for (const row of rowsByDataset[entity.from] ?? []) {
      const partitionKey = stringifyRawValue(row[partitionField]);
      if (!partitionKey) {
        continue;
      }
      const rootEntity = renderTemplate(entity.id, row);
      if (!rootEntity || !assetRoots.has(rootEntity)) {
        continue;
      }
      rootEntitiesByPartition.set(partitionKey, [...(rootEntitiesByPartition.get(partitionKey) ?? []), rootEntity]);
    }
  }
  return rootEntitiesByPartition;
}

function requiresFullPublish(current: GenericSqlFingerprintMetadata, prior: GenericSqlFingerprintMetadata): boolean {
  if (
    current.mappingId !== prior.mappingId
    || current.mappingVersion !== prior.mappingVersion
    || current.mapperVersion !== prior.mapperVersion
    || current.sourceConfigFingerprint !== prior.sourceConfigFingerprint
    || current.globalFingerprint !== prior.globalFingerprint
  ) {
    return true;
  }

  const currentKeys = new Set(current.partitions.map((partition) => partition.key));
  return prior.partitions.some((partition) => !currentKeys.has(partition.key));
}

function allAssetsGroup(assets: readonly GenericSqlAsset[]): GenericSqlAssetGroup[] {
  return assets.length === 0 ? [] : assetsToGroups(assets);
}

function assetsToGroups(assets: readonly GenericSqlAsset[]): GenericSqlAssetGroup[] {
  const roots = uniqueSorted(assets.map((asset) => asset.rootEntity));
  return [{
    assets: [...assets],
    roots,
    quads: uniqueQuads(assets.flatMap((asset) => asset.quads)),
  }];
}

function sourceFingerprintConfig(source: GenericSqlSourceDefinition, mapping: GenericSqlMappingSpec): Record<string, unknown> {
  return {
    id: source.id,
    kind: source.kind,
    dataset: source.dataset ?? null,
    connection: {
      dialect: source.connection.dialect,
      serverEnv: source.connection.serverEnv,
      hostEnv: source.connection.hostEnv,
      portEnv: source.connection.portEnv,
      databaseEnv: source.connection.databaseEnv,
      databasePath: source.connection.databasePath,
      databasePathEnv: source.connection.databasePathEnv,
      userEnv: source.connection.userEnv,
      passwordEnv: source.connection.passwordEnv,
      encrypt: source.connection.encrypt ?? null,
      trustServerCertificate: source.connection.trustServerCertificate ?? null,
      requestTimeoutMs: source.connection.requestTimeoutMs ?? null,
    },
    mappingId: mapping.id,
    mappingVersion: mapping.version,
    mappingDefinitionFingerprint: hashStable(mapping),
    parameters: source.parameters ?? {},
  };
}

async function createMssqlClient(
  connection: GenericSqlConnectionDefinition,
  source: GenericSqlSourceDefinition,
): Promise<GenericSqlClient> {
  const server = readRequiredEnv(source.id, 'server', connection.serverEnv ?? connection.hostEnv);
  const database = readRequiredEnv(source.id, 'database', connection.databaseEnv);
  const user = readRequiredEnv(source.id, 'user', connection.userEnv);
  const password = readRequiredEnv(source.id, 'password', connection.passwordEnv);
  const portValue = readOptionalEnv(connection.portEnv);
  const port = portValue ? Number(portValue) : undefined;
  if (portValue && (!Number.isInteger(port) || port! <= 0)) {
    throw new Error(`Generic SQL source ${source.id} has invalid SQL Server port in ${connection.portEnv}`);
  }

  let module: any;
  try {
    const moduleName = 'mssql';
    module = await import(moduleName);
  } catch (error) {
    throw new Error(
      `Generic SQL source ${source.id} requires optional package mssql for dialect mssql: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const pool = await new module.ConnectionPool({
    server,
    database,
    user,
    password,
    port,
    options: {
      encrypt: connection.encrypt ?? true,
      trustServerCertificate: connection.trustServerCertificate ?? false,
    },
    requestTimeout: connection.requestTimeoutMs ?? 30000,
  }).connect();

  return {
    async query(sql, parameters) {
      const request = pool.request();
      for (const [name, value] of Object.entries(parameters)) {
        if (Array.isArray(value)) {
          throw new Error(`Generic SQL source ${source.id} parameter ${name} is an array; expand list parameters in the configured query`);
        }
        request.input(name, value);
      }
      const result = await request.query(sql);
      return result.recordset ?? [];
    },
    async close() {
      await pool.close();
    },
  };
}

async function createSqliteClient(
  connection: GenericSqlConnectionDefinition,
  source: GenericSqlSourceDefinition,
): Promise<GenericSqlClient> {
  const databasePath = connection.databasePath ?? readOptionalEnv(connection.databasePathEnv ?? connection.databaseEnv);
  if (!databasePath) {
    throw new Error(`Generic SQL source ${source.id} sqlite connection must define databasePath or databasePathEnv`);
  }

  let module: any;
  try {
    const moduleName = 'node:sqlite';
    module = await import(moduleName);
  } catch (error) {
    throw new Error(
      `Generic SQL source ${source.id} requires Node runtime support for node:sqlite: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const database = new module.DatabaseSync(databasePath, { readOnly: true });
  return {
    async query(sql, parameters) {
      const statement = database.prepare(sql);
      const normalized = normalizeSqliteParameters(sql, parameters);
      const rows = Object.keys(normalized).length === 0 ? statement.all() : statement.all(normalized);
      return rows.map((row: GenericSqlRow) => ({ ...row }));
    },
    async close() {
      database.close();
    },
  };
}

function normalizeSqliteParameters(
  sql: string,
  parameters: Readonly<Record<string, GenericSqlParameterValue>>,
): Record<string, string | number | boolean | null> {
  const referencedParameters = new Set([...sql.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!));
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const [name, value] of Object.entries(parameters)) {
    if (!referencedParameters.has(name)) {
      continue;
    }
    if (Array.isArray(value)) {
      throw new Error(`Generic SQL sqlite parameter ${name} is an array; expand list parameters in the configured query`);
    }
    normalized[name] = value as string | number | boolean | null;
  }
  return normalized;
}

function readRequiredEnv(sourceId: string, label: string, envName: string | undefined): string {
  if (!envName) {
    throw new Error(`Generic SQL source ${sourceId} mssql connection must define ${label}Env`);
  }
  const value = process.env[envName];
  if (!value) {
    throw new Error(`Generic SQL source ${sourceId} requires environment variable ${envName}`);
  }
  return value;
}

function readOptionalEnv(envName: string | undefined): string | undefined {
  return envName ? process.env[envName] : undefined;
}

function parseQualifiedField(value: string): { dataset?: string; field: string } {
  const [left, right] = value.split('.');
  return right ? { dataset: left, field: right } : { field: left };
}

function renderTemplate(template: string, row: GenericSqlRow): string {
  const rendered: string[] = [];
  let cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf('{', cursor);
    if (open === -1) {
      rendered.push(template.slice(cursor));
      break;
    }
    const close = template.indexOf('}', open + 1);
    if (close === -1) {
      rendered.push(template.slice(cursor));
      break;
    }

    rendered.push(template.slice(cursor, open));
    const field = template.slice(open + 1, close);
    rendered.push(field ? stringifyRawValue(row[field]) : template.slice(open, close + 1));
    cursor = close + 1;
  }
  return rendered.join('');
}

function resolveTemplateArgument(value: string, row: GenericSqlRow): unknown {
  const exact = exactTemplateField(value);
  return exact ? row[exact] : renderTemplate(value, row);
}

function exactTemplateField(value: string): string | null {
  if (!value.startsWith('{') || !value.endsWith('}') || value.length <= 2) {
    return null;
  }
  const close = value.indexOf('}', 1);
  if (close !== value.length - 1) {
    return null;
  }
  const field = value.slice(1, -1);
  return field || null;
}

function stringifyRawValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value).trim();
}

function addQuads(target: Map<string, GenericSqlQuad[]>, root: string, quads: readonly GenericSqlQuad[]): void {
  target.set(root, [...(target.get(root) ?? []), ...quads]);
}

function quad(subject: string, predicate: string, object: string): GenericSqlQuad {
  return { subject, predicate, object, graph: '' };
}

function literal(value: string): string {
  return JSON.stringify(value);
}

function typedLiteral(value: string, datatype: string): string {
  const iri = datatype.startsWith('http://') || datatype.startsWith('https://')
    ? datatype
    : `${XSD_NS}${datatype.replace(/^xsd:/, '')}`;
  return `${JSON.stringify(value)}^^<${iri}>`;
}

function asArray<T>(value: T | readonly T[] | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? [...(value as readonly T[])] : [value as T];
}

function sortRowsByDataset(rowsByDataset: RowsByDataset): RowsByDataset {
  return Object.fromEntries(
    Object.entries(rowsByDataset)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([dataset, rows]) => [dataset, sortRows(rows)]),
  );
}

function sortRows(rows: readonly GenericSqlRow[]): GenericSqlRow[] {
  return [...rows].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function uniqueQuads(quads: readonly GenericSqlQuad[]): GenericSqlQuad[] {
  const seen = new Set<string>();
  const unique: GenericSqlQuad[] = [];
  for (const entry of quads) {
    const normalized = { ...entry, graph: entry.graph ?? '' };
    const key = JSON.stringify(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(`${stableStringify(value)}\n`).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stabilize(value));
}

function stabilize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stabilize(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stabilize(entry)]),
    );
  }
  return value;
}
