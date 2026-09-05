import {
  isChainRpcTransportError,
  type ChainRpcTransportCode,
} from '@origintrail-official/dkg-chain';
import { isBoundedOperationTimeoutError } from './bounded-operation.js';

export type ContextGraphAuthorityUnavailableReason =
  | 'chain-name-binding-unavailable'
  | 'local-chain-binding-unavailable'
  | 'local-existence-unavailable'
  | 'chain-access-policy-unavailable'
  | 'chain-access-policy-unknown'
  | 'chain-participant-authority-unsupported'
  | 'chain-participant-authority-unavailable'
  | 'chain-participant-authority-invalid';

export type ContextGraphAuthorityUnavailableCause = Readonly<{
  kind: 'chain-rpc-transport';
  code: ChainRpcTransportCode;
}>;

export interface ContextGraphAuthorityUnavailable<
  Reason extends ContextGraphAuthorityUnavailableReason = ContextGraphAuthorityUnavailableReason,
> {
  readonly kind: 'unavailable';
  readonly reason: Reason;
  readonly onChainId?: bigint;
  readonly detail?: string;
  /** Consumer-neutral, privacy-bounded reason for an unavailable chain read. */
  readonly unavailableCause?: ContextGraphAuthorityUnavailableCause;
}

/** Build every unavailable authority result through one bounded cause model. */
export function contextGraphAuthorityUnavailable<Reason extends ContextGraphAuthorityUnavailableReason>(
  reason: Reason,
  input: { onChainId?: bigint; error?: unknown; chainRead?: boolean } = {},
): ContextGraphAuthorityUnavailable<Reason> {
  const detail = input.error === undefined
    ? undefined
    : input.error instanceof Error ? input.error.message : String(input.error);
  const transportCode = isChainRpcTransportError(input.error)
    ? input.error.code
    : input.chainRead === true && isBoundedOperationTimeoutError(input.error)
      ? 'RPC_TIMEOUT'
      : undefined;
  const unavailableCause = transportCode === undefined
    ? undefined
    : { kind: 'chain-rpc-transport' as const, code: transportCode };
  return {
    kind: 'unavailable',
    reason,
    ...(input.onChainId !== undefined ? { onChainId: input.onChainId } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(unavailableCause !== undefined ? { unavailableCause } : {}),
  };
}

/** Canonical thrown form used when an unavailable result must abort mutation. */
export class ContextGraphAuthorityUnavailableError extends Error {
  readonly code?: ChainRpcTransportCode;

  constructor(contextGraphId: string, authority: ContextGraphAuthorityUnavailable) {
    super(
      `Registered context graph "${contextGraphId}" authority is unavailable (${authority.reason})`,
      authority.unavailableCause !== undefined
        ? { cause: authority.unavailableCause }
        : undefined,
    );
    this.name = 'ContextGraphAuthorityUnavailableError';
    this.code = authority.unavailableCause?.code;
  }
}
