import {
  escapeRdfLiteral,
  isRdfTerm,
  normalizeRdfObject,
} from '@origintrail-official/dkg-rdf-utils';

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

// Core and MCP preserve their public names as thin compatibility wrappers around
// the complete dependency-free normalizer in @origintrail-official/dkg-rdf-utils.
export function normalizeDkgPublisherObject(value: unknown): string {
  return normalizeRdfObject(value);
}

export function isDkgRdfTerm(value: string): boolean {
  return isRdfTerm(value);
}

/**
 * Escape a plain-text string for use as an RDF/N-Triples literal body.
 * Returns only the escaped body; callers wrap it in quotes.
 */
export function escapeDkgRdfLiteral(value: string): string {
  return escapeRdfLiteral(value);
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
