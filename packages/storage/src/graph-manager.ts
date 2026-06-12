import type { TripleStore } from './triple-store.js';
import {
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphPrivateUri,
  contextGraphSharedMemoryUri,
  contextGraphSharedMemoryMetaUri,
  contextGraphVerifiableMemoryUri,
  contextGraphVerifiableMemoryMetaUri,
  contextGraphAssertionUri,
  contextGraphSubGraphUri,
  contextGraphSubGraphMetaUri,
  contextGraphSubGraphPrivateUri,
} from '@origintrail-official/dkg-core';

const CG_PREFIX = 'did:dkg:context-graph:';

async function listGraphsByPrefix(store: TripleStore, prefix: string): Promise<string[]> {
  return store.listGraphsByPrefix
    ? store.listGraphsByPrefix(prefix)
    : (await store.listGraphs()).filter((graph) => graph.startsWith(prefix));
}

export class ContextGraphManager {
  private readonly store: TripleStore;
  private readonly ensuredContextGraphs = new Set<string>();

  constructor(store: TripleStore) {
    this.store = store;
  }

  dataGraphUri(contextGraphId: string): string {
    return contextGraphDataUri(contextGraphId);
  }

  metaGraphUri(contextGraphId: string): string {
    return contextGraphMetaUri(contextGraphId);
  }

  privateGraphUri(contextGraphId: string): string {
    return contextGraphPrivateUri(contextGraphId);
  }

  sharedMemoryUri(contextGraphId: string, subGraphName?: string): string {
    return contextGraphSharedMemoryUri(contextGraphId, subGraphName);
  }

  sharedMemoryMetaUri(contextGraphId: string, subGraphName?: string): string {
    return contextGraphSharedMemoryMetaUri(contextGraphId, subGraphName);
  }

  verifiableMemoryUri(contextGraphId: string, verifiableMemoryId: string): string {
    return contextGraphVerifiableMemoryUri(contextGraphId, verifiableMemoryId);
  }

  verifiableMemoryMetaUri(contextGraphId: string, verifiableMemoryId: string): string {
    return contextGraphVerifiableMemoryMetaUri(contextGraphId, verifiableMemoryId);
  }

  assertionUri(contextGraphId: string, agentAddress: string, name: string): string {
    return contextGraphAssertionUri(contextGraphId, agentAddress, name);
  }

  subGraphUri(contextGraphId: string, subGraphName: string): string {
    return contextGraphSubGraphUri(contextGraphId, subGraphName);
  }

  subGraphMetaUri(contextGraphId: string, subGraphName: string): string {
    return contextGraphSubGraphMetaUri(contextGraphId, subGraphName);
  }

  subGraphPrivateUri(contextGraphId: string, subGraphName: string): string {
    return contextGraphSubGraphPrivateUri(contextGraphId, subGraphName);
  }

  async ensureSubGraph(contextGraphId: string, subGraphName: string): Promise<void> {
    await this.ensureContextGraph(contextGraphId);
    await this.store.createGraph(this.subGraphUri(contextGraphId, subGraphName));
    await this.store.createGraph(this.subGraphMetaUri(contextGraphId, subGraphName));
    await this.store.createGraph(this.subGraphPrivateUri(contextGraphId, subGraphName));
    await this.store.createGraph(contextGraphSharedMemoryUri(contextGraphId, subGraphName));
    await this.store.createGraph(contextGraphSharedMemoryMetaUri(contextGraphId, subGraphName));
  }

  async ensureContextGraph(contextGraphId: string): Promise<void> {
    if (this.ensuredContextGraphs.has(contextGraphId)) return;
    await this.store.createGraph(this.dataGraphUri(contextGraphId));
    await this.store.createGraph(this.metaGraphUri(contextGraphId));
    await this.store.createGraph(this.privateGraphUri(contextGraphId));
    await this.store.createGraph(this.sharedMemoryUri(contextGraphId));
    await this.store.createGraph(this.sharedMemoryMetaUri(contextGraphId));
    this.ensuredContextGraphs.add(contextGraphId);
  }

  async listContextGraphs(): Promise<string[]> {
    const graphs = await listGraphsByPrefix(this.store, CG_PREFIX);
    const contextGraphs = new Set<string>();
    for (const g of graphs) {
      if (g.startsWith(CG_PREFIX)) {
        const rest = g.slice(CG_PREFIX.length);
        const id = rest.endsWith('/_meta')
          ? rest.slice(0, -6)
          : rest.endsWith('/_private')
            ? rest.slice(0, -9)
            : rest.endsWith('/_shared_memory_meta')
              ? rest.slice(0, -20)
              : rest.endsWith('/_shared_memory')
                ? rest.slice(0, -15)
                : rest;
        if (!id.includes('/')) {
          contextGraphs.add(id);
        }
      }
    }
    return [...contextGraphs];
  }

  /**
   * @deprecated Prefer DKGAgent.listSubGraphs(), which reads spec-compliant
   * registration metadata from the context graph `_meta` graph. This shim keeps
   * the legacy storage-level graph-walk behavior for downstream callers.
   */
  async listSubGraphs(contextGraphId: string): Promise<string[]> {
    const prefix = `${CG_PREFIX}${contextGraphId}/`;
    const allGraphs = await listGraphsByPrefix(this.store, prefix);
    const subGraphNames = new Set<string>();
    const reservedPrefixes = ['_', 'assertion/', 'draft/', 'context/'];
    for (const g of allGraphs) {
      if (!g.startsWith(prefix)) continue;
      const rest = g.slice(prefix.length);
      if (reservedPrefixes.some(r => rest.startsWith(r))) continue;
      const name = rest.endsWith('/_meta') ? rest.slice(0, -6) : rest;
      if (name.includes('/')) continue;
      if (name.length > 0) subGraphNames.add(name);
    }
    return [...subGraphNames];
  }

  async hasContextGraph(contextGraphId: string): Promise<boolean> {
    return this.store.hasGraph(this.dataGraphUri(contextGraphId));
  }

  async dropContextGraph(contextGraphId: string): Promise<void> {
    this.ensuredContextGraphs.delete(contextGraphId);
    await this.store.dropGraph(this.dataGraphUri(contextGraphId));
    await this.store.dropGraph(this.metaGraphUri(contextGraphId));
    await this.store.dropGraph(this.privateGraphUri(contextGraphId));
    await this.store.dropGraph(this.sharedMemoryUri(contextGraphId));
    await this.store.dropGraph(this.sharedMemoryMetaUri(contextGraphId));
  }

  // ── Deprecated V9 aliases ────────────────────────────────────────────

  /** @deprecated Use dataGraphUri */
  workspaceGraphUri(contextGraphId: string): string {
    return this.sharedMemoryUri(contextGraphId);
  }

  /** @deprecated Use sharedMemoryMetaUri */
  workspaceMetaGraphUri(contextGraphId: string): string {
    return this.sharedMemoryMetaUri(contextGraphId);
  }

}

/** @deprecated Use ContextGraphManager */
export class GraphManager extends ContextGraphManager {}
