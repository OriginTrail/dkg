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
 * Thrown by a gated SWM write (`ShareOptions.confirmBeforeCommit`) when the
 * curator — the authoritative SWM replica under OT-RFC-49 curator-leader — did
 * NOT confirm it applied the write within the deadline (unreachable on the
 * reliable leg, ack timed out, curator peer unresolvable, or a transient
 * receiver rejection). The write is aborted with ZERO local persistence: the
 * curator is the durable authority, so a write it never applied did not happen,
 * and reporting success would be a silent lie (the next reconnect would
 * REPLACE-revert it anyway). The `.name`/`.code` strings are the wire contract
 * the daemon route maps to HTTP 503; do not rename without updating the route.
 */
export class CuratorUnconfirmedError extends Error {
  readonly code = 'CURATOR_UNCONFIRMED' as const;
  readonly contextGraphId: string;
  constructor(contextGraphId: string) {
    super(
      `SWM write to private context graph "${contextGraphId}" was not confirmed by its curator ` +
        `(the authoritative replica) and was NOT persisted locally. The curator is unreachable or did ` +
        `not acknowledge in time. Retry when connectivity to the curator is restored.`,
    );
    this.name = 'CuratorUnconfirmedError';
    this.contextGraphId = contextGraphId;
  }
}

/**
 * Thrown by a gated SWM write when the curator PERMANENTLY rejected it (the
 * `FANOUT_RESPONSE_REJECTED` 0x01 sentinel: not in the allowlist, bad
 * signature, or validation failure). Distinct from {@link CuratorUnconfirmedError}
 * — retrying the identical bytes will fail again. Maps to HTTP 409.
 */
export class CuratorRejectedError extends Error {
  readonly code = 'CURATOR_REJECTED' as const;
  readonly contextGraphId: string;
  constructor(contextGraphId: string) {
    super(
      `SWM write to private context graph "${contextGraphId}" was permanently rejected by its curator ` +
        `(allowlist / signature / validation failure). The write was NOT persisted locally. ` +
        `Retrying the same write will fail again.`,
    );
    this.name = 'CuratorRejectedError';
    this.contextGraphId = contextGraphId;
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
      `V10 VM publish from SWM is single-root only for this operation. ` +
        `Resolved ${rootEntities.length} root entities; select exactly one root or use a durable multi-publish flow.`,
    );
    this.name = 'MultiRootPublishNotAtomicError';
    this.contextGraphId = contextGraphId;
    this.rootEntities = [...rootEntities];
  }
}
