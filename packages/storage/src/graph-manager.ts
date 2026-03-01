import type { TripleStore } from './triple-store.js';
import {
  paranetDataGraphUri,
  paranetMetaGraphUri,
  paranetPrivateGraphUri,
  paranetWorkspaceGraphUri,
  paranetWorkspaceMetaGraphUri,
} from '@dkg/core';

export class GraphManager {
  private readonly store: TripleStore;

  constructor(store: TripleStore) {
    this.store = store;
  }

  dataGraphUri(paranetId: string): string {
    return paranetDataGraphUri(paranetId);
  }

  metaGraphUri(paranetId: string): string {
    return paranetMetaGraphUri(paranetId);
  }

  privateGraphUri(paranetId: string): string {
    return paranetPrivateGraphUri(paranetId);
  }

  workspaceGraphUri(paranetId: string): string {
    return paranetWorkspaceGraphUri(paranetId);
  }

  workspaceMetaGraphUri(paranetId: string): string {
    return paranetWorkspaceMetaGraphUri(paranetId);
  }

  async ensureParanet(paranetId: string): Promise<void> {
    await this.store.createGraph(this.dataGraphUri(paranetId));
    await this.store.createGraph(this.metaGraphUri(paranetId));
    await this.store.createGraph(this.privateGraphUri(paranetId));
    await this.store.createGraph(this.workspaceGraphUri(paranetId));
    await this.store.createGraph(this.workspaceMetaGraphUri(paranetId));
  }

  async listParanets(): Promise<string[]> {
    const graphs = await this.store.listGraphs();
    const paranets = new Set<string>();
    const prefix = 'did:dkg:paranet:';
    for (const g of graphs) {
      if (g.startsWith(prefix)) {
        const rest = g.slice(prefix.length);
        const id = rest.endsWith('/_meta')
          ? rest.slice(0, -6)
          : rest.endsWith('/_private')
            ? rest.slice(0, -9)
            : rest.endsWith('/_workspace_meta')
              ? rest.slice(0, -16)
              : rest.endsWith('/_workspace')
                ? rest.slice(0, -11)
                : rest;
        paranets.add(id);
      }
    }
    return [...paranets];
  }

  async hasParanet(paranetId: string): Promise<boolean> {
    return this.store.hasGraph(this.dataGraphUri(paranetId));
  }

  async dropParanet(paranetId: string): Promise<void> {
    await this.store.dropGraph(this.dataGraphUri(paranetId));
    await this.store.dropGraph(this.metaGraphUri(paranetId));
    await this.store.dropGraph(this.privateGraphUri(paranetId));
    await this.store.dropGraph(this.workspaceGraphUri(paranetId));
    await this.store.dropGraph(this.workspaceMetaGraphUri(paranetId));
  }
}
