import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  decodeWorkspaceEncryptionKey,
  workspaceAgentEncryptionKeyId,
} from '@origintrail-official/dkg-core';
import { formatCanonicalRdfLiteralTerm } from '../../packages/rdf-utils/src/index.js';
import {
  buildCharacterizationFixtureV1,
  characterizationSourceFromFixtureV1,
  type CharacterizationSourceV1,
  type CharacterizationFixtureV1,
  type RedactedProfileEvidenceV1,
  type RedactedProfileQuadV1,
} from './model.js';
import { deriveProfilePopulationV1 } from './population.js';
import {
  classifyProfileSubjectShapeV1,
  expectedProfileLinkPredicateV1,
  findProfileSubjectOwnerV1,
  isAllowedProfilePredicateV1,
  profileNestedQueryPrefixesV1,
  redactProfileSubjectV1,
} from './subjects.js';

const AGENTS_GRAPH = 'did:dkg:context-graph:agents';
const PEER_ID = 'https://dkg.network/ontology#peerId';
const LAST_SEEN = 'https://dkg.network/ontology#lastSeen';
const PUBLIC_ENCRYPTION_KEY = 'https://dkg.network/ontology#publicEncryptionKey';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DKG_AGENT = 'https://dkg.network/ontology#Agent';
const DEFAULT_COMMIT = 'c297a7b6ffb6df82305c1f7eb76864a8b7a77c35';
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface SparqlTerm {
  readonly type: 'uri' | 'literal' | 'bnode';
  readonly value: string;
  readonly datatype?: string;
  readonly 'xml:lang'?: string;
}

export type SparqlRow = Readonly<Record<string, SparqlTerm>>;

interface ExtractOptions {
  readonly endpoint: URL;
  readonly output: string;
  readonly observationTime: string;
  readonly sourceCommit: string;
  readonly systemSyncPath: string;
  readonly sourceOutput?: string;
}

interface SanitizedSystemSyncInputV1 {
  readonly schemaVersion: 1;
  readonly captureStartedAt: string;
  readonly captureEndedAt: string;
  readonly diagnosticsArtifactSha256: string;
  readonly sourceUrls: readonly string[];
  readonly observations: CharacterizationFixtureV1['systemSync'];
}

export interface PopulationRecord {
  readonly root: string;
  readonly peers: Set<string>;
  readonly lastSeen: string[];
}

export async function extractR27Fixture(options: ExtractOptions): Promise<CharacterizationFixtureV1> {
  assertLocalEndpoint(options.endpoint);
  assertFullSha(options.sourceCommit);
  const observationMs = Date.parse(options.observationTime);
  if (!Number.isFinite(observationMs)) throw new TypeError('observationTime must be an ISO timestamp');
  const cutoff = new Date(observationMs - STALE_THRESHOLD_MS).toISOString();

  const populationQuery = `
SELECT ?root ?peer ?seen WHERE {
  GRAPH <${AGENTS_GRAPH}> {
    ?root <${RDF_TYPE}> <${DKG_AGENT}> .
    OPTIONAL { ?root <${PEER_ID}> ?peer }
    OPTIONAL { ?root <${LAST_SEEN}> ?seen }
  }
}
ORDER BY ?root ?peer ?seen`.trim();
  const populationRows = await select(options.endpoint, populationQuery);
  const population = collectPopulation(populationRows);
  const peerAliases = new Map(
    [...new Set([...population.values()].flatMap((record) => [...record.peers]))]
      .sort()
      .map((peer, index) => [peer, `peer:${String(index + 1).padStart(4, '0')}`]),
  );
  const activeRoots = [...population.values()]
    .filter((record) => newestTimestamp(record.lastSeen) >= Date.parse(cutoff))
    .map((record) => record.root)
    .sort();

  const detailPlans = valuesBatches(activeRoots, 256).map((roots) => ({
    roots,
    rootQuery: `
SELECT ?root ?s ?p ?o WHERE {
  VALUES ?root { ${roots.map((root) => `<${escapeIri(root)}>`).join(' ')} }
  GRAPH <${AGENTS_GRAPH}> { ?root ?p ?o . BIND(?root AS ?s) }
}
ORDER BY ?root ?s ?p ?o`.trim(),
    nestedQuery: `
SELECT ?s ?p ?o WHERE {
  GRAPH <${AGENTS_GRAPH}> {
    ?s ?p ?o .
    FILTER(${roots.flatMap((root) => profileNestedQueryPrefixesV1(root).map(
      (prefix) => `STRSTARTS(STR(?s), "${escapeSparqlString(prefix)}")`,
    )).join(' || ')})
  }
}
ORDER BY ?s ?p ?o`.trim(),
  }));
  const detailRows = (
    await Promise.all(detailPlans.map(async (plan) => {
      const [rootRows, nestedRows] = await Promise.all([
        select(options.endpoint, plan.rootQuery),
        select(options.endpoint, plan.nestedQuery),
      ]);
      return [
        ...rootRows.map((row) => assertProfileEvidenceRow(requiredTerm(row, 'root').value, row)),
        ...nestedRows.map((row) => {
          const subject = requiredTerm(row, 's').value;
          const root = findProfileSubjectOwnerV1(plan.roots, subject);
          if (!root) throw new Error('nested profile subject is outside the frozen owned grammar');
          return assertProfileEvidenceRow(root, {
            ...row,
            root: { type: 'uri' as const, value: root },
          });
        }),
      ];
    }))
  ).flat();
  const peerToRoots = buildPeerToRoots(population);
  const profiles = buildProfiles(population, detailRows, activeRoots, peerAliases, peerToRoots, observationMs);
  const detailInputLines = detailRows.map((row) => rowToNQuad(row)).sort();
  const populationInputLines = populationRows.map(rowToPopulationLine).sort();
  const systemSyncInput = parseSystemSyncInput(
    JSON.parse(await readFile(options.systemSyncPath, 'utf8')) as unknown,
  );
  const systemSync = systemSyncInput.observations;
  const cutoffMs = Date.parse(cutoff);
  const profilePopulation = deriveProfilePopulationV1(
    [...population.values()].map((record) => {
      const newest = newestTimestamp(record.lastSeen);
      return {
        root: record.root,
        peerKeys: [...record.peers],
        freshness: newest === Number.NEGATIVE_INFINITY
          ? 'unknown' as const
          : newest >= cutoffMs
            ? 'active' as const
            : 'stale' as const,
      };
    }),
    profiles,
  );
  const loadMeasurement: CharacterizationFixtureV1['loadMeasurement'] = {
    serviceRecordsPerMinuteP10: null,
    serviceBytesPerMinuteP10: null,
    arrivalRecordsPerMinuteP99: null,
    arrivalBytesPerMinuteP99: null,
    backlogSlope: null,
  };
  const source: CharacterizationSourceV1 = {
    schemaVersion: 1,
    fixtureId: 'r27-v1',
    provenance: {
      sourceCommit: options.sourceCommit,
      network: 'DKG V10 Base Testnet',
      captureStartedAt: systemSyncInput.captureStartedAt,
      captureEndedAt: systemSyncInput.captureEndedAt,
      observationTime: options.observationTime,
      profileSnapshotKind: 'post-run stopped-node Oxigraph copy',
      sourceUrls: systemSyncInput.sourceUrls,
      extractionQuerySha256: sha256Text(
        `${populationQuery}\n---\n${detailPlans.flatMap((plan) => [plan.rootQuery, plan.nestedQuery]).join('\n---\n')}`,
      ),
      populationInputSha256: sha256Text(populationInputLines.join('\n')),
      detailInputSha256: sha256Text(detailInputLines.join('\n')),
      diagnosticsArtifactSha256: systemSyncInput.diagnosticsArtifactSha256,
      redactionPolicy: 'V1: wallet roots and peer IDs replaced by deterministic fixture-local ordinal aliases; only exact allowlisted profile subject shapes and predicates retained; unknown nested subjects/predicates rejected before serialization; literal values omitted but UTF-8 byte lengths retained; no tokens, keys, multiaddrs, names, raw peer IDs, or hashes of peer IDs stored',
      agentsMetaExcluded: true,
    },
    staleThresholdMs: STALE_THRESHOLD_MS,
    systemSync,
    profilePopulation,
    profiles,
    loadMeasurement,
  };
  return buildCharacterizationFixtureV1(source);
}

function buildProfiles(
  population: ReadonlyMap<string, PopulationRecord>,
  rows: readonly SparqlRow[],
  activeRoots: readonly string[],
  peerAliases: ReadonlyMap<string, string>,
  peerToRoots: ReadonlyMap<string, ReadonlySet<string>>,
  observationMs: number,
): RedactedProfileEvidenceV1[] {
  const rowsByRoot = new Map<string, SparqlRow[]>();
  for (const row of rows) {
    const root = requiredTerm(row, 'root').value;
    const grouped = rowsByRoot.get(root) ?? [];
    grouped.push(row);
    rowsByRoot.set(root, grouped);
  }

  const profiles: RedactedProfileEvidenceV1[] = [];
  let ordinal = 0;
  for (const root of activeRoots) {
    const record = population.get(root);
    if (!record) throw new Error(`active root missing from population: ${root}`);
    const rootRows = [...new Map(
      (rowsByRoot.get(root) ?? []).map((row) => [rowToNQuad(row), row] as const),
    ).values()];
    if (rootRows.length === 0 || !rootRows.some((row) => requiredTerm(row, 's').value === root)) {
      throw new Error('active root has no exact root projection rows');
    }
    ordinal += 1;
    const peerKeys = [...record.peers]
      .sort()
      .map((peer) => {
        const alias = peerAliases.get(peer);
        if (!alias) throw new Error('active peer missing fixture-local alias');
        return alias;
      })
      .sort();
    const disposition = classifyProfileDisposition(record, peerToRoots);
    const redactedRoot = `did:dkg:agent:0x${ordinal.toString(16).padStart(40, '0')}`;
      const subjectMap = new Map<string, string>();
      const redactSubject = (subject: string) => {
        const existing = subjectMap.get(subject);
        if (existing) return existing;
        const redacted = redactProfileSubjectV1(root, redactedRoot, subject);
        subjectMap.set(subject, redacted);
        return redacted;
      };
      const linkedSubjects = new Set<string>();
      const derivedSubjects = new Set<string>();
      for (const row of rootRows) {
        const subject = requiredTerm(row, 's');
        const predicate = requiredTerm(row, 'p');
        const object = requiredTerm(row, 'o');
        if (subject.value !== root || predicate.value !== PUBLIC_ENCRYPTION_KEY || object.type !== 'literal') {
          continue;
        }
        const address = /^did:dkg:agent:(0x[0-9a-fA-F]{40})$/.exec(root)?.[1];
        if (!address) continue;
        try {
          const keyId = workspaceAgentEncryptionKeyId(
            address,
            decodeWorkspaceEncryptionKey(object.value),
          );
          derivedSubjects.add(redactSubject(keyId));
        } catch {
          // Malformed legacy key material stays non-derived and fails closed if referenced.
        }
      }
      const quadShapes: RedactedProfileQuadV1[] = [];
      const nquads: string[] = [];
      for (const row of rootRows) {
        const subject = requiredTerm(row, 's');
        const predicate = requiredTerm(row, 'p');
        const object = requiredTerm(row, 'o');
        const redactedSubject = redactSubject(subject.value);
        const linkedKind = object.type === 'uri'
          ? classifyProfileSubjectShapeV1(root, object.value)
          : null;
        if (
          subject.value === root &&
          object.type === 'uri' &&
          linkedKind !== null && linkedKind !== 'root' && linkedKind !== 'x25519' &&
          expectedProfileLinkPredicateV1(linkedKind) === predicate.value
        ) {
          linkedSubjects.add(redactSubject(object.value));
        }
        const objectTerm = sparqlObjectToDkgTerm(object);
        quadShapes.push({
          subject: redactedSubject,
          predicate: predicate.value,
          objectKind: object.type === 'uri' ? 'iri' : 'literal',
          objectBytes: Buffer.byteLength(objectTerm),
          objectOwnedSubject: object.type === 'uri'
            && classifyProfileSubjectShapeV1(root, object.value) !== null
            && object.value !== root
            ? redactSubject(object.value)
            : null,
        });
        nquads.push(rowToNQuad(row));
      }
      profiles.push({
        recordId: `record:${String(ordinal).padStart(4, '0')}`,
        peerKeys,
        rootSubject: redactedRoot,
        disposition,
        sourceRootShape: /^did:dkg:agent:0x[0-9a-f]{40}$/.test(root)
          ? 'canonical-wallet'
          : root.startsWith('did:dkg:agent:')
            ? 'legacy-peer'
            : 'invalid',
        lastSeenAgeBucket: ageBucket(newestTimestamp(record.lastSeen), observationMs),
        authorityKind: 'unknown',
        capability: 'unsupported',
        linkedSubjects: [...linkedSubjects].sort(),
        derivedSubjects: [...derivedSubjects].sort(),
        quads: quadShapes,
        nquadsBytes: Buffer.byteLength(nquads.sort().join('\n')),
        bundleBytes: null,
      });
  }
  return profiles;
}

export function collectPopulation(rows: readonly SparqlRow[]): Map<string, PopulationRecord> {
  const result = new Map<string, PopulationRecord>();
  for (const row of rows) {
    const root = requiredTerm(row, 'root').value;
    const record = result.get(root) ?? { root, peers: new Set<string>(), lastSeen: [] };
    const peer = row.peer?.value;
    if (peer) record.peers.add(peer);
    const seen = row.seen?.value;
    if (seen && Number.isFinite(Date.parse(seen)) && !record.lastSeen.includes(seen)) {
      record.lastSeen.push(seen);
    }
    result.set(root, record);
  }
  return result;
}

export function classifyProfileDisposition(
  record: PopulationRecord,
  peerToRoots: ReadonlyMap<string, ReadonlySet<string>>,
): RedactedProfileEvidenceV1['disposition'] {
  if (record.peers.size === 0) return 'missing-peer';
  if (record.peers.size > 1) return 'multi-peer-root';
  return (peerToRoots.get([...record.peers][0])?.size ?? 0) > 1
    ? 'peer-multi-root'
    : 'candidate';
}

function buildPeerToRoots(
  population: ReadonlyMap<string, PopulationRecord>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const record of population.values()) {
    for (const peer of record.peers) {
      const roots = result.get(peer) ?? new Set<string>();
      roots.add(record.root);
      result.set(peer, roots);
    }
  }
  return result;
}

function ageBucket(lastSeenMs: number, observationMs: number): RedactedProfileEvidenceV1['lastSeenAgeBucket'] {
  const ageHours = Math.max(0, observationMs - lastSeenMs) / (60 * 60 * 1000);
  if (ageHours < 1) return 'under-1h';
  if (ageHours < 6) return '1-6h';
  return '6-24h';
}

export function valuesBatches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function assertProfileEvidenceRow(root: string, row: SparqlRow): SparqlRow {
  const subject = requiredTerm(row, 's');
  const predicate = requiredTerm(row, 'p');
  const object = requiredTerm(row, 'o');
  if (subject.type !== 'uri' || predicate.type !== 'uri' || object.type === 'bnode') {
    throw new TypeError('profile evidence row contains a non-IRI subject/predicate or blank node');
  }
  const kind = classifyProfileSubjectShapeV1(root, subject.value);
  if (kind === null) throw new TypeError('profile subject is outside the frozen owned grammar');
  if (!isAllowedProfilePredicateV1(kind, predicate.value)) {
    throw new TypeError('profile predicate is outside the frozen allowlist');
  }
  return row;
}

function rowToPopulationLine(row: SparqlRow): string {
  const root = requiredTerm(row, 'root');
  const peer = row.peer;
  const seen = row.seen;
  return JSON.stringify({
    root: [root.type, root.value],
    peer: peer ? [peer.type, peer.value] : null,
    seen: seen ? [seen.type, seen.value, seen.datatype ?? null, seen['xml:lang'] ?? null] : null,
  });
}

function parseSystemSyncInput(value: unknown): SanitizedSystemSyncInputV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('system sync input must be an object');
  }
  const input = value as Partial<SanitizedSystemSyncInputV1>;
  if (input.schemaVersion !== 1 || !Array.isArray(input.observations)) {
    throw new TypeError('system sync input must be schema V1 with observations');
  }
  if (
    typeof input.captureStartedAt !== 'string'
    || typeof input.captureEndedAt !== 'string'
    || !Number.isFinite(Date.parse(input.captureStartedAt))
    || !Number.isFinite(Date.parse(input.captureEndedAt))
    || Date.parse(input.captureStartedAt) > Date.parse(input.captureEndedAt)
  ) {
    throw new TypeError('system sync input capture bounds are invalid');
  }
  if (
    typeof input.diagnosticsArtifactSha256 !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(input.diagnosticsArtifactSha256)
  ) {
    throw new TypeError('system sync diagnostics digest is invalid');
  }
  if (!Array.isArray(input.sourceUrls) || input.sourceUrls.some((url) => typeof url !== 'string')) {
    throw new TypeError('system sync sourceUrls must be strings');
  }
  return input as SanitizedSystemSyncInputV1;
}

export function rowToNQuad(row: SparqlRow): string {
  const subject = requiredTerm(row, 's');
  const predicate = requiredTerm(row, 'p');
  const object = requiredTerm(row, 'o');
  if (subject.type !== 'uri') throw new TypeError('profile subject must be an IRI');
  if (predicate.type !== 'uri') throw new TypeError('profile predicate must be an IRI');
  if (object.type === 'bnode') throw new TypeError('profile object must not be a blank node');
  const subjectTerm = `<${escapeIri(subject.value)}>`;
  const objectTerm = object.type === 'uri'
    ? `<${escapeIri(object.value)}>`
    : sparqlObjectToDkgTerm(object);
  return `${subjectTerm} <${escapeIri(predicate.value)}> ${objectTerm} <${AGENTS_GRAPH}> .`;
}

function sparqlObjectToDkgTerm(term: SparqlTerm): string {
  if (term.type === 'uri') return term.value;
  if (term.type === 'bnode') return `_:${term.value}`;
  const language = term['xml:lang'];
  if (language) return formatCanonicalRdfLiteralTerm({ kind: 'language', value: term.value, language });
  if (term.datatype) {
    return formatCanonicalRdfLiteralTerm({ kind: 'typed', value: term.value, datatype: term.datatype });
  }
  return formatCanonicalRdfLiteralTerm({ kind: 'plain', value: term.value });
}

async function select(endpoint: URL, query: string): Promise<SparqlRow[]> {
  const url = new URL('/query', endpoint);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/sparql-results+json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ query }),
  });
  if (!response.ok) throw new Error(`SPARQL query failed with HTTP ${response.status}`);
  const body = await response.json() as {
    readonly results?: { readonly bindings?: readonly SparqlRow[] };
  };
  if (!Array.isArray(body.results?.bindings)) throw new TypeError('SPARQL response has no bindings');
  return [...body.results.bindings];
}

function requiredTerm(row: SparqlRow, key: string): SparqlTerm {
  const term = row[key];
  if (!term) throw new TypeError(`SPARQL row is missing ${key}`);
  return term;
}

function newestTimestamp(values: readonly string[]): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) newest = Math.max(newest, parsed);
  }
  return newest;
}

function sha256Text(value: string): string {
  return `sha256:${sha256Hex(value)}`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function escapeIri(value: string): string {
  if (/[<>"{}|^`\\\u0000-\u0020]/.test(value)) throw new TypeError('unsafe IRI in profile root');
  return value;
}

function escapeSparqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function assertLocalEndpoint(endpoint: URL): void {
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname)) {
    throw new TypeError('extractor accepts only an unauthenticated local HTTP endpoint');
  }
}

function assertFullSha(value: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new TypeError('source commit must be a full SHA');
}

function parseArgs(argv: readonly string[]): ExtractOptions {
  let endpoint = new URL('http://127.0.0.1:17880');
  let output = resolve('devnet/issue-2052-system-records/fixtures/r27-v1.json');
  let observationTime: string | undefined;
  let sourceCommit = DEFAULT_COMMIT;
  let systemSyncPath = resolve('devnet/issue-2052-system-records/inputs/r27-system-sync-v1.json');
  let sourceOutput: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!value) throw new TypeError(`${arg} requires a value`);
    if (arg === '--endpoint') endpoint = new URL(value);
    else if (arg === '--output') output = resolve(value);
    else if (arg === '--observation-time') observationTime = value;
    else if (arg === '--source-commit') sourceCommit = value;
    else if (arg === '--system-sync-input') systemSyncPath = resolve(value);
    else if (arg === '--source-output') sourceOutput = resolve(value);
    else throw new TypeError(`unknown argument: ${arg}`);
    index += 1;
  }
  if (!observationTime) throw new TypeError('--observation-time is required');
  return { endpoint, output, observationTime, sourceCommit, systemSyncPath, sourceOutput };
}

if (process.argv[1]?.endsWith('extract-rdf.ts')) {
  const options = parseArgs(process.argv.slice(2));
  extractR27Fixture(options)
    .then(async (fixture) => {
      await mkdir(dirname(options.output), { recursive: true });
      if (options.sourceOutput) {
        await mkdir(dirname(options.sourceOutput), { recursive: true });
        await writeFile(
          options.sourceOutput,
          `${JSON.stringify(characterizationSourceFromFixtureV1(fixture), null, 2)}\n`,
          'utf8',
        );
      }
      await writeFile(options.output, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
      process.stdout.write(
        `Wrote redacted fixture: ${options.output}\n` +
        `Profiles: ${fixture.profilePopulation.activeProfiles} active / ${fixture.profilePopulation.observedRoots} observed\n` +
        `Manifest digest: ${fixture.provenance.manifestSha256}\n`,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(`fixture extraction failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
