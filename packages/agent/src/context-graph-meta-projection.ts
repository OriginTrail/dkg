// SPDX-License-Identifier: Apache-2.0

import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  assertSafeIri,
  contextGraphDataGraphUri,
  contextGraphDataUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { strip, stripLiteral } from './dkg-agent-utils.js';

export interface ContextGraphSubGraphMeta {
  uri: string;
  name: string;
  createdBy: string;
  createdAt?: string;
  description?: string;
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

export class ContextGraphMetaProjection {
  private readonly entries = new Map<string, ProjectionEntry>();

  constructor(private readonly store: TripleStore) {}

  async get(contextGraphId: string): Promise<ContextGraphMetaRecord> {
    const existing = this.entries.get(contextGraphId);
    if (existing?.value && !existing.dirty) return existing.value;
    if (existing?.inflight) {
      if (!existing.dirty) return existing.inflight;
      await existing.inflight;
      return this.get(contextGraphId);
    }

    const entry = existing ?? { dirty: true, invalidationVersion: 0 };
    const rebuildVersion = entry.invalidationVersion;
    entry.dirty = false;
    const inflight = this.rebuild(contextGraphId)
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
    return inflight;
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

  async listDeclaredContextGraphIds(): Promise<string[]> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);

    assertSafeIri(ontologyGraph);
    assertSafeIri(agentsGraph);

    const result = await this.store.query(`
      SELECT DISTINCT ?ctxGraph WHERE {
        {
          GRAPH <${ontologyGraph}> {
            ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
          }
        } UNION {
          GRAPH <${agentsGraph}> {
            ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
          }
        } UNION {
          GRAPH ?g {
            ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
            FILTER(STRSTARTS(STR(?ctxGraph), "${CONTEXT_GRAPH_PREFIX}"))
            FILTER(STR(?g) = CONCAT(STR(?ctxGraph), "/_meta"))
          }
        }
      }
    `);
    if (result.type !== 'bindings') return [];

    const ids = new Set<string>();
    for (const row of result.bindings) {
      const uri = typeof row['ctxGraph'] === 'string' ? stripTerm(row['ctxGraph']) : '';
      const id = contextGraphIdFromContextGraphUri(uri);
      if (id) ids.add(id);
    }
    return [...ids].sort();
  }

  private async rebuild(contextGraphId: string): Promise<ContextGraphMetaRecord> {
    const uri = contextGraphDataUri(contextGraphId);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);

    assertSafeIri(uri);
    assertSafeIri(ontologyGraph);
    assertSafeIri(agentsGraph);
    assertSafeIri(metaGraph);

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
      subGraphs: [],
      hasAgentGate: false,
      hasPeerGate: false,
      hasLegacyParticipantGate: false,
    };

    const graphUris = [ontologyGraph, agentsGraph, metaGraph];
    for (const graphUri of graphUris) {
      await this.loadContextGraphFacts(graphUri, uri, record);
    }
    record.subGraphs = await this.loadSubGraphs(contextGraphId);

    record.hasAgentGate = record.allowedAgents.length > 0 || record.participantAgents.length > 0;
    record.hasPeerGate = record.allowedPeers.length > 0;
    record.hasLegacyParticipantGate = record.participantIdentityIds.length > 0;
    return record;
  }

  private async loadContextGraphFacts(graphUri: string, contextGraphUri: string, record: ContextGraphMetaRecord): Promise<void> {
    const result = await this.store.query(
      `SELECT ?p ?o WHERE {
        GRAPH <${graphUri}> {
          <${contextGraphUri}> ?p ?o .
        }
      }`,
    );
    if (result.type !== 'bindings') return;

    for (const row of result.bindings) {
      const predicate = typeof row['p'] === 'string' ? strip(row['p']) : undefined;
      const object = typeof row['o'] === 'string' ? stripTerm(row['o']) : undefined;
      if (!predicate || object === undefined) continue;
      this.applyFact(record, predicate, object);
    }
  }

  private applyFact(record: ContextGraphMetaRecord, predicate: string, object: string): void {
    switch (predicate) {
      case DKG_ONTOLOGY.RDF_TYPE:
        if (object === DKG_ONTOLOGY.DKG_CONTEXT_GRAPH) record.declared = true;
        if (object === DKG_ONTOLOGY.DKG_SYSTEM_CONTEXT_GRAPH) record.isSystem = true;
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
        pushUnique(record.allowedAgents, object);
        break;
      case DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT:
        pushUnique(record.participantAgents, object);
        break;
      case DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID:
        pushUnique(record.participantIdentityIds, object);
        break;
      case DKG_ONTOLOGY.DKG_REVOKED_AGENT:
        pushUnique(record.revokedAgents, object);
        break;
      case `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`:
        record.onChainId ??= object;
        break;
      default:
        break;
    }
  }

  private async loadSubGraphs(contextGraphId: string): Promise<ContextGraphSubGraphMeta[]> {
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

    if (metaContextGraphId) {
      const contextGraphUri = contextGraphDataUri(metaContextGraphId);
      if (subject === contextGraphUri && DIRECT_META_PREDICATES.has(predicate)) {
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
  const key = value.toLowerCase();
  if (target.some((existing) => existing.toLowerCase() === key)) return;
  target.push(value);
}

function stripTerm(value: string): string {
  return stripLiteral(strip(value));
}

function applyAccessPolicy(record: ContextGraphMetaRecord, value: string): void {
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

function contextGraphIdFromMetaGraphUri(uri: string): string | null {
  if (!uri.startsWith(CONTEXT_GRAPH_PREFIX) || !uri.endsWith('/_meta')) return null;
  const tail = uri.slice(CONTEXT_GRAPH_PREFIX.length, -'/_meta'.length);
  if (!tail) return null;
  return tail;
}
