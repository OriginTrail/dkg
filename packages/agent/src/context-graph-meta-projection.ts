// SPDX-License-Identifier: Apache-2.0

import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  assertSafeIri,
  contextGraphCatalogUri,
  contextGraphDataGraphUri,
  contextGraphDataUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import type { Quad, QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';
import { strip, stripLiteral } from './dkg-agent-utils.js';

export interface ContextGraphSubGraphMeta {
  uri: string;
  name: string;
  createdBy: string;
  createdAt?: string;
  description?: string;
}

export interface ContextGraphDelegationMeta {
  uri: string;
  agents: string[];
  allowedPeers: string[];
  allowedKeys: string[];
  expiresAtValues: string[];
}

export interface ContextGraphMetaRecord {
  id: string;
  uri: string;
  declared: boolean;
  isSystem: boolean;
  name?: string;
  description?: string;
  creator?: string;
  creators: string[];
  curator?: string;
  curators: string[];
  accessPolicy?: string;
  createdAt?: string;
  allowedPeers: string[];
  allowedAgents: string[];
  participantAgents: string[];
  participantIdentityIds: string[];
  revokedAgents: string[];
  delegations: ContextGraphDelegationMeta[];
  onChainId?: string;
  subGraphs: ContextGraphSubGraphMeta[];
  hasAgentGate: boolean;
  hasPeerGate: boolean;
  hasLegacyParticipantGate: boolean;
}

interface ProjectionEntry {
  value?: ContextGraphMetaRecord;
  inflight?: Promise<ContextGraphMetaRecord>;
  dirty: boolean;
  invalidationVersion: number;
}

const DKG_NS = 'https://dkg.network/ontology#';
const LEGACY_DKG_NS = 'http://dkg.io/ontology/';
const LEGACY_SCHEMA_NS = 'http://schema.org/';
const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';

const SUB_GRAPH_TYPE_URIS = new Set([
  `${DKG_NS}SubGraph`,
  `${LEGACY_DKG_NS}SubGraph`,
]);

const DIRECT_META_PREDICATES = new Set([
  DKG_ONTOLOGY.RDF_TYPE,
  DKG_ONTOLOGY.SCHEMA_NAME,
  `${LEGACY_SCHEMA_NS}name`,
  DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
  `${LEGACY_SCHEMA_NS}description`,
  DKG_ONTOLOGY.DKG_CREATOR,
  DKG_ONTOLOGY.DKG_CURATOR,
  DKG_ONTOLOGY.DKG_CREATED_AT,
  DKG_ONTOLOGY.DKG_ACCESS_POLICY,
  DKG_ONTOLOGY.DKG_ALLOWED_PEER,
  DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
  DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT,
  DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID,
  DKG_ONTOLOGY.DKG_REVOKED_AGENT,
  DKG_ONTOLOGY.DKG_REGISTRATION_STATUS,
  DKG_ONTOLOGY.DKG_PUBLISH_POLICY,
  DKG_ONTOLOGY.DKG_PUBLISH_AUTHORITY_ACCOUNT_ID,
  `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
  `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainHash`,
]);

const SUB_GRAPH_META_PREDICATES = new Set([
  DKG_ONTOLOGY.RDF_TYPE,
  DKG_ONTOLOGY.SCHEMA_NAME,
  `${LEGACY_SCHEMA_NS}name`,
  DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
  `${LEGACY_SCHEMA_NS}description`,
  `${DKG_NS}parentContextGraph`,
  `${LEGACY_DKG_NS}parentContextGraph`,
  `${DKG_NS}createdBy`,
  `${LEGACY_DKG_NS}createdBy`,
  `${DKG_NS}createdAt`,
  `${LEGACY_DKG_NS}createdAt`,
  `${DKG_NS}authorizedWriter`,
  `${LEGACY_DKG_NS}authorizedWriter`,
]);

const DELEGATION_META_PREDICATES = new Set<string>([
  DKG_ONTOLOGY.DKG_DELEGATION_AGENT,
  DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER,
  DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY,
  DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT,
]);

// OT-RFC-49 §5.9: the public `_catalog` graph is a CG's discoverable face and may
// be fetched from an UNTRUSTED peer. Only the disclosure-floor predicates that
// have an authz-free home in the record are honoured from it — `rdf:type`
// (existence + the `dkg:PrivateContextGraph` class) and `dct:accessRights`
// (RESTRICTED ⇒ private). The catalog source is filtered to this set before
// `applyFact`, so a hostile catalog can NEVER feed the authorization-bearing
// creator/curator/allowlist fields.
const CATALOG_META_PREDICATES = new Set<string>([
  DKG_ONTOLOGY.RDF_TYPE,
  DKG_ONTOLOGY.DCT_ACCESS_RIGHTS,
]);

export class ContextGraphMetaProjection {
  private readonly entries = new Map<string, ProjectionEntry>();

  constructor(private readonly store: TripleStore) {}

  async get(contextGraphId: string, options: QueryOptions = {}): Promise<ContextGraphMetaRecord> {
    const existing = this.entries.get(contextGraphId);
    if (existing?.value && !existing.dirty) return cloneMetaRecord(existing.value);
    if (existing?.inflight) {
      if (!existing.dirty) return cloneMetaRecord(await raceAgainstAbort(existing.inflight, options.signal));
      await raceAgainstAbort(existing.inflight, options.signal);
      return this.get(contextGraphId, options);
    }

    const entry = existing ?? { dirty: true, invalidationVersion: 0 };
    const rebuildVersion = entry.invalidationVersion;
    entry.dirty = false;
    const rebuildOptions = options.source ? { source: options.source } : {};
    const inflight = this.rebuild(contextGraphId, rebuildOptions)
      .then((record) => {
        entry.value = record;
        entry.inflight = undefined;
        entry.dirty = entry.invalidationVersion !== rebuildVersion;
        this.entries.set(contextGraphId, entry);
        return record;
      })
      .catch((err) => {
        entry.inflight = undefined;
        entry.dirty = true;
        this.entries.set(contextGraphId, entry);
        throw err;
      });

    entry.inflight = inflight;
    this.entries.set(contextGraphId, entry);
    return cloneMetaRecord(await raceAgainstAbort(inflight, options.signal));
  }

  markDirty(contextGraphId: string): void {
    const existing = this.entries.get(contextGraphId);
    if (existing) {
      existing.dirty = true;
      existing.invalidationVersion += 1;
      return;
    }
    this.entries.set(contextGraphId, { dirty: true, invalidationVersion: 1 });
  }

  /**
   * #1863 — dirty the projection for the context graph a single-graph destructive
   * mutation (e.g. `replaceSubject`) targets, derived from the GRAPH itself, not
   * from the mutation's inserted quads. A subject replace can DELETE
   * projection-relevant metadata or replace it with non-relevant/empty rows, so
   * keying off the inserted quads alone (`markDirtyFromQuads`) misses the delete.
   * Keying off the target graph covers both insert and delete, with no whole-cache
   * churn. No-op when the graph is not a CG meta/catalog graph (e.g. the publisher
   * control-plane graph), so hot-path job writes never dirty the projection.
   */
  markDirtyForGraph(graphUri: string): void {
    const contextGraphId =
      contextGraphIdFromMetaGraphUri(graphUri) ?? contextGraphIdFromCatalogGraphUri(graphUri);
    if (contextGraphId) this.markDirty(contextGraphId);
  }

  markAllDirty(): void {
    for (const entry of this.entries.values()) {
      entry.dirty = true;
      entry.invalidationVersion += 1;
    }
  }

  markDirtyFromQuads(quads: readonly Quad[]): string[] {
    const touched = new Set<string>();
    for (const quad of quads) {
      const contextGraphId = this.contextGraphIdTouchedByQuad(quad);
      if (!contextGraphId) continue;
      touched.add(contextGraphId);
      this.markDirty(contextGraphId);
    }
    return [...touched];
  }

  async listDeclaredContextGraphIds(options: QueryOptions = {}): Promise<string[]> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);

    assertSafeIri(ontologyGraph);
    assertSafeIri(agentsGraph);

    const result = await this.store.query(`
      SELECT DISTINCT ?ctxGraph WHERE {
        VALUES ?sourceGraph { <${ontologyGraph}> <${agentsGraph}> }
        GRAPH ?sourceGraph {
          ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
        }
      }
    `, options);

    const ids = new Set<string>();
    if (result.type === 'bindings') {
      for (const row of result.bindings) {
        const uri = typeof row['ctxGraph'] === 'string' ? stripTerm(row['ctxGraph']) : '';
        const id = contextGraphIdFromContextGraphUri(uri);
        if (id) ids.add(id);
      }
    }

    for (const id of await this.listRootMetaDeclaredContextGraphIds(options)) {
      ids.add(id);
    }

    // OT-RFC-49 §5.9: surface CGs known only through their public `_catalog`
    // entry (e.g. discovered from a peer with no local `_meta`).
    for (const id of await this.listCatalogDeclaredContextGraphIds(options)) {
      ids.add(id);
    }

    return [...ids].sort();
  }

  private async listRootMetaDeclaredContextGraphIds(options: QueryOptions): Promise<string[]> {
    const graphUris = (await this.listGraphsByPrefix(CONTEXT_GRAPH_PREFIX, options))
      .filter((graphUri) => {
        const id = contextGraphIdFromMetaGraphUri(graphUri);
        return id !== null && isRootContextGraphId(id);
      });
    if (graphUris.length === 0) return [];

    const ids = new Set<string>();
    for (const chunk of chunks(graphUris, 128)) {
      for (const graphUri of chunk) assertSafeIri(graphUri);
      const result = await this.store.query(`
        SELECT DISTINCT ?ctxGraph WHERE {
          VALUES ?g { ${chunk.map((graphUri) => `<${graphUri}>`).join(' ')} }
          GRAPH ?g {
            ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
            FILTER(STRSTARTS(STR(?ctxGraph), "${CONTEXT_GRAPH_PREFIX}"))
            FILTER(STR(?g) = CONCAT(STR(?ctxGraph), "/_meta"))
          }
        }
      `, options);
      if (result.type !== 'bindings') continue;
      for (const row of result.bindings) {
        const uri = typeof row['ctxGraph'] === 'string' ? stripTerm(row['ctxGraph']) : '';
        const id = contextGraphIdFromContextGraphUri(uri);
        if (id && isRootContextGraphId(id)) ids.add(id);
      }
    }
    return [...ids].sort();
  }

  private async listCatalogDeclaredContextGraphIds(options: QueryOptions): Promise<string[]> {
    const graphUris = (await this.listGraphsByPrefix(CONTEXT_GRAPH_PREFIX, options))
      .filter((graphUri) => contextGraphIdFromCatalogGraphUri(graphUri) !== null);
    if (graphUris.length === 0) return [];

    const ids = new Set<string>();
    for (const chunk of chunks(graphUris, 128)) {
      for (const graphUri of chunk) assertSafeIri(graphUri);
      const result = await this.store.query(`
        SELECT DISTINCT ?ctxGraph WHERE {
          VALUES ?g { ${chunk.map((graphUri) => `<${graphUri}>`).join(' ')} }
          GRAPH ?g {
            ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH}> .
            FILTER(STRSTARTS(STR(?ctxGraph), "${CONTEXT_GRAPH_PREFIX}"))
            FILTER(STR(?g) = CONCAT(STR(?ctxGraph), "/_catalog"))
          }
        }
      `, options);
      if (result.type !== 'bindings') continue;
      for (const row of result.bindings) {
        const uri = typeof row['ctxGraph'] === 'string' ? stripTerm(row['ctxGraph']) : '';
        const id = contextGraphIdFromContextGraphUri(uri);
        if (id) ids.add(id);
      }
    }
    return [...ids].sort();
  }

  private async listGraphsByPrefix(prefix: string, options: QueryOptions): Promise<string[]> {
    if (this.store.listGraphsByPrefix) return this.store.listGraphsByPrefix(prefix, options);
    return (await this.store.listGraphs(options)).filter((graphUri) => graphUri.startsWith(prefix));
  }

  private async rebuild(contextGraphId: string, options: QueryOptions): Promise<ContextGraphMetaRecord> {
    const uri = contextGraphDataUri(contextGraphId);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    // OT-RFC-49 §5.9: a private CG's public face is its `_catalog` graph (DCAT
    // dataset record, subject = the CG DID = `uri`). Load it (floor-filtered, see
    // CATALOG_META_PREDICATES) so a CG known only through its catalog (e.g. fetched
    // from a peer with no local `_meta`) is still visible to getCgMeta() /
    // listContextGraphsFromProjection().
    const catalogGraph = contextGraphCatalogUri(contextGraphId);

    assertSafeIri(uri);
    assertSafeIri(ontologyGraph);
    assertSafeIri(agentsGraph);
    assertSafeIri(metaGraph);
    assertSafeIri(catalogGraph);

    const record: ContextGraphMetaRecord = {
      id: contextGraphId,
      uri,
      declared: (Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId),
      isSystem: (Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId),
      creators: [],
      curators: [],
      allowedPeers: [],
      allowedAgents: [],
      participantAgents: [],
      participantIdentityIds: [],
      revokedAgents: [],
      delegations: [],
      subGraphs: [],
      hasAgentGate: false,
      hasPeerGate: false,
      hasLegacyParticipantGate: false,
    };

    // Authoritative (local, fully trusted) sources first, meta-first so its
    // scalars win via first-wins (`??=`) precedence. The floor-filtered `_catalog`
    // source (untrusted, peer-fetchable) sits below them but above the shared
    // ONTOLOGY seed and can only contribute existence + a private access class.
    await this.loadContextGraphFacts(metaGraph, uri, record, options);
    await this.loadContextGraphFacts(agentsGraph, uri, record, options);
    await this.loadContextGraphFacts(catalogGraph, uri, record, options, CATALOG_META_PREDICATES);
    await this.loadContextGraphFacts(ontologyGraph, uri, record, options);
    record.delegations = await this.loadDelegations(contextGraphId, options);
    record.subGraphs = await this.loadSubGraphs(contextGraphId, options);

    record.hasAgentGate = record.allowedAgents.length > 0 || record.participantAgents.length > 0;
    record.hasPeerGate = record.allowedPeers.length > 0;
    record.hasLegacyParticipantGate = record.participantIdentityIds.length > 0;
    return record;
  }

  private async loadDelegations(
    contextGraphId: string,
    options: QueryOptions,
  ): Promise<ContextGraphDelegationMeta[]> {
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?delegation ?predicate ?object WHERE {
        GRAPH <${metaGraph}> {
          ?delegation <${DKG_ONTOLOGY.DKG_DELEGATION_AGENT}> ?delegatedAgent .
          ?delegation ?predicate ?object .
          VALUES ?predicate {
            <${DKG_ONTOLOGY.DKG_DELEGATION_AGENT}>
            <${DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER}>
            <${DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY}>
            <${DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT}>
          }
        }
      }`,
      options,
    );
    if (result.type !== 'bindings') return [];

    const byUri = new Map<string, ContextGraphDelegationMeta>();
    for (const row of result.bindings) {
      const delegation = typeof row['delegation'] === 'string' ? stripTerm(row['delegation']) : '';
      const predicate = typeof row['predicate'] === 'string' ? strip(row['predicate']) : '';
      const object = typeof row['object'] === 'string' ? stripTerm(row['object']) : '';
      if (!delegation || !predicate || !object) continue;
      const current = byUri.get(delegation) ?? {
        uri: delegation,
        agents: [],
        allowedPeers: [],
        allowedKeys: [],
        expiresAtValues: [],
      };
      switch (predicate) {
        case DKG_ONTOLOGY.DKG_DELEGATION_AGENT:
          pushUniqueCaseInsensitive(current.agents, object);
          break;
        case DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER:
          pushUnique(current.allowedPeers, object);
          break;
        case DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY:
          pushUniqueCaseInsensitive(current.allowedKeys, object);
          break;
        case DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT:
          pushUnique(current.expiresAtValues, object);
          break;
        default:
          break;
      }
      byUri.set(delegation, current);
    }
    return [...byUri.values()];
  }

  private async loadContextGraphFacts(
    graphUri: string,
    contextGraphUri: string,
    record: ContextGraphMetaRecord,
    options: QueryOptions,
    allowedPredicates?: ReadonlySet<string>,
  ): Promise<void> {
    const result = await this.store.query(
      `SELECT ?p ?o WHERE {
        GRAPH <${graphUri}> {
          <${contextGraphUri}> ?p ?o .
        }
      }`,
      options,
    );
    if (result.type !== 'bindings') return;

    for (const row of result.bindings) {
      const predicate = typeof row['p'] === 'string' ? strip(row['p']) : undefined;
      const object = typeof row['o'] === 'string' ? stripTerm(row['o']) : undefined;
      if (!predicate || object === undefined) continue;
      // Untrusted sources (the peer-fetchable `_catalog` graph) are restricted to
      // their disclosure floor — never let them feed authz-bearing fields.
      if (allowedPredicates && !allowedPredicates.has(predicate)) continue;
      this.applyFact(record, predicate, object);
    }
  }

  private applyFact(record: ContextGraphMetaRecord, predicate: string, object: string): void {
    switch (predicate) {
      case DKG_ONTOLOGY.RDF_TYPE:
        if (object === DKG_ONTOLOGY.DKG_CONTEXT_GRAPH) record.declared = true;
        if (object === DKG_ONTOLOGY.DKG_SYSTEM_CONTEXT_GRAPH) record.isSystem = true;
        // OT-RFC-49 §5.9 catalog floor: the `_catalog` entry's native type marks
        // the CG as an existing, discoverable PRIVATE CG even when no local
        // `_meta`/agents facts are present.
        if (object === DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH) {
          record.declared = true;
          applyAccessPolicy(record, 'private');
        }
        break;
      case DKG_ONTOLOGY.DCT_ACCESS_RIGHTS:
        // Catalog floor: the RESTRICTED authority IRI is the access class of a
        // private CG. Map it onto the private policy (private-wins).
        if (object === DKG_ONTOLOGY.ACCESS_RIGHT_RESTRICTED) applyAccessPolicy(record, 'private');
        break;
      case DKG_ONTOLOGY.SCHEMA_NAME:
      case `${LEGACY_SCHEMA_NS}name`:
        record.name ??= object;
        break;
      case DKG_ONTOLOGY.SCHEMA_DESCRIPTION:
      case `${LEGACY_SCHEMA_NS}description`:
        record.description ??= object;
        break;
      case DKG_ONTOLOGY.DKG_CREATOR:
        pushUnique(record.creators, object);
        record.creator ??= object;
        break;
      case DKG_ONTOLOGY.DKG_CURATOR:
        pushUnique(record.curators, object);
        record.curator ??= object;
        break;
      case DKG_ONTOLOGY.DKG_ACCESS_POLICY:
        applyAccessPolicy(record, object);
        break;
      case DKG_ONTOLOGY.DKG_CREATED_AT:
        record.createdAt ??= object;
        break;
      case DKG_ONTOLOGY.DKG_ALLOWED_PEER:
        pushUnique(record.allowedPeers, object);
        break;
      case DKG_ONTOLOGY.DKG_ALLOWED_AGENT:
        pushUniqueCaseInsensitive(record.allowedAgents, object);
        break;
      case DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT:
        pushUniqueCaseInsensitive(record.participantAgents, object);
        break;
      case DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID:
        pushUnique(record.participantIdentityIds, object);
        break;
      case DKG_ONTOLOGY.DKG_REVOKED_AGENT:
        pushUniqueCaseInsensitive(record.revokedAgents, object);
        break;
      case `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`:
        record.onChainId ??= object;
        break;
      default:
        break;
    }
  }

  private async loadSubGraphs(contextGraphId: string, options: QueryOptions): Promise<ContextGraphSubGraphMeta[]> {
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?subGraph ?name ?createdBy ?createdAt ?description WHERE {
        GRAPH <${metaGraph}> {
          ?subGraph ?typePred ?subGraphType ;
                    ?namePred ?name ;
                    ?createdByPred ?createdBy .
          VALUES ?typePred { <${DKG_ONTOLOGY.RDF_TYPE}> }
          VALUES ?subGraphType { <${DKG_NS}SubGraph> <${LEGACY_DKG_NS}SubGraph> }
          VALUES ?namePred { <${DKG_ONTOLOGY.SCHEMA_NAME}> <${LEGACY_SCHEMA_NS}name> }
          VALUES ?createdByPred { <${DKG_NS}createdBy> <${LEGACY_DKG_NS}createdBy> }
          OPTIONAL {
            ?subGraph ?createdAtPred ?createdAt .
            VALUES ?createdAtPred { <${DKG_NS}createdAt> <${LEGACY_DKG_NS}createdAt> }
          }
          OPTIONAL {
            ?subGraph ?descriptionPred ?description .
            VALUES ?descriptionPred { <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> <${LEGACY_SCHEMA_NS}description> }
          }
        }
      }`,
      options,
    );
    if (result.type !== 'bindings') return [];

    const byUri = new Map<string, ContextGraphSubGraphMeta>();
    for (const row of result.bindings) {
      const uri = typeof row['subGraph'] === 'string' ? stripTerm(row['subGraph']) : '';
      if (!uri) continue;
      const current = byUri.get(uri) ?? {
        uri,
        name: row['name'] ? stripTerm(String(row['name'])) : '',
        createdBy: row['createdBy'] ? stripTerm(String(row['createdBy'])) : '',
      };
      if (!current.name && row['name']) current.name = stripTerm(String(row['name']));
      if (!current.createdBy && row['createdBy']) current.createdBy = stripTerm(String(row['createdBy']));
      if (!current.createdAt && row['createdAt']) current.createdAt = stripTerm(String(row['createdAt']));
      if (!current.description && row['description']) current.description = stripTerm(String(row['description']));
      byUri.set(uri, current);
    }
    return [...byUri.values()];
  }

  private contextGraphIdTouchedByQuad(quad: Quad): string | null {
    const subject = stripTerm(quad.subject);
    const predicate = strip(quad.predicate);
    const object = stripTerm(quad.object);
    const graph = stripTerm(quad.graph);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const metaContextGraphId = contextGraphIdFromMetaGraphUri(graph);

    // OT-RFC-49 §5.9: a write into a CG's `_catalog` graph (publish-time partition
    // or a peer-fetched catalog) must dirty the projection so a cached record
    // picks up the new public facts. The catalog subject is the CG DID; only the
    // floor predicates the read side honours are invalidation-relevant.
    const catalogContextGraphId = contextGraphIdFromCatalogGraphUri(graph);
    if (catalogContextGraphId) {
      const contextGraphUri = contextGraphDataUri(catalogContextGraphId);
      if (subject === contextGraphUri && CATALOG_META_PREDICATES.has(predicate)) {
        return catalogContextGraphId;
      }
      return null;
    }

    if (metaContextGraphId) {
      const contextGraphUri = contextGraphDataUri(metaContextGraphId);
      if (subject === contextGraphUri && DIRECT_META_PREDICATES.has(predicate)) {
        return metaContextGraphId;
      }

      if (
        subject.startsWith(`did:dkg:agent-delegation:${metaContextGraphId}:`) &&
        DELEGATION_META_PREDICATES.has(predicate)
      ) {
        return metaContextGraphId;
      }

      if (!subject.startsWith(`${contextGraphUri}/`)) return null;
      if (!SUB_GRAPH_META_PREDICATES.has(predicate)) return null;
      if (predicate === DKG_ONTOLOGY.RDF_TYPE && !SUB_GRAPH_TYPE_URIS.has(object)) return null;
      return metaContextGraphId;
    }

    if ((graph === ontologyGraph || graph === agentsGraph) && DIRECT_META_PREDICATES.has(predicate)) {
      return contextGraphIdFromContextGraphUri(subject);
    }

    return null;
  }
}

function pushUnique(target: string[], value: string): void {
  if (target.includes(value)) return;
  target.push(value);
}

function pushUniqueCaseInsensitive(target: string[], value: string): void {
  const key = value.toLowerCase();
  if (target.some((existing) => existing.toLowerCase() === key)) return;
  target.push(value);
}

function stripTerm(value: string): string {
  return stripLiteral(strip(value));
}

function applyAccessPolicy(record: ContextGraphMetaRecord, value: string): void {
  // PRIVACY IS A ONE-WAY RATCHET (product decision 2026-06-16): any `private`
  // declaration — from `_meta`, AGENTS, ONTOLOGY, or the catalog floor — STICKS,
  // and a later `public` declaration can never downgrade it. This deliberately
  // prefers fail-safe over flexibility: a CG cannot be re-declared public via a
  // racing/stale/forged `public` row, at the cost of being unable to declassify a
  // private CG through metadata. (Replaces the prior first-wins `??=`.)
  const normalized = value.trim().toLowerCase();
  if (normalized === 'private') {
    record.accessPolicy = 'private';
    return;
  }
  if (normalized === 'public') {
    if (record.accessPolicy !== 'private') record.accessPolicy = 'public';
    return;
  }
  record.accessPolicy ??= value;
}

function contextGraphIdFromContextGraphUri(uri: string): string | null {
  if (!uri.startsWith(CONTEXT_GRAPH_PREFIX)) return null;
  const tail = uri.slice(CONTEXT_GRAPH_PREFIX.length);
  if (!tail) return null;
  return tail;
}

function isRootContextGraphId(id: string): boolean {
  if (!id.includes('/')) return true;
  return /^0x[0-9a-fA-F]{40}\/[^/]+$/.test(id);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push([...items.slice(i, i + size)]);
  }
  return result;
}

function contextGraphIdFromMetaGraphUri(uri: string): string | null {
  if (!uri.startsWith(CONTEXT_GRAPH_PREFIX) || !uri.endsWith('/_meta')) return null;
  const tail = uri.slice(CONTEXT_GRAPH_PREFIX.length, -'/_meta'.length);
  if (!tail) return null;
  return tail;
}

function contextGraphIdFromCatalogGraphUri(uri: string): string | null {
  if (!uri.startsWith(CONTEXT_GRAPH_PREFIX) || !uri.endsWith('/_catalog')) return null;
  const tail = uri.slice(CONTEXT_GRAPH_PREFIX.length, -'/_catalog'.length);
  if (!tail) return null;
  return tail;
}

function cloneMetaRecord(record: ContextGraphMetaRecord): ContextGraphMetaRecord {
  return {
    ...record,
    creators: [...record.creators],
    curators: [...record.curators],
    allowedPeers: [...record.allowedPeers],
    allowedAgents: [...record.allowedAgents],
    participantAgents: [...record.participantAgents],
    participantIdentityIds: [...record.participantIdentityIds],
    revokedAgents: [...record.revokedAgents],
    delegations: record.delegations.map((delegation) => ({
      ...delegation,
      agents: [...delegation.agents],
      allowedPeers: [...delegation.allowedPeers],
      allowedKeys: [...delegation.allowedKeys],
      expiresAtValues: [...delegation.expiresAtValues],
    })),
    subGraphs: record.subGraphs.map((subGraph) => ({ ...subGraph })),
  };
}

function raceAgainstAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}
