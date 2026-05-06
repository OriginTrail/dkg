export interface DkgPublisherExtensionQuadInput {
  subject: unknown;
  predicate: unknown;
  object: unknown;
  graph?: unknown;
}

export interface DkgPublisherExtensionQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

export interface DkgPublisherExtensionCreateResult {
  assertionUri: string | null;
  alreadyExists: boolean;
}

export interface DkgPublisherExtensionWriteResult {
  written: number;
}

export interface DkgPublisherExtensionShareResult {
  shareOperationId: string;
}

export interface DkgPublisherExtensionPublishResult {
  kcId?: string | number | bigint;
  kas?: unknown[];
  [key: string]: unknown;
}

export interface DkgPublisherExtensionTransport {
  createAssertion(
    contextGraphId: string,
    assertionName: string,
    opts?: { subGraphName?: string },
  ): Promise<DkgPublisherExtensionCreateResult>;

  writeAssertion(
    contextGraphId: string,
    assertionName: string,
    quads: DkgPublisherExtensionQuad[],
    opts?: { subGraphName?: string },
  ): Promise<DkgPublisherExtensionWriteResult>;

  promoteAssertion(
    contextGraphId: string,
    assertionName: string,
    opts?: { entities?: string[] | 'all'; subGraphName?: string },
  ): Promise<Record<string, unknown>>;

  discardAssertion(
    contextGraphId: string,
    assertionName: string,
    opts?: { subGraphName?: string },
  ): Promise<Record<string, unknown>>;

  share(
    contextGraphId: string,
    quads: DkgPublisherExtensionQuad[],
    opts?: { localOnly?: boolean; subGraphName?: string },
  ): Promise<DkgPublisherExtensionShareResult>;

  publish(
    contextGraphId: string,
    quads: DkgPublisherExtensionQuad[],
    privateQuads?: DkgPublisherExtensionQuad[],
    opts?: { accessPolicy?: 'public' | 'ownerOnly' | 'allowList'; allowedPeers?: string[] },
  ): Promise<DkgPublisherExtensionPublishResult>;

  publishSharedMemory(
    contextGraphId: string,
    opts?: { rootEntities?: string[]; clearAfter?: boolean; subGraphName?: string },
  ): Promise<DkgPublisherExtensionPublishResult>;
}

export interface LocalWorkspaceCreateRequest {
  contextGraphId: string;
  assertionName: string;
  subGraphName?: string;
}

export interface LocalWorkspaceWriteRequest {
  contextGraphId: string;
  assertionName: string;
  quads: DkgPublisherExtensionQuadInput[];
  subGraphName?: string;
  /**
   * Defaults to true so generic plugin callers can use a single write method
   * for the common create-then-write WM flow. Plugins that expose create and
   * write as separate tools can pass false.
   */
  createIfMissing?: boolean;
}

export interface LocalWorkspacePromoteRequest {
  contextGraphId: string;
  assertionName: string;
  rootEntities?: string[];
  subGraphName?: string;
}

export interface LocalWorkspaceDiscardRequest {
  contextGraphId: string;
  assertionName: string;
  subGraphName?: string;
}

export interface SharedMemoryWriteRequest {
  contextGraphId: string;
  quads: DkgPublisherExtensionQuadInput[];
  localOnly?: boolean;
  subGraphName?: string;
}

export interface VerifiedMemoryPublishRequest {
  contextGraphId: string;
  quads: DkgPublisherExtensionQuadInput[];
  privateQuads?: DkgPublisherExtensionQuadInput[];
  accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers?: string[];
}

export interface SharedMemoryPublishRequest {
  contextGraphId: string;
  rootEntities?: string[];
  clearAfter?: boolean;
  subGraphName?: string;
}

/**
 * Plugin-agnostic publisher extension facade.
 *
 * The facade only depends on `DkgPublisherExtensionTransport`, a small
 * structural contract that any plugin adapter can implement over its own
 * daemon client, SDK bridge, RPC client, or test double.
 */
export class DkgPublisherExtension {
  constructor(private readonly transport: DkgPublisherExtensionTransport) {}

  async createLocalWorkspace(
    request: LocalWorkspaceCreateRequest,
  ): Promise<DkgPublisherExtensionCreateResult> {
    return this.transport.createAssertion(request.contextGraphId, request.assertionName, {
      subGraphName: request.subGraphName,
    });
  }

  async writeLocalWorkspace(request: LocalWorkspaceWriteRequest): Promise<DkgPublisherExtensionWriteResult> {
    if (request.createIfMissing !== false) {
      await this.createLocalWorkspace(request);
    }

    return this.transport.writeAssertion(
      request.contextGraphId,
      request.assertionName,
      normalizeDkgPublisherQuads(request.quads),
      { subGraphName: request.subGraphName },
    );
  }

  async promoteLocalWorkspace(
    request: LocalWorkspacePromoteRequest,
  ): ReturnType<DkgPublisherExtensionTransport['promoteAssertion']> {
    return this.transport.promoteAssertion(request.contextGraphId, request.assertionName, {
      entities: request.rootEntities,
      subGraphName: request.subGraphName,
    });
  }

  async discardLocalWorkspace(
    request: LocalWorkspaceDiscardRequest,
  ): ReturnType<DkgPublisherExtensionTransport['discardAssertion']> {
    return this.transport.discardAssertion(request.contextGraphId, request.assertionName, {
      subGraphName: request.subGraphName,
    });
  }

  async writeSharedMemory(request: SharedMemoryWriteRequest): Promise<DkgPublisherExtensionShareResult> {
    return this.transport.share(
      request.contextGraphId,
      normalizeDkgPublisherQuads(request.quads),
      {
        localOnly: request.localOnly,
        subGraphName: request.subGraphName,
      },
    );
  }

  async publishVerifiedMemory(
    request: VerifiedMemoryPublishRequest,
  ): ReturnType<DkgPublisherExtensionTransport['publish']> {
    return this.transport.publish(
      request.contextGraphId,
      normalizeDkgPublisherQuads(request.quads),
      request.privateQuads ? normalizeDkgPublisherQuads(request.privateQuads) : undefined,
      {
        accessPolicy: request.accessPolicy,
        allowedPeers: request.allowedPeers,
      },
    );
  }

  async publishSharedMemory(
    request: SharedMemoryPublishRequest,
  ): ReturnType<DkgPublisherExtensionTransport['publishSharedMemory']> {
    return this.transport.publishSharedMemory(request.contextGraphId, {
      rootEntities: request.rootEntities,
      clearAfter: request.clearAfter,
      subGraphName: request.subGraphName,
    });
  }
}

export function createDkgPublisherExtension(
  transport: DkgPublisherExtensionTransport,
): DkgPublisherExtension {
  return new DkgPublisherExtension(transport);
}

export function normalizeDkgPublisherQuads(
  quads: DkgPublisherExtensionQuadInput[],
): DkgPublisherExtensionQuad[] {
  return quads.map((q) => ({
    subject: String(q.subject ?? ''),
    predicate: String(q.predicate ?? ''),
    object: normalizeDkgPublisherObject(q.object),
    graph: q.graph ? String(q.graph) : '',
  }));
}

export function normalizeDkgPublisherObject(value: unknown): string {
  const raw = String(value ?? '');
  if (isDkgRdfTerm(raw)) return raw;
  return `"${escapeDkgRdfLiteral(raw)}"`;
}

export function isDkgRdfTerm(value: string): boolean {
  return (
    /^(?:https?:\/\/|urn:|did:)/i.test(value) ||
    value.startsWith('_:') ||
    value.startsWith('"')
  );
}

/**
 * Escape a plain-text string for use as an RDF/N-Triples literal body.
 * Returns only the escaped body; callers wrap it in quotes.
 */
export function escapeDkgRdfLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\f/g, '\\f')
    .replace(/\x08/g, '\\b');
}

export {
  DkgPublisherExtension as DkgPublisherFacade,
  DkgPublisherExtension as GenericDkgPublisher,
  DkgPublisherExtension as DkgPublisherAbstraction,
  createDkgPublisherExtension as createDkgPublisher,
};

export type {
  DkgPublisherExtensionTransport as DkgPublisherClient,
  DkgPublisherExtensionQuad as DkgPublisherQuad,
  DkgPublisherExtensionQuadInput as DkgPublisherQuadInput,
};
