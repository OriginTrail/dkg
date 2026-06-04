/**
 * Typed publisher errors (and the CAS condition payload they carry).
 *
 * Extracted verbatim from `dkg-publisher.ts` to keep that file focused on the
 * `DKGPublisher` class. `dkg-publisher.ts` re-exports every symbol here, and the
 * package index re-exports them from `dkg-publisher.js`, so all existing import
 * paths — `@origintrail-official/dkg-publisher`, deep imports, and internal
 * `./dkg-publisher.js` imports — and `instanceof` checks are unchanged.
 *
 * NOTE on the wire contract: several consumers (e.g. `packages/cli/src/daemon`)
 * duck-type these via `err.name === '...'` rather than `instanceof`, so the
 * `this.name` strings below are a stable contract — do not rename them.
 */

export class PublisherWalletRequiredError extends Error {
  constructor(operation: string) {
    super(
      `${operation} requires "publisherPrivateKey" or a non-zero "publisherAddress" ` +
      'backed by ChainAdapter.signMessageAs()/signMessage(). Publishing without a publisher signing key ' +
      'would produce unattributable or unverifiable publisher output.',
    );
    this.name = 'PublisherWalletRequiredError';
  }
}

export interface CASCondition {
  subject: string;
  predicate: string;
  /**
   * Expected current object value as a SPARQL term (e.g. `"recruiting"`,
   * `"42"^^<http://www.w3.org/2001/XMLSchema#integer>`, `<http://example.org/>`).
   * `null` means the triple must not exist.
   */
  expectedValue: string | null;
}

export class StaleWriteError extends Error {
  readonly condition: CASCondition;
  readonly actualValue: string | null;
  constructor(condition: CASCondition, actualValue: string | null) {
    const exp = condition.expectedValue === null ? '<absent>' : `"${condition.expectedValue}"`;
    const act = actualValue === null ? '<absent>' : `"${actualValue}"`;
    super(`CAS failed: <${condition.subject}> <${condition.predicate}> expected ${exp}, found ${act}`);
    this.name = 'StaleWriteError';
    this.condition = condition;
    this.actualValue = actualValue;
  }
}

/**
 * Thrown when `publish()` receives a quad whose subject sits in the
 * protocol-reserved URN namespace (`urn:dkg:file:...`, etc.).
 *
 * @internal — exported for backwards compatibility with external
 * consumers that deep-imported this symbol before
 * `@origintrail-official/dkg-publisher` had an `exports` map.
 * New code should duck-type via `err.name === 'ReservedNamespaceError'`
 * (the pattern used by `packages/cli/src/daemon.ts`) since the wire
 * contract is the `.name` string, not the class identity.
 */
export class ReservedNamespaceError extends Error {
  readonly subject: string;
  readonly prefix: string;
  constructor(subject: string, prefix: string) {
    super(
      `Subject '${subject}' is in the reserved namespace '${prefix}*', which is protocol-reserved ` +
        `for daemon-generated file descriptors and extraction provenance per ` +
        `19_MARKDOWN_CONTENT_TYPE.md §10.2. Use a different URN for user-authored quads.`,
    );
    this.name = 'ReservedNamespaceError';
    this.subject = subject;
    this.prefix = prefix;
  }
}

// Issue #864 — surface the "_meta promised structural triples but the data
// graph is empty" inconsistency as a typed, machine-readable error so the
// daemon route can map it to a 409 and the UI can render an actionable
// hint instead of the misleading "Promoted 0 triples to Shared Memory"
// toast. The code field is the contract the daemon/UI rely on; do not
// rename without updating both call-sites.
export class AssertionNotPersistedError extends Error {
  readonly code = 'ASSERTION_NOT_PERSISTED' as const;
  readonly contextGraphId: string;
  readonly assertionGraph: string;
  readonly expectedTripleCount: number;
  constructor(args: {
    contextGraphId: string;
    assertionGraph: string;
    expectedTripleCount: number;
  }) {
    super(
      `Assertion data graph <${args.assertionGraph}> is empty, but its _meta record ` +
        `reports extractionStatus="completed" with structuralTripleCount=${args.expectedTripleCount}. ` +
        `The extracted triples were never persisted (or have been deleted) so promote has nothing to move. ` +
        `Re-import the source file or re-write the assertion before promoting.`,
    );
    this.name = 'AssertionNotPersistedError';
    this.contextGraphId = args.contextGraphId;
    this.assertionGraph = args.assertionGraph;
    this.expectedTripleCount = args.expectedTripleCount;
  }
}

export class MultiRootPublishNotAtomicError extends Error {
  readonly code = 'MULTI_ROOT_PUBLISH_NOT_ATOMIC' as const;
  readonly contextGraphId: string;
  readonly rootEntities: string[];
  constructor(contextGraphId: string, rootEntities: readonly string[]) {
    super(
      `V10 shared-memory publish is single-root only for this operation. ` +
        `Resolved ${rootEntities.length} root entities; select exactly one root or use a durable multi-publish flow.`,
    );
    this.name = 'MultiRootPublishNotAtomicError';
    this.contextGraphId = contextGraphId;
    this.rootEntities = [...rootEntities];
  }
}

export type PullFromPreconditionCode =
  | 'PULL_FROM_UNFINALIZED_ASSERTION'
  | 'PULL_FROM_INVALID_SEAL';

export class PullFromPreconditionError extends Error {
  readonly code: PullFromPreconditionCode;
  constructor(code: PullFromPreconditionCode, message: string) {
    super(message);
    this.name = 'PullFromPreconditionError';
    this.code = code;
  }
}
