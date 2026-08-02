import { readFileSync } from 'node:fs';

import {
  createRfc64SemanticSnapshot,
  type Rfc64KnowledgeAssetObservation,
} from '../_bootstrap/rfc64-evidence.ts';
import type {
  GraphObservationV1,
  GraphSnapshotExpectationV1,
  PlaneObservationV1,
} from './manifest.ts';

export const TESTNET_OPERATOR_CONFIG_SCHEMA =
  'dkg-rfc64-m1-testnet-operator-config-v1' as const;

export interface TestnetOperatorAssetV1 {
  readonly name: string;
  readonly subject: string;
  readonly ual: string;
  readonly wave: 'selected' | 'final';
}

export interface TestnetOperatorGraphV1 {
  readonly contextGraphId: string;
  readonly accessPolicy: 0 | 1;
  readonly publishPolicy: 0 | 1;
  readonly edgePolicy: 'always-on' | 'on-demand' | 'unselected';
  readonly assets: readonly TestnetOperatorAssetV1[];
}

export interface TestnetOperatorRoleV1 {
  readonly transport: 'local' | 'ssh';
  readonly apiUrl: string;
  readonly repoRoot: string;
  readonly dataDir: string;
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly authTokenFile?: string;
  readonly sshTarget?: string;
}

export interface TestnetOperatorConfigV1 {
  readonly schema: typeof TESTNET_OPERATOR_CONFIG_SCHEMA;
  readonly roles: Readonly<Record<'publisher' | 'edge' | 'core', TestnetOperatorRoleV1>>;
  readonly graphs: readonly TestnetOperatorGraphV1[];
  readonly pollIntervalMs: number;
  readonly operationTimeoutMs: number;
}

export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

export type SparqlBindingCell = string | {
  readonly value?: string;
  readonly datatype?: string;
  readonly type?: string;
  readonly 'xml:lang'?: string;
  readonly lang?: string;
};

export function readTestnetOperatorConfig(path: string): TestnetOperatorConfigV1 {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error('M1 testnet operator config is not valid JSON', { cause: error });
  }
  const root = record(input, 'operator config');
  assertExactKeys(root, ['schema', 'roles', 'graphs', 'pollIntervalMs', 'operationTimeoutMs'], 'operator config');
  if (root['schema'] !== TESTNET_OPERATOR_CONFIG_SCHEMA) {
    throw new TypeError('M1 testnet operator config schema is unsupported');
  }
  const rolesInput = record(root['roles'], 'operator roles');
  assertExactKeys(rolesInput, ['publisher', 'edge', 'core'], 'operator roles');
  const roles = {
    publisher: parseRole(rolesInput['publisher'], 'publisher'),
    edge: parseRole(rolesInput['edge'], 'edge'),
    core: parseRole(rolesInput['core'], 'core'),
  } as const;
  const graphsInput = array(root['graphs'], 'operator graphs');
  if (graphsInput.length !== 5) {
    throw new RangeError('M1 testnet operator config requires exactly five graphs');
  }
  const graphs = graphsInput.map((value, index): TestnetOperatorGraphV1 => {
    const row = record(value, `operator graph ${index}`);
    assertExactKeys(
      row,
      ['contextGraphId', 'accessPolicy', 'publishPolicy', 'edgePolicy', 'assets'],
      `operator graph ${index}`,
    );
    const accessPolicy = row['accessPolicy'];
    const publishPolicy = row['publishPolicy'];
    const edgePolicy = row['edgePolicy'];
    if ((accessPolicy !== 0 && accessPolicy !== 1)
      || (publishPolicy !== 0 && publishPolicy !== 1)
      || (edgePolicy !== 'always-on'
        && edgePolicy !== 'on-demand'
        && edgePolicy !== 'unselected')) {
      throw new TypeError(`operator graph ${index} has an invalid policy`);
    }
    const assets = array(row['assets'], `operator graph ${index} assets`)
      .map((asset, assetIndex): TestnetOperatorAssetV1 => {
        const item = record(asset, `operator graph ${index} asset ${assetIndex}`);
        assertExactKeys(item, ['name', 'subject', 'ual', 'wave'], `operator graph ${index} asset ${assetIndex}`);
        const wave = item['wave'];
        if (wave !== 'selected' && wave !== 'final') {
          throw new TypeError(`operator graph ${index} asset ${assetIndex} has an invalid wave`);
        }
        return {
          name: boundedText(item['name'], 'asset name'),
          subject: absoluteIri(item['subject'], 'asset subject'),
          ual: boundedText(item['ual'], 'asset UAL'),
          wave,
        };
      });
    if (assets.length !== 2
      || assets.filter((asset) => asset.wave === 'selected').length !== 1
      || assets.filter((asset) => asset.wave === 'final').length !== 1) {
      throw new RangeError(`operator graph ${index} requires one asset per wave`);
    }
    return {
      contextGraphId: boundedText(row['contextGraphId'], 'context graph ID'),
      accessPolicy,
      publishPolicy,
      edgePolicy,
      assets,
    };
  });
  const pollIntervalMs = positiveInteger(root['pollIntervalMs'], 'pollIntervalMs');
  const operationTimeoutMs = positiveInteger(root['operationTimeoutMs'], 'operationTimeoutMs');
  return Object.freeze({
    schema: TESTNET_OPERATOR_CONFIG_SCHEMA,
    roles: Object.freeze(roles),
    graphs: Object.freeze(graphs.map((graph) => Object.freeze({
      ...graph,
      assets: Object.freeze(graph.assets.map((asset) => Object.freeze({ ...asset }))),
    }))),
    pollIntervalMs,
    operationTimeoutMs,
  });
}

export async function requestJson(
  role: TestnetOperatorRoleV1,
  path: string,
  init: RequestInit = {},
): Promise<HttpResult> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (role.authTokenFile) {
    const token = readFileSync(role.authTokenFile, 'utf8').trim();
    if (!token) throw new Error(`empty node-admin token: ${role.authTokenFile}`);
    headers.set('authorization', `Bearer ${token}`);
  }
  const response = await fetch(`${role.apiUrl.replace(/\/$/u, '')}${path}`, {
    ...init,
    headers,
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: response.status, body };
}

export async function requireJson(
  role: TestnetOperatorRoleV1,
  path: string,
  init: RequestInit = {},
  accepted: readonly number[] = [200],
): Promise<Record<string, unknown>> {
  const result = await requestJson(role, path, init);
  if (!accepted.includes(result.status)) {
    throw new Error(
      `M1 node request failed ${result.status} ${path}: ${JSON.stringify(result.body).slice(0, 1_000)}`,
    );
  }
  return record(result.body, `response from ${path}`);
}

export async function observeGraph(
  role: TestnetOperatorRoleV1,
  graph: TestnetOperatorGraphV1,
): Promise<GraphObservationV1> {
  const [vm, swm] = await Promise.all([
    observePlane(role, graph, 'vm'),
    observePlane(role, graph, 'swm'),
  ]);
  return { contextGraphId: graph.contextGraphId, vm, swm };
}

export async function observeGraphSnapshot(
  role: TestnetOperatorRoleV1,
  graph: TestnetOperatorGraphV1,
): Promise<GraphSnapshotExpectationV1> {
  const observation = await observeGraph(role, graph);
  if (!observation.vm.reportedComplete || !observation.swm.reportedComplete
    || observation.vm.headDigest === null || observation.vm.inventoryDigest === null
    || observation.swm.headDigest === null || observation.swm.inventoryDigest === null) {
    throw new Error(`context graph ${graph.contextGraphId} is not complete on both planes`);
  }
  return {
    vm: {
      headDigest: observation.vm.headDigest,
      inventoryDigest: observation.vm.inventoryDigest,
      assetCount: observation.vm.assetCount,
      dataTripleCount: observation.vm.dataTripleCount,
    },
    swm: {
      headDigest: observation.swm.headDigest,
      inventoryDigest: observation.swm.inventoryDigest,
      assetCount: observation.swm.assetCount,
      dataTripleCount: observation.swm.dataTripleCount,
    },
  };
}

async function observePlane(
  role: TestnetOperatorRoleV1,
  graph: TestnetOperatorGraphV1,
  plane: 'vm' | 'swm',
): Promise<PlaneObservationV1> {
  const bindings = await queryBindings(role, {
    sparql: 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } ORDER BY ?s ?p ?o',
    contextGraphId: graph.contextGraphId,
    view: plane === 'vm' ? 'verifiable-memory' : 'shared-working-memory',
  });
  const assetBySubject = new Map(graph.assets.map((asset) => [asset.subject, asset]));
  const linesBySubject = new Map<string, string[]>();
  for (const binding of bindings) {
    const subject = iriBindingValue(binding['s'], 'subject');
    const asset = assetBySubject.get(subject);
    if (!asset) {
      throw new Error(
        `${plane.toUpperCase()} scope for ${graph.contextGraphId} contains an unplanned subject: ${subject}`,
      );
    }
    const predicate = bindingTerm(binding['p'], 'predicate');
    const object = bindingTerm(binding['o'], 'object');
    const lines = linesBySubject.get(subject) ?? [];
    lines.push(`<${subject}> ${predicate} ${object} .`);
    linesBySubject.set(subject, lines);
  }
  const observations: Rfc64KnowledgeAssetObservation[] = graph.assets.flatMap((asset) => {
    const lines = linesBySubject.get(asset.subject);
    return lines ? [{ ual: asset.ual, semanticNQuads: lines }] : [];
  });
  const snapshot = await createRfc64SemanticSnapshot(observations);
  const metadataTripleCount = await queryMetadataCount(role, graph.contextGraphId, plane);
  if (snapshot.kaCount === 0) {
    return {
      reportedComplete: false,
      headDigest: null,
      inventoryDigest: null,
      assetCount: 0,
      metadataTripleCount,
      dataTripleCount: 0,
    };
  }
  return {
    reportedComplete: true,
    headDigest: snapshot.ualsSha256,
    inventoryDigest: snapshot.semanticNQuadsSha256,
    assetCount: snapshot.kaCount,
    metadataTripleCount,
    dataTripleCount: snapshot.quadCount,
  };
}

async function queryMetadataCount(
  role: TestnetOperatorRoleV1,
  contextGraphId: string,
  plane: 'vm' | 'swm',
): Promise<number> {
  const graphIri = plane === 'vm'
    ? `did:dkg:context-graph:${contextGraphId}/_meta`
    : `did:dkg:context-graph:${contextGraphId}/_shared_memory_meta`;
  const bindings = await queryBindings(role, {
    sparql: `SELECT (COUNT(*) AS ?count) WHERE { GRAPH <${graphIri}> { ?s ?p ?o } }`,
    contextGraphId,
    includeContextGraphPartitions: true,
  });
  if (bindings.length !== 1) {
    throw new Error(`metadata count query returned ${bindings.length} rows for ${contextGraphId}`);
  }
  const raw = cellValue(bindings[0]!['count']);
  const match = /^(?:")?(\d+)/u.exec(raw);
  if (!match) throw new Error(`metadata count is malformed for ${contextGraphId}`);
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`metadata count is outside the safe integer range for ${contextGraphId}`);
  }
  return count;
}

async function queryBindings(
  role: TestnetOperatorRoleV1,
  body: Record<string, unknown>,
): Promise<Array<Record<string, SparqlBindingCell>>> {
  const response = await requireJson(role, '/api/query', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const result = record(response['result'], 'query result');
  const bindings = result['bindings'];
  if (!Array.isArray(bindings)) throw new TypeError('query result bindings are not an array');
  return bindings.map((binding, index) =>
    record(binding, `query binding ${index}`) as Record<string, SparqlBindingCell>);
}

function bindingTerm(cell: SparqlBindingCell | undefined, position: 'predicate' | 'object'): string {
  if (cell === undefined) throw new TypeError(`missing SPARQL ${position} binding`);
  if (typeof cell === 'string') {
    if (position === 'predicate' && /^<[^>]+>$/u.test(cell)) return cell;
    if (position === 'object' && (/^<[^>]+>$/u.test(cell)
      || /^_:[A-Za-z0-9._-]+$/u.test(cell)
      || /^"/u.test(cell))) return cell;
    if (position === 'predicate' && /^[a-z][a-z0-9+.-]*:/iu.test(cell)) return `<${cell}>`;
    throw new TypeError(`invalid SPARQL ${position} term`);
  }
  const value = cell.value;
  if (typeof value !== 'string') throw new TypeError(`missing SPARQL ${position} value`);
  if (cell.type === 'uri') return /^<[^>]+>$/u.test(value) ? value : `<${value}>`;
  if (cell.type === 'bnode') return value.startsWith('_:') ? value : `_:${value}`;
  if (position === 'predicate') {
    return /^<[^>]+>$/u.test(value) ? value : `<${value}>`;
  }
  const escaped = JSON.stringify(value);
  const language = cell['xml:lang'] ?? cell.lang;
  if (language) return `${escaped}@${language}`;
  if (cell.datatype && cell.datatype !== 'http://www.w3.org/2001/XMLSchema#string') {
    return `${escaped}^^<${cell.datatype}>`;
  }
  return escaped;
}

function iriBindingValue(cell: SparqlBindingCell | undefined, label: string): string {
  if (cell === undefined) throw new TypeError(`missing SPARQL ${label} binding`);
  const value = typeof cell === 'string' ? cell : cell.value;
  if (typeof value !== 'string') throw new TypeError(`missing SPARQL ${label} value`);
  const unwrapped = /^<([^>]+)>$/u.exec(value)?.[1] ?? value;
  return absoluteIri(unwrapped, `SPARQL ${label}`);
}

function cellValue(cell: SparqlBindingCell | undefined): string {
  if (typeof cell === 'string') return cell;
  return cell?.value ?? '';
}

function parseRole(value: unknown, name: string): TestnetOperatorRoleV1 {
  const row = record(value, `${name} role`);
  assertExactKeys(
    row,
    ['transport', 'apiUrl', 'repoRoot', 'dataDir', 'command', 'environment', 'authTokenFile', 'sshTarget'],
    `${name} role`,
    ['authTokenFile', 'sshTarget'],
  );
  const transport = row['transport'];
  if (transport !== 'local' && transport !== 'ssh') {
    throw new TypeError(`${name} role transport is invalid`);
  }
  const command = array(row['command'], `${name} command`).map((entry) =>
    boundedText(entry, `${name} command argument`));
  if (command.length < 1) throw new RangeError(`${name} command is empty`);
  const envInput = record(row['environment'], `${name} environment`);
  const environment: Record<string, string> = {};
  for (const [key, entry] of Object.entries(envInput)) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key)) throw new TypeError(`${name} environment key is invalid`);
    environment[key] = boundedText(entry, `${name} environment value`);
  }
  const sshTarget = row['sshTarget'] === undefined
    ? undefined
    : boundedText(row['sshTarget'], `${name} sshTarget`);
  if ((transport === 'ssh') !== (sshTarget !== undefined)) {
    throw new TypeError(`${name} ssh transport requires exactly one sshTarget`);
  }
  if (sshTarget !== undefined
    && (!/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9](?:[A-Za-z0-9.:-]*[A-Za-z0-9])?$/u.test(sshTarget)
      || sshTarget.startsWith('-'))) {
    throw new TypeError(`${name} sshTarget is invalid`);
  }
  return Object.freeze({
    transport,
    apiUrl: httpUrl(row['apiUrl'], `${name} apiUrl`),
    repoRoot: boundedText(row['repoRoot'], `${name} repoRoot`),
    dataDir: boundedText(row['dataDir'], `${name} dataDir`),
    command: Object.freeze(command),
    environment: Object.freeze(environment),
    ...(row['authTokenFile'] === undefined
      ? {}
      : { authTokenFile: boundedText(row['authTokenFile'], `${name} authTokenFile`) }),
    ...(sshTarget === undefined ? {} : { sshTarget }),
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !optionalSet.has(key) && !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new TypeError(
      `${label} has an invalid key set (missing=${missing.join(',') || 'none'}; unknown=${unknown.join(',') || 'none'})`,
    );
  }
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function absoluteIri(value: unknown, label: string): string {
  const text = boundedText(value, label);
  let parsed: URL;
  try { parsed = new URL(text); } catch (error) {
    throw new TypeError(`${label} must be an absolute IRI`, { cause: error });
  }
  if (!parsed.protocol) throw new TypeError(`${label} must be an absolute IRI`);
  return text;
}

function httpUrl(value: unknown, label: string): string {
  const text = absoluteIri(value, label);
  const parsed = new URL(text);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${label} must use http or https`);
  }
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
}
