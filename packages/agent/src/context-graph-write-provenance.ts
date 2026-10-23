export interface LocalFirstWriteProvenance {
  /**
   * Node-local origin journal proves this graph was created here. This is
   * independent of gossip subscription and cannot be inferred from replicated
   * RDF. Consumers must still require a healthy store, the declaration, and
   * the caller's policy authorization before accepting a first content write.
   */
  locallyCreated?: boolean;
}
