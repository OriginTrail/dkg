/**
 * Shared error hierarchy for the DKG V9 stack.
 *
 * DKGError is the base class for all domain-specific errors. Subclasses
 * distinguish between user-facing errors (nice message, no stack) and
 * internal errors (full diagnostic info).
 */

/** Base class for all DKG domain errors. */
export class DKGError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DKGError';
  }
}

/**
 * Funded operational-wallet selection — cross-package error contract.
 *
 * Defined in this UI-safe shared package so every consumer references one
 * source: the chain adapter (which throws the error + builds the message), the
 * daemon route/lifecycle handlers, the publisher async-job classifier, and
 * node-ui. dkg-chain re-exports NO_FUNDED_PUBLISHER_WALLET_CODE for chain-side
 * imports.
 */
export const NO_FUNDED_PUBLISHER_WALLET_CODE = 'NO_FUNDED_PUBLISHER_WALLET';

/**
 * GH#1786 — the node cannot re-sign an `UpdateAuthorAttestation` for this author (no
 * custodial key on file, and the author is not the publisher EOA).
 *
 * Shared here for the same reason as the funded-wallet code above: it crosses packages. The
 * agent raises it, the daemon route maps it to a 409, and the publisher's async-job
 * classifier must recognise it as a PERMANENT author-capability failure. Without that last
 * consumer it falls through to the retryable `rpc_unavailable` default and the queue keeps
 * resetting a job that can never finalize — the forever-retry trap #1013/#1121 fixed for
 * unfundable publishes.
 */
export const PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE = 'PUBLISH_AUTHOR_NOT_CUSTODIAL';

/**
 * The rest of the publish-author-selection error protocol (GH#1778, GH#1786). Same reason as
 * the code above: the agent raises these, the daemon route turns each into a specific 409
 * body, and clients branch on the wire code. They were literals on both sides of that
 * boundary — a rename or typo in the agent would silently bypass the daemon mapper and fall
 * through to an opaque 500, with no compiler or test to catch it. The VALUES are the wire
 * contract and must not change; the names are what consumers should import.
 */
export const AMBIGUOUS_ASSERTION_AUTHOR_CODE = 'AMBIGUOUS_ASSERTION_AUTHOR';
export const ASSERTION_AUTHOR_NOT_RESIDENT_CODE = 'ASSERTION_AUTHOR_NOT_RESIDENT';
export const PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE = 'PUBLISH_AUTHOR_SELECTION_CONFLICT';

/** The literal prefix every InsufficientPublisherFundsError message starts with.
 *  The chain formatter builds the message from this; consumers that only have a
 *  (possibly re-wrapped, code-stripped) message string match on it via
 *  {@link messageIndicatesNoFundedPublisherWallet}. */
export const NO_FUNDED_PUBLISHER_WALLET_MESSAGE_PREFIX =
  'No operational wallet has enough funds';

const NO_FUNDED_PUBLISHER_WALLET_MARKER = new RegExp(
  NO_FUNDED_PUBLISHER_WALLET_MESSAGE_PREFIX,
  'i',
);

/** True iff a message string indicates a no-funded-wallet publish failure — the
 *  fallback used when the structured `.code` was lost to a re-wrap. */
export function messageIndicatesNoFundedPublisherWallet(message: unknown): boolean {
  return typeof message === 'string' && NO_FUNDED_PUBLISHER_WALLET_MARKER.test(message);
}

/** The literal fragment every non-custodial-author publish message contains. The agent
 *  builds its message from {@link formatPublishAuthorNotCustodialMessage}; consumers holding
 *  only a (possibly re-wrapped, code-stripped) message match on it via
 *  {@link messageIndicatesPublishAuthorNotCustodial}. Emitter and classifier share this
 *  constant so re-wording the message can never silently un-classify the failure. */
export const PUBLISH_AUTHOR_NOT_CUSTODIAL_MESSAGE_MARKER =
  'cannot re-sign UpdateAuthorAttestation';

const PUBLISH_AUTHOR_NOT_CUSTODIAL_MARKER = new RegExp(
  PUBLISH_AUTHOR_NOT_CUSTODIAL_MESSAGE_MARKER,
  'i',
);

/** The canonical CONDITION sentence for {@link PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE}: what is
 *  true, and why. Built here, beside the marker it must keep containing, rather than inline at
 *  the throw site — so a re-wording cannot un-classify the failure downstream.
 *
 *  Deliberately transport-neutral. Remediation ("call X instead") is presentation owned by the
 *  layer that has an endpoint to name; this package is shared with non-HTTP consumers and
 *  must not encode one API's route names. Throw sites append their own guidance. */
export function formatPublishAuthorNotCustodialMessage(authorAddress: string): string {
  return `${PUBLISH_AUTHOR_NOT_CUSTODIAL_MESSAGE_MARKER} for author ${authorAddress} — no `
    + `custodial key on file and it is not the publisher EOA.`;
}

/** True iff a message string indicates a non-custodial-author publish failure — the
 *  fallback used when the structured `.code` was lost to a re-wrap. */
export function messageIndicatesPublishAuthorNotCustodial(message: unknown): boolean {
  return typeof message === 'string' && PUBLISH_AUTHOR_NOT_CUSTODIAL_MARKER.test(message);
}

/**
 * An error caused by invalid user input or a pre-condition that the user
 * can fix. CLI handlers can show these messages directly without a stack trace.
 */
export class DKGUserError extends DKGError {
  constructor(message: string) {
    super(message);
    this.name = 'DKGUserError';
  }
}

/**
 * An internal/unexpected error. These should be logged with full context
 * and typically indicate a bug or infrastructure issue.
 */
export class DKGInternalError extends DKGError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'DKGInternalError';
  }
}

/** HTTP request body exceeded the size limit. */
export class PayloadTooLargeError extends DKGUserError {
  readonly code: string;
  readonly maxBytes?: number;

  constructor(maxBytes?: number, message?: string, code = 'PAYLOAD_TOO_LARGE') {
    super(
      message ??
      (maxBytes != null
        ? `Request body too large (>${maxBytes} bytes)`
        : 'Payload too large'),
    );
    this.name = 'PayloadTooLargeError';
    this.code = code;
    this.maxBytes = maxBytes;
  }
}

/** SWM gossip payload exceeded the network message size limit. */
export class SwmGossipPayloadTooLargeError extends PayloadTooLargeError {
  readonly actualBytes: number;
  readonly hint: string;
  readonly operation: 'share' | 'promote';

  constructor(args: {
    actualBytes: number;
    maxBytes: number;
    operation: 'share' | 'promote';
    message: string;
    hint: string;
  }) {
    super(args.maxBytes, args.message, 'SWM_GOSSIP_PAYLOAD_TOO_LARGE');
    this.name = 'SwmGossipPayloadTooLargeError';
    this.actualBytes = args.actualBytes;
    this.operation = args.operation;
    this.hint = args.hint;
  }
}

/**
 * Safely extract a human-readable error message from an unknown thrown value.
 * Prefer this over `catch (err: any) { err.message }` to maintain type safety.
 */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * Check whether an unknown value is an Error with a specific `code` property
 * (common in Node.js system errors like ENOENT, ECONNREFUSED, etc.).
 */
export function hasErrorCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}
